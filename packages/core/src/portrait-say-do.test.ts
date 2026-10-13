import { expect, test } from "vitest";
import { answeredOnTime, sayDoReadings, type SayDoInput } from "./portrait-say-do";

const now = new Date("2026-10-12T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const base: SayDoInput = { now, firstExecutionAt: daysAgo(20), executions: 10, plannedMinutes: 600, workedMinutes: 450, stepsDue: 8, stepsOnTime: 6,
  started: 5, finished: 4, submitted: 3, passed: 2, waitingAnswered: 4, waitingOnTime: 3 };

test("each dimension is a ratio out of 100, rounded, capped at 100, and absent when nothing was counted", () => {
  const reading = sayDoReadings(base);
  expect(reading.does).toEqual({ plan: 75, on_time: 75, follow_through: 80, acceptance: 67, waiting: 75 });
  expect(sayDoReadings({ ...base, workedMinutes: 900 }).does.plan).toBe(100);
  expect(sayDoReadings({ ...base, plannedMinutes: 0, stepsDue: 0, started: 0, submitted: 0, waitingAnswered: 0 }).does)
    .toEqual({ plan: null, on_time: null, follow_through: null, acceptance: null, waiting: null });
});

test("the readings are drawn only after 14 days and 10 executions", () => {
  expect(sayDoReadings(base)).toMatchObject({ sufficient: true, days: 20, executions: 10 });
  expect(sayDoReadings({ ...base, firstExecutionAt: daysAgo(13) }).sufficient).toBe(false);
  expect(sayDoReadings({ ...base, executions: 9 }).sufficient).toBe(false);
  expect(sayDoReadings({ ...base, firstExecutionAt: daysAgo(14) }).sufficient).toBe(true);
  expect(sayDoReadings({ ...base, firstExecutionAt: null })).toMatchObject({ sufficient: false, days: 0 });
});

test("a waiting item answered within two days of its follow-up day is on time; the third day is late", () => {
  expect(answeredOnTime({ followUpAt: "2026-10-01", updatedAt: "2026-10-02T23:59:00Z" })).toBe(true);
  expect(answeredOnTime({ followUpAt: "2026-10-01", updatedAt: "2026-10-03T00:00:00Z" })).toBe(true);
  expect(answeredOnTime({ followUpAt: "2026-10-01", updatedAt: "2026-10-03T00:01:00Z" })).toBe(false);
});
