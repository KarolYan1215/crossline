import { expect, test } from "vitest";
import { reservedMinutes } from "./reserve";

test("the calendar's cautious hold is said only when it differs from the usual time (W-153)", () => {
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 50 }, "low")).toBe(50);
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 50 }, "medium")).toBeUndefined();
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 28 }, "low")).toBeUndefined();
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 50 }, undefined)).toBeUndefined();
});
