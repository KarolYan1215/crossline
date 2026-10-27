import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, type StoredModelUsage } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const usage = (over: Partial<StoredModelUsage> = {}): StoredModelUsage => ({
  workspaceId: "w1", skill: "crossline:crossline-onboarding", tier: "top", model: "gpt-5.6-sol", effort: "medium", spendMode: "normal", threadId: "t",
  ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 50, totalTokens: 1200,
  durationMs: 60_000, at: "2026-10-02T12:00:00.000Z", ...over
});

test("runs are summed per skill and model, biggest spender first, inside one workspace and one window", () => {
  store.saveModelUsage(usage());
  store.saveModelUsage(usage({ totalTokens: 800, inputTokens: 700, outputTokens: 100, durationMs: 30_000, repairs: 2 }));
  store.saveModelUsage(usage({ skill: "crossline:crossline-plan-explainer", model: "gpt-5.6-luna", totalTokens: 90, ok: false, durationMs: 4_000 }));
  store.saveModelUsage(usage({ workspaceId: "w2", totalTokens: 99_999 }));
  store.saveModelUsage(usage({ at: "2026-09-01T00:00:00.000Z", totalTokens: 99_999 }));
  const summary = store.summarizeModelUsage("w1", "2026-09-25T00:00:00.000Z");
  expect(summary.map((row) => row.skill)).toEqual(["crossline:crossline-onboarding", "crossline:crossline-plan-explainer"]);
  expect(summary[0]).toMatchObject({ runs: 2, failed: 0, repairs: 2, totalTokens: 2000, inputTokens: 1700, outputTokens: 300, averageSeconds: 45 });
  expect(summary[1]).toMatchObject({ runs: 1, failed: 1, totalTokens: 90 });
});

test("a run's purpose is kept (migration 21), and the week's tokens are summed per purpose and model from a given instant", () => {
  store.saveModelUsage(usage());
  store.saveModelUsage(usage({ purpose: "non_core", skill: "crossline:crossline-validation-reviewer", inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 }));
  store.saveModelUsage(usage({ purpose: "non_core", inputTokens: 500, cachedInputTokens: 300, outputTokens: 10 }));
  store.saveModelUsage(usage({ purpose: "non_core", at: "2026-09-01T00:00:00.000Z" }));
  expect(store.schemaVersion()).toBeGreaterThanOrEqual(21);
  const rows = store.modelUsageByPurpose("w1", "2026-10-01T00:00:00.000Z").sort((a, b) => a.purpose.localeCompare(b.purpose));
  expect(rows).toEqual([
    { purpose: "", model: "gpt-5.6-sol", runs: 1, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 },
    { purpose: "non_core", model: "gpt-5.6-sol", runs: 2, inputTokens: 1000, cachedInputTokens: 400, outputTokens: 60 }]);
});

test("usage is part of the export, so a backup carries what the work cost", () => {
  store.saveModelUsage(usage({ workspaceId: "w1" }));
  const snapshot = store.exportSnapshot("w1") as { tables?: Record<string, unknown[]> };
  expect(Object.keys(snapshot.tables ?? {})).toContain("model_usage");
});
