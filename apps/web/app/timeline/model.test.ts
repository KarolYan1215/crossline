import { expect, test } from "vitest";
import { axisSpan, conflictingIds, itemsFromPlan, itemsOn, minuteInZone, monthGrid, packColumns, shiftDay, shiftMonth, toClock, toMinutes, weekDays, weekStart } from "./model";

test("days and weeks move the way a calendar does, with Monday first", () => {
  expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
  expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  expect(weekStart("2026-10-04")).toBe("2026-09-28");
  expect(weekStart("2026-10-05")).toBe("2026-10-05");
  expect(weekDays("2026-10-07")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-01");
  expect(shiftMonth("2026-01-15", -1)).toBe("2025-12-01");
});

test("the month grid is always six Monday-first weeks and marks the days outside the month", () => {
  const grid = monthGrid("2026-10-15");
  expect(grid).toHaveLength(6);
  expect(grid.every((week) => week.length === 7)).toBe(true);
  expect(grid[0]![0]).toEqual({ day: "2026-09-28", inMonth: false });
  expect(grid[0]![3]).toEqual({ day: "2026-10-01", inMonth: true });
  expect(grid.flat().filter((cell) => cell.inMonth)).toHaveLength(31);
});

test("overlapping blocks are packed side by side and separate ones keep full width", () => {
  const packed = packColumns([
    { start: "09:00", end: "10:30" }, { start: "10:00", end: "11:00" }, { start: "10:15", end: "10:45" }, { start: "13:00", end: "14:00" }
  ]);
  expect(packed.map((entry) => [entry.column, entry.columns])).toEqual([[0, 3], [1, 3], [2, 3], [0, 1]]);
  // Back-to-back is not an overlap.
  expect(packColumns([{ start: "09:00", end: "10:00" }, { start: "10:00", end: "11:00" }].map((item) => item)).map((entry) => entry.columns)).toEqual([1, 1]);
});

test("a block's place on the 24 hour axis, with a floor so a short one stays clickable", () => {
  expect(axisSpan("06:00", "12:00")).toEqual({ left: 25, width: 25 });
  expect(axisSpan("23:30", "23:30").width).toBeCloseTo(10 / 14.4, 5);
  expect(toMinutes("14:25")).toBe(865);
  expect(toClock(865)).toBe("14:25");
});

test("conflicts are only real overlaps", () => {
  const items = [{ id: "a", start: "09:00", end: "10:00" }, { id: "b", start: "09:30", end: "10:30" }, { id: "c", start: "10:30", end: "11:00" }];
  expect([...conflictingIds(items)].sort()).toEqual(["a", "b"]);
});

test("the current minute is read in the person's zone, not the machine's", () => {
  expect(minuteInZone("2026-10-02T18:30:00.000Z", "America/Chicago")).toBe(13 * 60 + 30);
  expect(minuteInZone("2026-10-02T18:30:00.000Z", "Asia/Shanghai")).toBe(2 * 60 + 30);
});

test("plan blocks become items: scheduled ones pick up their line, a block with no day lands on today", () => {
  const items = itemsFromPlan([
    { id: "graph_calendar:1", lane: "human", title: "组会", day: "2026-10-05", start: "10:00", end: "11:00", source: "Outlook", readOnly: true },
    { id: "scheduled:wo-1:0", lane: "ai", title: "仿真", start: "14:00", end: "15:00", source: "scheduler", readOnly: false },
    { id: "import:b:c:2026-10-06", lane: "human", title: "ECE 555", day: "2026-10-06", start: "14:30", end: "15:45", source: "文件导入", readOnly: true }
  ], "2026-10-02", { "wo-1": { identityId: "research", milestone: "西湖投稿" } });
  expect(items.map((item) => [item.kind, item.day, item.identityId ?? "-"])).toEqual([["calendar", "2026-10-05", "-"], ["scheduled", "2026-10-02", "research"], ["import", "2026-10-06", "-"]]);
  expect(items[1]).toMatchObject({ workOrderId: "wo-1", milestone: "西湖投稿" });
  expect(itemsOn(items, "2026-10-02").map((item) => item.id)).toEqual(["scheduled:wo-1:0"]);
});
