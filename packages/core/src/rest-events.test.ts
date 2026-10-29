import { expect, test } from "vitest";
import { isRestEvent } from "./rest-events";

test("rest, meals and sleep are rest; a seminar over lunch or a class is not (W-156)", () => {
  for (const title of ["休息", "午休", "晚饭", "今晚不排工作", "Lunch", "Sleep", "Break"]) expect(isRestEvent({ title })).toBe(true);
  for (const title of ["ECE 548", "研究组组会", "Lunch seminar", "Dinner meeting with advisor", "Compute Lab Meeting", "Breakthrough review"])
    expect(isRestEvent({ title })).toBe(false);
  expect(isRestEvent({ title: "Focus", showAs: "free" })).toBe(true);
  expect(isRestEvent({ title: "Focus", showAs: "busy" })).toBe(false);
});
