import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { personalEfficiency, toZonedInstant } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.useRealTimers(); });
const ws = TEST_CTX.workspaceId;
const ZONE = "America/Chicago";
const NOW = new Date("2026-10-20T15:00:00.000Z");
const dayBack = (back: number) => new Date(Date.parse("2026-10-20T12:00:00Z") - back * 86_400_000).toISOString().slice(0, 10);
const MATCHING = { slot: "high", need: "high", efficiency: 1 } as const;
const SHORT = { slot: "medium", need: "high", efficiency: 0.8 } as const;

/**
 * Twenty-eight past days, one 10:00–11:00 block a day: matching slots on even days, done at the plan's pace; slots one level short on
 * odd days, done at the assumed pace when confirmed — but every other one went by under way with no timer and no answer.
 */
function seed(withMissed: boolean) {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  vi.useFakeTimers();
  for (let back = 28; back >= 1; back -= 1) {
    const day = dayBack(back), energy = back % 2 ? SHORT : MATCHING, id = `scheduled:hw:${day}`;
    if (back % 4 === 3) {
      if (withMissed) store.setSetting(ws, `nudge.blocks:${day}`, JSON.stringify({ [id]: { id, orderId: "hw", stepId: "", title: "作业", step: "", day,
        start: "10:00", end: "11:00", endedTimerAt: "", energy, began: true } }));
      continue;
    }
    vi.setSystemTime(new Date(toZonedInstant(day, "11:00", ZONE)));
    store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: `block-confirmed:${day}`, type: "block.confirmed", entityId: day,
      payload: { blockId: id, workOrderId: "hw", day, outcome: "as_planned", blockMinutes: 60, minutes: 60, energy } });
  }
  vi.setSystemTime(NOW);
  return store;
}

test("blocks that went by unused count as producing nothing, and lower the factor once the backtest favours counting them", () => {
  // Confirmed blocks alone go exactly as assumed: no factors of the person's own.
  seed(false);
  expect(personalEfficiency(TEST_CTX, NOW)).toBeUndefined();
  globalThis.crosslineStore!.close();
  // With every other short block gone by unused, an hour one level short yields far less than the assumed 0.8.
  const store = seed(true);
  expect(personalEfficiency(TEST_CTX, NOW)![0]).toBeLessThan(0.7);
  // A block the person ran the timer for that day is not a miss.
  for (let back = 28; back >= 1; back -= 1) if (back % 4 === 3) {
    const day = dayBack(back);
    store.recordConfirmedSession(ws, "hw", TEST_CTX.principalId, { startedAt: toZonedInstant(day, "10:00", ZONE), endedAt: toZonedInstant(day, "11:00", ZONE),
      minutes: 60, source: "one_tap", key: `session:${day}` });
  }
  expect(personalEfficiency(TEST_CTX, NOW)).toBeUndefined();
});
