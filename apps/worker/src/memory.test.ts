import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserBytes, containerMemory, containerPeak, createCollectMemory, heldMemory } from "./memory";

const files = (map: Record<string, string>) => (file: string) => map[file];

test("cgroup v2: what the processes hold, file cache (active or not) left out, against the container's ceiling", () => {
  expect(containerMemory(files({ "/sys/fs/cgroup/memory.current": "800", "/sys/fs/cgroup/memory.max": "1000",
    "/sys/fs/cgroup/memory.stat": "anon 600\nshmem 10\ninactive_file 150\nactive_file 40" }), 4000)).toEqual({ used: 610, limit: 1000 });
  // A kernel without those fields: in use less the inactive cache.
  expect(containerMemory(files({ "/sys/fs/cgroup/memory.current": "800", "/sys/fs/cgroup/memory.max": "1000",
    "/sys/fs/cgroup/memory.stat": "inactive_file 150\nactive_file 50" }), 4000)).toEqual({ used: 650, limit: 1000 });
  // No ceiling: the machine's memory is the ceiling.
  expect(containerMemory(files({ "/sys/fs/cgroup/memory.current": "800", "/sys/fs/cgroup/memory.max": "max" }), 4000)).toEqual({ used: 800, limit: 4000 });
  expect(containerPeak(files({ "/sys/fs/cgroup/memory.peak": "912" }))).toBe(912);
});

test("cgroup v1, and no cgroups at all (a Windows PC): no reading, so nothing waits on memory", () => {
  expect(containerMemory(files({ "/sys/fs/cgroup/memory/memory.usage_in_bytes": "700", "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    "/sys/fs/cgroup/memory/memory.stat": "total_inactive_file 100" }), 2000)).toEqual({ used: 600, limit: 2000 });
  expect(containerMemory(files({ "/sys/fs/cgroup/memory/memory.usage_in_bytes": "700", "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1000",
    "/sys/fs/cgroup/memory/memory.stat": "total_rss 400\ntotal_shmem 5\ntotal_inactive_file 100" }), 2000)).toEqual({ used: 405, limit: 1000 });
  expect(containerMemory(files({}), 2000)).toBeUndefined();
});

const MB = 1_048_576;

test("the browser's processes are counted by name from /proc: anon and shmem, nothing else", () => {
  const proc = mkdtempSync(path.join(tmpdir(), "proc-"));
  try {
    const add = (pid: number, comm: string, anonKb: number, shmemKb: number) => {
      mkdirSync(path.join(proc, String(pid)));
      writeFileSync(path.join(proc, String(pid), "comm"), `${comm}
`);
      writeFileSync(path.join(proc, String(pid), "status"), `Name:	${comm}
RssAnon:	  ${anonKb} kB
RssFile:	  9999 kB
RssShmem:	  ${shmemKb} kB
`);
    };
    add(10, "chrome", 1000, 24);
    add(11, "chrome", 2000, 0);
    add(12, "node", 50_000, 0);
    mkdirSync(path.join(proc, "self"));
    expect(browserBytes(proc)).toBe((1000 + 24 + 2000) * 1024);
  } finally { rmSync(proc, { recursive: true, force: true }); }
  expect(browserBytes(path.join(tmpdir(), "no-such-proc-dir"))).toBe(0);
});

test("the collection waits for room for its browser, holds it while the page grows into it, and stops itself at the line", async () => {
  let used = 900 * MB;
  let chrome = 0;
  let clock = 0;
  let reclaimed = 0;
  const memory = createCollectMemory({ probe: () => ({ used, limit: 1350 * MB }), browser: () => chrome, reclaim: () => { reclaimed += 1; },
    sleep: async (ms) => { clock += ms; if (clock >= 10_000) used = 400 * MB; }, now: () => clock, waitMs: 60_000 });
  // 900 + 700 is past 90% of 1350 (1215): it frees idle runtimes and waits; once memory falls it holds the room.
  expect(await memory.admit()).toBe(true);
  expect(reclaimed).toBeGreaterThan(0);
  expect(heldMemory()).toBe(700 * MB);
  // As the page grows the promise shrinks by what it holds.
  chrome = 300 * MB; used = 700 * MB;
  expect(heldMemory()).toBe(400 * MB);
  expect(memory.over()).toBe(false);
  // A download may take half the room under the line, never more than asked.
  expect(memory.mediaBytes(500 * MB)).toBe(Math.floor((1215 * MB - 700 * MB) / 2));
  expect(memory.mediaBytes(10 * MB)).toBe(10 * MB);
  used = 1220 * MB;
  expect(memory.over()).toBe(true);
  expect(memory.mediaBytes(500 * MB)).toBe(0);
  memory.release();
  expect(heldMemory()).toBe(0);
});

test("no room within the wait: nothing is held and the browser is not opened; no ceiling to read (a PC): nothing waits or stops", async () => {
  let clock = 0;
  const full = createCollectMemory({ probe: () => ({ used: 1000 * MB, limit: 1350 * MB }), browser: () => 0, sleep: async (ms) => { clock += ms; }, now: () => clock, waitMs: 30_000 });
  expect(await full.admit()).toBe(false);
  expect(heldMemory()).toBe(0);
  const pc = createCollectMemory({ probe: () => undefined, browser: () => 0 });
  expect(await pc.admit()).toBe(true);
  expect(pc.over()).toBe(false);
  expect(pc.mediaBytes(500 * MB)).toBe(500 * MB);
  pc.release();
  expect(heldMemory()).toBe(0);
});
