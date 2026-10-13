import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { backgroundOverview, setBackgroundPaused } from "./background";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;

test("each kind's last run and week come from the model usage record; pausing one is kept, the assistant's on its own setting", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  const usage = (skill: string, at: string, totalTokens: number, ok = true) => store.saveModelUsage({ workspaceId: ws, skill, tier: "mid", model: "m", effort: "high",
    spendMode: "normal", threadId: "t", ok, errorCode: ok ? "" : "SKILL_STALLED", repairs: 0, turns: 1, inputTokens: totalTokens, cachedInputTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens, durationMs: 1000, at });
  usage("crossline:crossline-material-researcher", "2026-10-12T19:00:00.000Z", 400_000);
  usage("crossline:crossline-material-writer", "2026-10-12T19:07:00.000Z", 200_000, false);
  usage("crossline:crossline-step-planner", "2026-10-11T08:00:00.000Z", 80_000);
  const view = backgroundOverview(TEST_CTX, now);
  expect(view.kinds.find((item) => item.kind === "tutorials")).toMatchObject({ lastRunAt: "2026-10-12T19:07:00.000Z", lastOk: false, weekRuns: 2, weekTokens: 600_000, paused: false });
  expect(view.kinds.find((item) => item.kind === "planning")).toMatchObject({ weekRuns: 1, weekTokens: 80_000 });
  expect(view.kinds.find((item) => item.kind === "research")).toMatchObject({ lastRunAt: null, weekRuns: 0 });
  expect(setBackgroundPaused(TEST_CTX, "tutorials", true)).toEqual({ ok: true });
  expect(setBackgroundPaused(TEST_CTX, "assistant", true)).toEqual({ ok: true });
  expect(store.getSetting(ws, "background.paused")).toBe(JSON.stringify(["tutorials"]));
  expect(store.getSetting(ws, "agent.paused")).toBe("1");
  expect(backgroundOverview(TEST_CTX, now).kinds.filter((item) => item.paused).map((item) => item.kind)).toEqual(["tutorials", "assistant"]);
  expect(setBackgroundPaused(TEST_CTX, "tutorials", false)).toEqual({ ok: true });
  expect(setBackgroundPaused(TEST_CTX, "nope" as never, true)).toEqual({ ok: false, code: "BACKGROUND_KIND_UNKNOWN" });
});
