import { afterEach, beforeEach, expect, test } from "vitest";
import { BACKGROUND_BLOCKER, type CostSignal } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { createBackgroundSpend } from "./spend";

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

test("a quota reader that throws counts as unreadable, not as a crash of the tick", async () => {
  const spendFor = createBackgroundSpend(store, async () => { throw new Error("supervisor down"); });
  expect((await spendFor(ws)).blocker?.code).toBe("COST_SIGNAL_UNAVAILABLE");
});
