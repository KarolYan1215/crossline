import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

test("preferences are kept per workspace, a repeated signal replaces its entry, deletion takes one out of every model context", () => {
  const store = new CrosslineStore(":memory:");
  const base = { workspaceId: "w", source: "estimate" as const, scope: "research", weight: 0.3 };
  store.addPreference({ ...base, text: "任务「A」估时由本人改为 60 分钟", refId: "a:" });
  store.addPreference({ ...base, text: "任务「A」估时由本人改为 90 分钟", refId: "a:" });
  const correction = store.addPreference({ workspaceId: "w", source: "correction", scope: "all", weight: 1, refId: "", text: "作业先看讲义再做题" });
  store.addPreference({ workspaceId: "other", source: "correction", scope: "all", weight: 1, refId: "", text: "别的工作区" });
  expect(store.listPreferences("w").map((entry) => entry.text)).toEqual(expect.arrayContaining(["任务「A」估时由本人改为 90 分钟", "作业先看讲义再做题"]));
  expect(store.listPreferences("w")).toHaveLength(2);
  // The weightiest first; another line's entries are not given.
  expect(store.preferenceLines("w", ["research"])).toEqual(["作业先看讲义再做题", "任务「A」估时由本人改为 90 分钟"]);
  expect(store.preferenceLines("w", ["media"])).toEqual(["作业先看讲义再做题"]);
  expect(store.deletePreference("w", correction.id)).toBe(true);
  expect(store.preferenceLines("w", ["research"])).toEqual(["任务「A」估时由本人改为 90 分钟"]);
  expect(store.listPreferences("w", { includeDeleted: true })).toHaveLength(2);
  store.close();
});
