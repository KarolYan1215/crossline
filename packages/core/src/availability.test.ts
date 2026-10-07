import { describe, expect, test } from "vitest";
import { availableSlots, validateAvailability, suggestAvailability, DEFAULT_AVAILABILITY } from "./availability";

// 2026-09-14 is a Monday, 2026-09-19 a Saturday.
const weekday = [{ days: [1], start: "09:00", end: "17:00", energy: "high" as const }];

test("the calendar takes its share out of the middle of a window", () => {
  const slots = availableSlots(weekday, ["2026-09-14"], [{ day: "2026-09-14", start: "11:00", end: "12:30" }]);
  expect(slots).toEqual([
    { day: "2026-09-14", start: "09:00", end: "11:00", energy: "high" },
    { day: "2026-09-14", start: "12:30", end: "17:00", energy: "high" }
  ]);
});

test("a window with nothing booked survives whole, and a day it does not cover yields nothing", () => {
  expect(availableSlots(weekday, ["2026-09-14"], [])).toEqual([
    { day: "2026-09-14", start: "09:00", end: "17:00", energy: "high" }
  ]);
  // Saturday is not in `days`, so the window does not apply.
  expect(availableSlots(weekday, ["2026-09-19"], [])).toEqual([]);
});

test("a fully booked window leaves nothing, and overlapping bookings do not double-subtract", () => {
  expect(availableSlots(weekday, ["2026-09-14"], [{ day: "2026-09-14", start: "08:00", end: "18:00" }])).toEqual([]);
  const overlapping = availableSlots(weekday, ["2026-09-14"], [
    { day: "2026-09-14", start: "10:00", end: "12:00" },
    { day: "2026-09-14", start: "11:00", end: "13:00" }
  ]);
  expect(overlapping).toEqual([
    { day: "2026-09-14", start: "09:00", end: "10:00", energy: "high" },
    { day: "2026-09-14", start: "13:00", end: "17:00", energy: "high" }
  ]);
});

test("a sliver too short to start anything in is not offered as capacity", () => {
  // Ten minutes between two meetings is not a slot; offering it made the plan look busier than the day.
  const slots = availableSlots(weekday, ["2026-09-14"], [
    { day: "2026-09-14", start: "09:00", end: "12:00" },
    { day: "2026-09-14", start: "12:10", end: "17:00" }
  ]);
  expect(slots).toEqual([]);
});

test("a window that cannot mean anything is refused rather than silently emptying the plan", () => {
  expect(() => validateAvailability([{ days: [1], start: "17:00", end: "09:00", energy: "high" }]))
    .toThrow("AVAILABILITY_ENDS_BEFORE_IT_STARTS");
  expect(() => validateAvailability([{ days: [9], start: "09:00", end: "17:00", energy: "high" }]))
    .toThrow("AVAILABILITY_INVALID");
  expect(() => validateAvailability([{ days: [1], start: "9am", end: "17:00", energy: "high" }]))
    .toThrow("AVAILABILITY_INVALID");
  expect(validateAvailability(DEFAULT_AVAILABILITY)).toEqual(DEFAULT_AVAILABILITY);
});

describe("suggestAvailability", () => {
  const day = (date: string, from: string, to: string) => ({ start: `${date}T${from}:00.000Z`, end: `${date}T${to}:00.000Z`, idle: false });
  // Chicago is UTC-5 in September, so 14:00Z is 09:00 local.
  const week = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];

  test("weekdays with the same hours share one window, and the hours are local, not UTC", () => {
    const segments = week.map((date) => day(date, "14:00", "17:00"));
    expect(suggestAvailability({ segments, timeZone: "America/Chicago" })).toEqual([
      { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "medium" }
    ]);
  });

  test("idle time, one-off activity and a short burst do not become availability", () => {
    const segments = [...week.map((date) => day(date, "14:00", "17:00")),
      { ...day("2026-09-07", "20:00", "23:00"), idle: true },
      day("2026-09-12", "20:00", "20:40")];
    const [only] = suggestAvailability({ segments, timeZone: "America/Chicago" });
    expect(only?.start).toBe("09:00");
    expect(suggestAvailability({ segments, timeZone: "America/Chicago" })).toHaveLength(1);
  });

  test("less than a week of observed days suggests nothing rather than a pattern from an accident", () => {
    expect(suggestAvailability({ segments: week.slice(0, 5).map((date) => day(date, "14:00", "17:00")), timeZone: "America/Chicago" })).toEqual([]);
  });
});

test("the stated weekly total is read from the person's own facts, and compared with the pattern's hours", async () => {
  const { statedWeeklyHours, weeklyAvailableHours } = await import("./availability");
  expect(statedWeeklyHours([
    { slot: "weekly_hours", status: "confirmed", value: "ECE 555 与 ECE 548 合计每周约 15 小时。" },
    { slot: "weekly_hours", status: "confirmed", value: "无法按项目拆分；所有事情合计每周约 72 小时。" },
    { slot: "weekly_hours", status: "confirmed", value: "每周投入 10–20 小时。" }
  ])).toBe(72);
  expect(statedWeeklyHours([{ slot: "weekly_hours", status: "inferred", value: "所有事情合计每周约 72 小时" }])).toBeUndefined();
  expect(weeklyAvailableHours([{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" },
    { days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", energy: "medium" }, { days: [0, 6], start: "10:00", end: "12:00", energy: "low" }])).toBe(39);
});
