import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { ACTIVITY_DETAIL_CONSENT, toZonedInstant } from "./crossline";
import { blockWorkMinutes, configureMeasuredCapacity, dayCapacityOf, measuredView } from "./measured-capacity";
import { TEST_CTX } from "./test-support";

/** Measured work time gathered from the ledger (docs/plans/closed-loop-1030.md §1): the four signals, joined in time, by local day. */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); configureMeasuredCapacity(false); });

const ws = TEST_CTX.workspaceId;
const ZONE = "America/Chicago";
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const iso = (day: string, clock: string) => toZonedInstant(day, clock, ZONE);

function seed() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", iso("2026-11-10", "09:00"));
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent: "作业", state: "active", riskTier: "routine", estimate, payload: {} });
  return store;
}

test("timer, screen in work categories and Codex time are joined; a confirmation alone is a day of zero; idle and leisure do not count", () => {
  const store = seed();
  // Monday 11-02: a timed hour 09:00–10:00, and writing 09:30–11:00 on the screen; an hour of video does not count.
  store.recordConfirmedSession(ws, "hw", TEST_CTX.principalId, { startedAt: iso("2026-11-02", "09:00"), endedAt: iso("2026-11-02", "10:00"), minutes: 60, source: "one_tap", key: "s1" });
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "granted");
  store.replaceDeviceActivitySegments(ws, iso("2026-10-01", "00:00"), [
    { start: iso("2026-11-02", "09:30"), end: iso("2026-11-02", "11:00"), app: "a1", category: "writing", idle: false },
    { start: iso("2026-11-02", "20:00"), end: iso("2026-11-02", "21:00"), app: "a2", category: "leisure", idle: false },
    { start: iso("2026-11-02", "21:00"), end: iso("2026-11-02", "22:00"), app: "a1", category: "writing", idle: true }
  ]);
  // Tuesday 11-03: Codex 14:00–14:30.
  store.setSetting(ws, AGENT_HISTORY_CONSENT, "on");
  store.setSetting(ws, AGENT_HISTORY_SUMMARY, JSON.stringify({ updatedAt: iso("2026-11-09", "00:00"), days: 30, timeZone: ZONE, totalMinutes: 30, folders: [], byHour: [], byWeekday: [], daily: [],
    spans: [{ start: iso("2026-11-03", "14:00"), end: iso("2026-11-03", "14:30") }] }));
  // Wednesday 11-04: a block answered 没做, nothing else.
  store.appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: ws, idempotencyKey: "c1", type: "block.confirmed", entityId: "m1",
    payload: { blockId: "b", workOrderId: "hw", day: "2026-11-04", outcome: "not_done", blockMinutes: 60 } });

  const view = measuredView(TEST_CTX);
  const byDay = new Map(view.days.map((day) => [day.day, day]));
  expect(view.days).toHaveLength(28);
  expect(view.days.at(-1)!.day).toBe("2026-11-09");
  expect(byDay.get("2026-11-02")).toMatchObject({ minutes: 120, missing: false, bySource: { timer: 60, screen: 90, agent: 0 } });
  expect(byDay.get("2026-11-03")).toMatchObject({ minutes: 30, missing: false });
  expect(byDay.get("2026-11-04")).toMatchObject({ minutes: 0, missing: false });
  expect(byDay.get("2026-11-05")).toMatchObject({ missing: true });
  // Screen activity is there, so the three weekdays are planned from at once: median 30 × 1.25 → the one-hour floor.
  expect(view.capacity.weekday).toMatchObject({ basis: "screen", samples: 3, minutes: 60 });
  expect(view.capacity.weekend.basis).toBe("stated");
  configureMeasuredCapacity(true);
  expect(dayCapacityOf(TEST_CTX, "2026-11-11", 600, view)).toBe(60);
  expect(dayCapacityOf(TEST_CTX, "2026-11-14", 600, view)).toBe(300);
  configureMeasuredCapacity(false);
  expect(dayCapacityOf(TEST_CTX, "2026-11-11", 600, view)).toBe(600);
});

test("a block's work minutes: its own task's timer and the screen, not another task's timer", () => {
  const store = seed();
  store.saveWorkOrder({ id: "other", ownerId: TEST_CTX.principalId, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
    intent: "别的", state: "active", riskTier: "routine", estimate, payload: {} });
  store.recordConfirmedSession(ws, "other", TEST_CTX.principalId, { startedAt: iso("2026-11-09", "10:00"), endedAt: iso("2026-11-09", "11:00"), minutes: 60, source: "one_tap", key: "o" });
  store.recordConfirmedSession(ws, "hw", TEST_CTX.principalId, { startedAt: iso("2026-11-09", "10:00"), endedAt: iso("2026-11-09", "10:20"), minutes: 20, source: "one_tap", key: "h" });
  store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "granted");
  store.replaceDeviceActivitySegments(ws, iso("2026-10-01", "00:00"), [{ start: iso("2026-11-09", "10:10"), end: iso("2026-11-09", "10:40"), app: "a", category: "coding", idle: false }]);
  expect(blockWorkMinutes(TEST_CTX, "hw", iso("2026-11-09", "10:00"), iso("2026-11-09", "11:00"))).toBe(40);
});
