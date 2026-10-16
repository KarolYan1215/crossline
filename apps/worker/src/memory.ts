import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { MemoryReading } from "@crossline/codex";

/**
 * This process's memory as its container sees it (cgroup v2, else v1): what is in use without the page cache the kernel can drop
 * (`inactive_file`, as `docker stats` counts it), against the container's ceiling, or the machine's memory when there is none. On a
 * machine without cgroups (the owner's Windows PC) there is no reading, and nothing waits on memory.
 */
export function containerMemory(read: (file: string) => string | undefined = readText, machine: number = totalmem()): MemoryReading | undefined {
  const v2 = read("/sys/fs/cgroup/memory.current");
  if (v2 !== undefined) {
    const current = Number(v2);
    const max = read("/sys/fs/cgroup/memory.max");
    const limit = max === undefined || max === "max" ? machine : Number(max);
    return reading(current - statValue(read("/sys/fs/cgroup/memory.stat"), "inactive_file"), limit, machine);
  }
  const v1 = read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1 === undefined) return undefined;
  const limit = Number(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  return reading(Number(v1) - statValue(read("/sys/fs/cgroup/memory/memory.stat"), "total_inactive_file"), limit, machine);
}

/** The highest this container has reached since it started (cgroup v2 only), for the health check. */
export function containerPeak(read: (file: string) => string | undefined = readText): number | undefined {
  const peak = Number(read("/sys/fs/cgroup/memory.peak"));
  return Number.isFinite(peak) && peak > 0 ? peak : undefined;
}

function reading(used: number, limit: number, machine: number): MemoryReading | undefined {
  if (!Number.isFinite(used) || used < 0) return undefined;
  // A v1 "no limit" is a huge number; the machine is the real ceiling then.
  return { used, limit: Number.isFinite(limit) && limit > 0 && limit < machine ? limit : machine };
}

function statValue(stat: string | undefined, key: string): number {
  const match = stat?.match(new RegExp(`^${key} (\\d+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

function readText(file: string): string | undefined {
  try { return readFileSync(file, "utf8").trim(); } catch { return undefined; }
}
