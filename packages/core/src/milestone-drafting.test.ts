import { expect, test } from "vitest";
import { draftingProgress, readMilestoneDrafting, type MilestoneDrafting } from "./milestone-drafting";

const NOW = new Date("2026-10-17T10:20:00Z");
const run: MilestoneDrafting = { startedAt: "2026-10-17T10:00:00Z", lines: ["startup", "investment", "media", "product"], done: ["startup"],
  skipped: [], thin: [] };

test("while a run designs line by line, the lines it has not reached are still being designed (W-27)", () => {
  expect(draftingProgress(run, new Set(["startup"]), NOW)).toEqual({ pending: ["investment", "media", "product"], missing: {} });
  // A run that never finished within the hour was lost to a restart: nothing is said to be designing.
  expect(draftingProgress(run, new Set(["startup"]), new Date("2026-10-17T11:30:00Z")).pending).toEqual([]);
});

test("a finished run says why a line got no drafts, until that line has some (W-26)", () => {
  const finished: MilestoneDrafting = { ...run, done: ["startup", "investment", "media"], finishedAt: "2026-10-17T10:15:00Z",
    skipped: [{ lineId: "product", why: "这次没有设计出来：缺少项目截止。" }], thin: ["health"] };
  const progress = draftingProgress(finished, new Set(["startup", "investment", "media"]), NOW);
  expect(progress.pending).toEqual([]);
  expect(progress.missing.product).toBe("这次没有设计出来：缺少项目截止。");
  expect(progress.missing.health).toContain("说得太少");
  expect(draftingProgress(finished, new Set(["startup", "investment", "media", "product", "health"]), NOW).missing).toEqual({});
  expect(readMilestoneDrafting(JSON.stringify(finished))).toEqual(finished);
  expect(readMilestoneDrafting("{not json")).toBeUndefined();
});
