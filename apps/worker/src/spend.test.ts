import { afterEach, beforeEach, expect, test } from "vitest";
import { BACKGROUND_BLOCKER, QUOTA_SAVER_SETTING, type CostSignal } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { createBackgroundSpend, nonCoreAllowed } from "./spend";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
});
afterEach(() => store.close());

test("a paused background is written where the person's pages read it, and cleared once the quota reads again", async () => {
  let signal: CostSignal = { available: false, reason: "chatgpt authentication required" };
  const spendFor = createBackgroundSpend(store, async () => signal);
  expect((await spendFor(ws)).mode).toBe("manual_core_only");
  expect(JSON.parse(store.getSetting(ws, BACKGROUND_BLOCKER) ?? "{}")).toMatchObject({ code: "COST_SIGNAL_UNAVAILABLE" });
  signal = { available: true, limitReached: false, short: { usedPercent: 5, windowDurationMins: 300, resetsAt: null } };
  expect((await spendFor(ws)).mode).toBe("normal");
  expect(store.getSetting(ws, BACKGROUND_BLOCKER)).toBeFalsy();
});

test("节省额度: non-core work stops once it passes a fifth of the person's week, the person is told once that week, and off restores the old rules", async () => {
  const signal: CostSignal = { available: true, short: { usedPercent: 5 }, long: { usedPercent: 5 }, limitReached: false } as CostSignal;
  store.setSetting(ws, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago" }));
  // Wednesday 10:00 in Chicago; the week began Monday 2026-10-19 05:00 UTC.
  const now = new Date("2026-10-21T15:00:00Z");
  const row = (at: string, purpose: string, outputTokens: number) => store.saveModelUsage({ workspaceId: ws, skill: "crossline:crossline-skill-scout", tier: "", model: "gpt-5.6-terra",
    effort: "", spendMode: "normal", threadId: "", ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens,
    reasoningTokens: 0, totalTokens: outputTokens, durationMs: 1, at, purpose });
  row("2026-10-20T12:00:00.000Z", "", 800);
  row("2026-10-20T13:00:00.000Z", "non_core", 200);
  // Last week's non-core work does not count against this one.
  row("2026-10-18T12:00:00.000Z", "non_core", 100_000);
  const spendFor = createBackgroundSpend(store, async () => signal, () => now);
  let spend = await spendFor(ws);
  expect(spend.saver).toEqual({ on: true, night: false, overShare: false, week: "2026-10-19" });
  expect(nonCoreAllowed(store, ws, spend, "discretionary", now)).toBe(true);
  row("2026-10-21T14:00:00.000Z", "non_core", 10);
  spend = await spendFor(ws);
  expect(spend.saver?.overShare).toBe(true);
  expect(nonCoreAllowed(store, ws, spend, "discretionary", now)).toBe(false);
  expect(nonCoreAllowed(store, ws, spend, "discretionary", now)).toBe(false);
  // Line-skill compiling (non-core under the core quota rule) waits too; the person was told once, with no figures.
  expect(nonCoreAllowed(store, ws, spend, "core", now)).toBe(false);
  const told = store.listConversationMessages(ws, store.conversationFor(ws, "2026-10-21").id).filter((message) => message.role === "nudge");
  expect(told).toHaveLength(1);
  expect(JSON.stringify(told[0]!.payload)).not.toMatch(/\d+ ?%|两成/);
  // Turned off: the kind's own rule alone decides.
  store.setSetting(ws, QUOTA_SAVER_SETTING, "off");
  spend = await spendFor(ws);
  expect(spend.saver?.on).toBe(false);
  expect(nonCoreAllowed(store, ws, spend, "discretionary", now)).toBe(true);
});

test("a quota reader that throws counts as unreadable, not as a crash of the tick", async () => {
  const spendFor = createBackgroundSpend(store, async () => { throw new Error("supervisor down"); });
  expect((await spendFor(ws)).blocker?.code).toBe("COST_SIGNAL_UNAVAILABLE");
});

test("the reading carries how recently the person did something themselves", async () => {
  const signal: CostSignal = { available: true, short: { usedPercent: 5 }, long: { usedPercent: 5 }, limitReached: false } as CostSignal;
  const at = (iso: string) => () => new Date(iso);
  store.appendConversationMessage({ id: "m1", workspaceId: ws, conversationId: store.conversationFor(ws, "2026-10-01").id, role: "person", text: "周二前交作业 3",
    payload: {}, createdAt: "2026-10-01T12:00:00.000Z" });
  expect((await createBackgroundSpend(store, async () => signal, at("2026-10-02T12:00:00.000Z"))(ws)).engagement).toBe("active");
  expect((await createBackgroundSpend(store, async () => signal, at("2026-10-05T12:00:00.000Z"))(ws)).engagement).toBe("cooling");
  expect((await createBackgroundSpend(store, async () => signal, at("2026-10-13T12:00:00.000Z"))(ws)).engagement).toBe("dormant");
});
