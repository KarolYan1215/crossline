import { expect, test } from "vitest";
import { reservedMinutes } from "./reserve";

test("the calendar's cautious hold is said only when it differs from the usual time (W-153)", () => {
  // With no measured time the plan holds p50 plus 10% (2026-11-11, W-255): 100 → 110; under 5 minutes more is not said.
  expect(reservedMinutes({ p50Minutes: 100, p85Minutes: 200 }, "low")).toBe(110);
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 50 }, "low")).toBeUndefined();
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 50 }, "medium")).toBeUndefined();
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 28 }, "low")).toBeUndefined();
  expect(reservedMinutes({ p50Minutes: 25, p85Minutes: 50 }, undefined)).toBeUndefined();
});
