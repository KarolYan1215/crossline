import { expect, test } from "vitest";
import { curveGeometry } from "../energy-capsule";
import { searchHref } from "../top-search";

test("the energy curve: a smooth path across the card, the cut points inside it, and now on the curve", () => {
  const points = Array.from({ length: 36 }, (_, index) => ({ minute: 360 + index * 30, alertness: 11 + Math.sin(index / 5) * 2 }));
  const shape = curveGeometry({ points, low: 9.5, high: 12.5, nowMinute: 9 * 60 + 10 });
  expect(shape.line.startsWith("M0.0,")).toBe(true);
  expect(shape.line.match(/ C/g)).toHaveLength(points.length - 1);
  expect(shape.area.endsWith("Z")).toBe(true);
  // Higher alertness is higher on the card (smaller y); both cut points sit inside the 88px drawing.
  expect(shape.high).toBeLessThan(shape.low);
  for (const y of [shape.low, shape.high]) { expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(88); }
  expect(shape.now!.x).toBeCloseTo(((550 - 360) / 1080) * 320, 5);
  // Before 06:00 there is no "now" mark on the day's curve.
  expect(curveGeometry({ points, low: 9.5, high: 12.5, nowMinute: 300 }).now).toBeUndefined();
});

test("a search result opens where it is dealt with", () => {
  expect(searchHref({ kind: "task", id: "wo 1", title: "x" })).toBe("/workbench/wo%201");
  expect(searchHref({ kind: "milestone", id: "m1", title: "x" })).toBe("/milestones?open=m1");
  expect(searchHref({ kind: "goal", id: "research", title: "x" })).toBe("/milestones");
  expect(searchHref({ kind: "material", id: "d1", title: "x" })).toBe("/api/source-documents/d1/file");
});
