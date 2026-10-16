import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { MemoryReading } from "@crossline/codex";

/**
 * This process's memory as its container sees it (cgroup v2, else v1): what the processes hold (`anon` + `shmem`), against the
 * container's ceiling, or the machine's memory when there is none. File cache is left out, active or not: the kernel drops it before it
 * kills anything, and counting the ledger's cached pages (2026-10-16, about 100 MB) read as 80% full and kept even a person's own
 * input-box turn waiting while the processes held half. Without those fields it falls back to in use less `inactive_file`, as
 * `docker stats` counts it. On a machine without cgroups (the owner's Windows PC) there is no reading, and nothing waits on memory.
 */
export function containerMemory(read: (file: string) => string | undefined = readText, machine: number = totalmem()): MemoryReading | undefined {
  const v2 = read("/sys/fs/cgroup/memory.current");
  if (v2 !== undefined) {
    const current = Number(v2);
    const max = read("/sys/fs/cgroup/memory.max");
    const limit = max === undefined || max === "max" ? machine : Number(max);
    const stat = read("/sys/fs/cgroup/memory.stat");
    const held = statField(stat, "anon");
    return reading(held !== undefined ? held + (statField(stat, "shmem") ?? 0) : current - statValue(stat, "inactive_file"), limit, machine);
  }
  const v1 = read("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1 === undefined) return undefined;
  const limit = Number(read("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  const stat = read("/sys/fs/cgroup/memory/memory.stat");
  const held = statField(stat, "total_rss");
  return reading(held !== undefined ? held + (statField(stat, "total_shmem") ?? 0) : Number(v1) - statValue(stat, "total_inactive_file"), limit, machine);
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

function statField(stat: string | undefined, key: string): number | undefined {
  const match = stat?.match(new RegExp(`^${key} (\\d+)$`, "m"));
  return match ? Number(match[1]) : undefined;
}
const statValue = (stat: string | undefined, key: string): number => statField(stat, key) ?? 0;

function readText(file: string): string | undefined {
  try { return readFileSync(file, "utf8").trim(); } catch { return undefined; }
}
