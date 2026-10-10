import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { loadCurrentPlan, planToday, saveSchedulePreferences } from "./crossline";
import { readScheduledDay, readScheduledMinutes, recordScheduledToday, scheduledMinutesKey, stepStartsOf } from "./schedule-memory";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });

const minutes = (block: { start: string; end: string }) => {
  const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
  return eh! * 60 + em! - (sh! * 60 + sm!);
};

test("the day's plan is remembered with each order's planned minutes, keeping the most seen that day", async () => {
  vi.stubEnv("CROSSLINE_FIXED_NOW", "2026-09-18T13:00:00.000Z");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  saveSchedulePreferences(TEST_CTX, { timeZone: "America/Chicago", mode: "buffered",
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "20:00", energy: "high" }], importance: {} });
  const today = planToday(TEST_CTX);
  expect(readScheduledMinutes(TEST_CTX, today)).toBeNull();
  await recordScheduledToday(TEST_CTX, new Date("2026-09-18T13:00:00.000Z"));
  const plan = await loadCurrentPlan(TEST_CTX);
  const expected: Record<string, number> = {};
  for (const block of plan.blocks.filter((item) => item.id.startsWith("scheduled:") && item.day === today)) {
    const order = block.id.split(":")[1]!;
    expected[order] = (expected[order] ?? 0) + minutes(block);
  }
  expect(Object.keys(expected).length).toBeGreaterThan(0);
  expect(readScheduledMinutes(TEST_CTX, today)).toEqual(expected);
  // The start-time record the missed-block ask reads keeps its shape.
  expect(Object.keys(readScheduledDay(TEST_CTX, today)).sort()).toEqual(Object.keys(expected).sort());

  // A longer plan seen earlier in the day is kept; an order no longer planned is not forgotten.
  const [first] = Object.keys(expected);
  store.setSetting(TEST_CTX.workspaceId, scheduledMinutesKey(today), JSON.stringify({ ...expected, [first!]: 999, gone: 30 }));
  await recordScheduledToday(TEST_CTX, new Date("2026-09-18T13:00:00.000Z"));
  expect(readScheduledMinutes(TEST_CTX, today)).toMatchObject({ [first!]: 999, gone: 30 });
});

// 「自动交给 Agent」 reads where each step's next block starts; the schedule itself is never stored, so this is the worker's only view of it.
test("each step's earliest block in the coming week, as an instant; whole-task blocks, other days and other kinds are left out", () => {
  const toInstant = (day: string, time: string) => `${day}T${time}:00.000Z`;
  const starts = stepStartsOf([
    { id: "scheduled:wo-1:v2s3:1", day: "2026-10-13", start: "14:00" },
    { id: "scheduled:wo-1:v2s3:0", day: "2026-10-12", start: "16:00" },
    { id: "scheduled:wo-1:v2s4", day: "2026-10-14", start: "09:00" },
    { id: "scheduled:wo-2:1", day: "2026-10-12", start: "10:00" },
    { id: "scheduled:wo-3:v1s1", day: "2026-10-11", start: "10:00" },
    { id: "scheduled:wo-3:v1s2", day: "2026-10-19", start: "10:00" },
    { id: "optional:wo-4:v1s1", day: "2026-10-12", start: "22:00" },
    { id: "graph_calendar:abc", day: "2026-10-12", start: "09:00" }
  ], "2026-10-12", "2026-10-19", toInstant);
  expect(starts).toEqual({ "wo-1#v2s3": "2026-10-12T16:00:00.000Z", "wo-1#v2s4": "2026-10-14T09:00:00.000Z" });
});

test("a block whose local time does not exist (a clock change) is skipped rather than guessed", () => {
  expect(stepStartsOf([{ id: "scheduled:wo-1:v1s1", day: "2026-10-12", start: "02:30" }], "2026-10-12", "2026-10-19", () => undefined)).toEqual({});
});
