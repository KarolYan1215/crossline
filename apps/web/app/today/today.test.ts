import { expect, test } from "vitest";
import { curveGeometry } from "../energy-capsule";
import { searchHref } from "../top-search";
import { weekLoad } from "./week-load";

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

test("the week strip: each day's work over its hours, full past the hours, and a flag on a day something is due", () => {
  const block = (day: string, start: string, end: string, kind: "scheduled" | "calendar" = "scheduled") =>
    ({ id: `${day}${start}`, title: "x", day, start, end, kind, ...(kind === "scheduled" ? { workOrderId: "w" } : {}) }) as Parameters<typeof weekLoad>[0][number];
  // 2026-10-26 is a Monday; Monday's quiet hours leave 12 hours, of which a 2-hour meeting takes 2.
  const week = weekLoad([block("2026-10-26", "09:00", "14:00"), block("2026-10-26", "15:00", "17:00", "calendar"), block("2026-10-27", "00:00", "23:00")],
    [{ id: "d", day: "2026-10-28", title: "期中" }], "2026-10-28", { 1: [["00:00", "08:00"], ["20:00", "24:00"]] });
  expect(week.map((day) => day.day)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  expect(week[0]).toMatchObject({ work: 300, load: 0.5, deadline: false });
  expect(week[1]!.load).toBeCloseTo(23 / 24, 5);
  expect(week[2]).toMatchObject({ work: 0, load: 0, deadline: true });
});

test("a search result opens where it is dealt with", () => {
  expect(searchHref({ kind: "task", id: "wo 1", title: "x" })).toBe("/workbench/wo%201");
  expect(searchHref({ kind: "milestone", id: "m1", title: "x" })).toBe("/milestones?open=m1");
  expect(searchHref({ kind: "goal", id: "research", title: "x" })).toBe("/milestones");
  expect(searchHref({ kind: "material", id: "d1", title: "x" })).toBe("/api/source-documents/d1/file");
});
