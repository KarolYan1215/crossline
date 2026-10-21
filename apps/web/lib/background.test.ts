import { afterEach, expect, test, vi } from "vitest";
import { CHATGPT_EXHAUSTED_SETTING } from "@crossline/core";
import { CrosslineStore, SPONSOR_SETTING } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { backgroundOverview, setBackgroundPaused } from "./background";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;

test("each kind's last run and week come from the model usage record; pausing one is kept, the assistant's on its own setting", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const now = new Date("2026-10-13T12:00:00.000Z");
  const usage = (skill: string, at: string, totalTokens: number, ok = true) => store.saveModelUsage({ workspaceId: ws, skill, tier: "mid", model: "m", effort: "high",
    spendMode: "normal", threadId: "t", ok, errorCode: ok ? "" : "SKILL_STALLED", repairs: 0, turns: 1, inputTokens: totalTokens, cachedInputTokens: Math.round(totalTokens / 4),
    outputTokens: 0, reasoningTokens: 0, totalTokens, durationMs: 1000, at });
  usage("crossline:crossline-material-researcher", "2026-10-12T19:00:00.000Z", 400_000);
  usage("crossline:crossline-material-writer", "2026-10-12T19:07:00.000Z", 200_000, false);
  usage("crossline:crossline-step-planner", "2026-10-11T08:00:00.000Z", 80_000);
  const view = backgroundOverview(TEST_CTX, now);
  expect(view.kinds.find((item) => item.kind === "tutorials")).toMatchObject({ lastRunAt: "2026-10-12T19:07:00.000Z", lastOk: false, weekRuns: 2, weekTokens: 600_000, weekCacheShare: 0.25, paused: false });
  expect(view.kinds.find((item) => item.kind === "planning")).toMatchObject({ weekRuns: 1, weekTokens: 80_000 });
  expect(view.kinds.find((item) => item.kind === "research")).toMatchObject({ lastRunAt: null, weekRuns: 0, weekCacheShare: null });
  expect(setBackgroundPaused(TEST_CTX, "tutorials", true)).toEqual({ ok: true });
  expect(setBackgroundPaused(TEST_CTX, "assistant", true)).toEqual({ ok: true });
  expect(store.getSetting(ws, "background.paused")).toBe(JSON.stringify(["tutorials"]));
  expect(store.getSetting(ws, "agent.paused")).toBe("1");
  expect(backgroundOverview(TEST_CTX, now).kinds.filter((item) => item.paused).map((item) => item.kind)).toEqual(["tutorials", "assistant"]);
  expect(setBackgroundPaused(TEST_CTX, "tutorials", false)).toEqual({ ok: true });
  expect(setBackgroundPaused(TEST_CTX, "nope" as never, true)).toEqual({ ok: false, code: "BACKGROUND_KIND_UNKNOWN" });
});

test("ChatGPT spent and the developer's model standing in is said with when ChatGPT comes back; a pause, or no sponsorship, says nothing of it", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const now = new Date("2026-10-21T07:00:00.000Z");
  store.setSetting(ws, CHATGPT_EXHAUSTED_SETTING, JSON.stringify({ at: "2026-10-21T04:00:00.000Z", source: "quota", until: "2026-10-21T07:57:42.000Z" }));
  expect(backgroundOverview(TEST_CTX, now).quotaFallback).toBeUndefined();
  store.setSetting(ws, SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: "2026-10-21T00:00:00.000Z" }));
  expect(backgroundOverview(TEST_CTX, now).quotaFallback).toMatchObject({ message: expect.stringContaining("已改用开发者提供的模型继续"), resetsAt: "2026-10-21T07:57:42.000Z" });
  // Past the reset it is gone; with background work paused (the developer's month spent too) the pause is what is said.
  expect(backgroundOverview(TEST_CTX, new Date("2026-10-21T08:00:00.000Z")).quotaFallback).toBeUndefined();
  store.setSetting(ws, "background.blocker", JSON.stringify({ code: "RATE_LIMIT_REACHED", message: "模型额度已用尽", at: now.toISOString() }));
  expect(backgroundOverview(TEST_CTX, now)).toMatchObject({ quotaPause: { message: "模型额度已用尽" } });
  expect(backgroundOverview(TEST_CTX, now).quotaFallback).toBeUndefined();
});
