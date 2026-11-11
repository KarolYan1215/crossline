import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { acceptanceProgress } from "./crossline";

const NOW = new Date("2026-09-25T18:00:00.000Z"); // a Friday, 2026-09-25 in UTC

test("today with nothing accepted yet reads as a real 0, not a carried-over streak", () => {
  expect(acceptanceProgress([], "UTC", NOW)).toEqual({ streakDays: 0, weekCount: 0 });
  // Nothing today, even with a run of acceptances earlier this week — no grace period.
  const earlierThisWeek = ["2026-09-22T10:00:00.000Z", "2026-09-23T10:00:00.000Z", "2026-09-24T10:00:00.000Z"];
  expect(acceptanceProgress(earlierThisWeek, "UTC", NOW).streakDays).toBe(0);
});

test("streak counts consecutive local days ending today and stops at the first gap", () => {
  const timestamps = [
    "2026-09-25T10:00:00.000Z", // today
    "2026-09-24T10:00:00.000Z", // yesterday
    "2026-09-23T10:00:00.000Z", // day before
    // 2026-09-22 missing: the streak must stop here
    "2026-09-21T10:00:00.000Z"
  ];
  expect(acceptanceProgress(timestamps, "UTC", NOW).streakDays).toBe(3);
});

test("weekCount is a rolling 7-day window of real acceptances, independent of the streak", () => {
  const timestamps = [
    "2026-09-25T10:00:00.000Z", // today, in window
    "2026-09-19T19:00:00.000Z", // 5.96 days back, in window
    "2026-09-18T10:00:00.000Z" // more than 7 days back, out of window
  ];
  expect(acceptanceProgress(timestamps, "UTC", NOW).weekCount).toBe(2);
});

test("two acceptances on the same local day count once toward the streak, but twice toward the week", () => {
  const timestamps = ["2026-09-25T02:00:00.000Z", "2026-09-25T15:00:00.000Z"];
  const result = acceptanceProgress(timestamps, "UTC", NOW);
  expect(result.streakDays).toBe(1);
  expect(result.weekCount).toBe(2);
});

test("steps finished in the last seven days are counted once each, and a step opened again does not count (2026-11-11, W-258)", async () => {
  // The owner finished steps all week and Today said 本周完成 0 件: only whole accepted tasks were counted.
  const { stepsDoneSince } = await import("./crossline");
  const at = (iso: string, workOrderId: string, stepId: string, status: string) =>
    ({ entityId: workOrderId, createdAt: iso, payload: { stepId, status } });
  const since = new Date(NOW.getTime() - 7 * 86_400_000);
  expect(stepsDoneSince([
    at("2026-09-24T10:00:00.000Z", "a", "s1", "done"),
    at("2026-09-24T11:00:00.000Z", "a", "s1", "done"),
    at("2026-09-23T10:00:00.000Z", "a", "s2", "done"),
    at("2026-09-23T12:00:00.000Z", "a", "s2", "planned"),
    at("2026-09-10T10:00:00.000Z", "b", "s1", "done"),
    at("2026-09-24T09:00:00.000Z", "b", "s2", "skipped"),
    at("2026-09-25T09:00:00.000Z", "c", "s1", "done")
  ], since)).toBe(2);
});
