import { expect, test } from "vitest";
import { availableSlots, validateAvailability, DEFAULT_AVAILABILITY } from "./availability";

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
