import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Room promised to a heavy job outside the model gate (the collection's browser) for as long as it runs. The gate counts what is promised
 * and not yet taken (`bytes` less what the job's processes hold now) as in use for background work, so runtimes and runs started meanwhile
 * do not eat the room the page will grow into.
 */
const holds = new Set<{ bytes: number; held: () => number }>();
export function holdMemory(bytes: number, held: () => number): () => void {
  const hold = { bytes, held };
  holds.add(hold);
  return () => { holds.delete(hold); };
}
export function heldMemory(): number {
  let total = 0;
  for (const hold of holds) {
    let taken = 0;
    try { taken = hold.held(); } catch { /* unreadable: count the whole promise */ }
    total += Math.max(0, hold.bytes - taken);
  }
  return total;
}

/** What the browser's processes in this container hold (anon + shmem of every chrome process, Linux); 0 where there is no /proc. */
export function browserBytes(proc = "/proc", read: (file: string) => string | undefined = readText): number {
  let pids: string[];
  try { pids = readdirSync(proc).filter((name) => /^\d+$/.test(name)); } catch { return 0; }
  let total = 0;
  for (const pid of pids) {
    if (!/^(chrome|chromium|headless_shell)/.test(read(`${proc}/${pid}/comm`) ?? "")) continue;
    const status = read(`${proc}/${pid}/status`) ?? "";
    total += (kb(status, "RssAnon") + kb(status, "RssShmem")) * 1024;
  }
  return total;
}
const kb = (status: string, key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(status)?.[1] ?? 0);

/** What the collection's browser is promised, and the line past which it stops where it is (2026-10-23). */
export const BROWSER_RESERVE_BYTES = 700 * 1_048_576;
export const BROWSER_STOP_AT = 0.9;
/** How long a collection waits for that room (idle runtimes freed, runs finishing) before it gives up for now. */
export const BROWSER_ADMIT_WAIT_MS = 10 * 60_000;

export type CollectMemory = {
  /** Waits for room for the browser and holds it; false when there is still none (nothing is opened then). */
  admit: () => Promise<boolean>;
  release: () => void;
  /** Past the stop line: the run stops where it is and keeps what it has. */
  over: () => boolean;
  /** The largest file that may be downloaded into memory now (a video is held whole while it is saved). */
  mediaBytes: (wanted: number) => number;
  /** For the person: in use and the ceiling, in MB. */
  describe: () => string;
};

/**
 * The collection's share of the worker's memory. On the hosted beta the browser shares the worker container's ceiling with every model
 * runtime; the kernel killed its page there twice (2026-10-23) instead of anything stopping it. Here it waits for room before opening,
 * the gate keeps that room free, and the run stops itself at `BROWSER_STOP_AT` of the ceiling, well before the kernel would. Where memory
 * has no ceiling to read (the person's own computer) nothing waits and nothing stops.
 */
export function createCollectMemory(options: {
  probe?: () => MemoryReading | undefined; browser?: () => number; reclaim?: () => void;
  sleep?: (ms: number) => Promise<void>; now?: () => number; waitMs?: number; reserve?: number;
} = {}): CollectMemory {
  const probe = options.probe ?? (() => containerMemory());
  const browser = options.browser ?? (() => browserBytes());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const reserve = options.reserve ?? BROWSER_RESERVE_BYTES;
  let release: (() => void) | undefined;
  const stopLine = (reading: MemoryReading) => reading.limit * BROWSER_STOP_AT;
  return {
    admit: async () => {
      const started = now();
      for (;;) {
        const reading = probe();
        // Other promises count too: two heavy jobs must not be promised the same room.
        if (!reading || reading.used + heldMemory() + reserve <= stopLine(reading)) break;
        if (now() - started >= (options.waitMs ?? BROWSER_ADMIT_WAIT_MS)) return false;
        try { options.reclaim?.(); } catch { /* best effort */ }
        await sleep(5_000);
      }
      release?.();
      release = holdMemory(reserve, browser);
      return true;
    },
    release: () => { release?.(); release = undefined; },
    over: () => { const reading = probe(); return Boolean(reading && reading.used >= stopLine(reading)); },
    mediaBytes: (wanted) => {
      const reading = probe();
      if (!reading) return wanted;
      // Half the room left under the stop line: the bytes are held once by the browser's side and once here while they are written.
      return Math.max(0, Math.min(wanted, Math.floor((stopLine(reading) - reading.used) / 2)));
    },
    describe: () => { const reading = probe(); return reading ? `${Math.round(reading.used / 1_048_576)} / ${Math.round(reading.limit / 1_048_576)} MB` : ""; }
  };
}
