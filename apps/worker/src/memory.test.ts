import { expect, test } from "vitest";
import { containerMemory, containerPeak } from "./memory";

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
