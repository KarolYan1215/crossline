import { describe, expect, test } from "vitest";
import { MIN_TEXT_PX, conflictingIds, dayRange, itemsFromPlan, itemsOn, layoutDay, minuteInZone, monthGrid, overlapStates, overlapping, packColumns, shiftDay, shiftMonth, toClock, toMinutes, weekDays, weekStart, type TimelineItem } from "./model";

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

test("the vertical day spans 07:00–22:00 at least, widened on whole hours to whatever lies outside", () => {
  expect(dayRange([])).toEqual({ from: 420, to: 1320 });
  expect(dayRange([{ start: "06:30", end: "07:00" }, { start: "22:10", end: "23:05" }])).toEqual({ from: 360, to: 1440 });
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

test("overlap is allowed, conflict is not: work on anything is a clash unless the person accepted it; their own calendar overlapping is neither", () => {
  const item = (id: string, kind: TimelineItem["kind"], start: string, end: string, extra: Partial<TimelineItem> = {}): TimelineItem =>
    ({ id, title: id, day: "2026-10-16", start, end, kind, source: "", readOnly: true, ...extra });
  const items = [
    item("meeting", "calendar", "12:00", "13:30"), item("class", "import", "13:00", "14:00"),
    item("held", "scheduled", "12:30", "13:00", { frozen: "locked" }),
    item("accepted", "scheduled", "13:40", "14:10", { frozen: "locked", overlapOk: true }),
    item("free", "scheduled", "15:00", "16:00"), item("seen", "activity", "15:00", "16:00"),
    item("tomorrow", "scheduled", "12:00", "13:00", { day: "2026-10-17" })
  ];
  const states = overlapStates(items);
  expect(Object.fromEntries(states)).toEqual({ meeting: "clash", held: "clash", class: "allowed", accepted: "allowed" });
  expect(overlapping(items, items[2]!).map((other) => other.id)).toEqual(["meeting"]);
  // The class and the meeting alone: the person's own calendar, not marked.
  expect(overlapStates(items.slice(0, 2)).size).toBe(0);
});

describe("layoutDay", () => {
  const PX = 72;
  const at = (id: string, start: string, end: string) => ({ id, start, end });
  /** Every box that carries text, so a test can say no two of them overlap. */
  const textBoxes = (pieces: ReturnType<typeof layoutDay<{ id: string; start: string; end: string }>>) => pieces.flatMap((piece) =>
    piece.kind === "block" ? [{ id: piece.item.id, top: piece.top + piece.textTop, bottom: piece.top + piece.height, left: piece.column / piece.columns, right: (piece.column + 1) / piece.columns }]
      : piece.kind === "more" ? [{ id: `more:${piece.items[0]!.id}`, top: piece.top, bottom: piece.top + piece.height, left: piece.column / piece.columns, right: (piece.column + 1) / piece.columns }]
        : []);
  const noTextOverlaps = (pieces: Parameters<typeof textBoxes>[0]) => {
    const boxes = textBoxes(pieces);
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!, b = boxes[j]!;
      const meet = a.left < b.right && b.left < a.right && a.top < b.bottom - 1e-9 && b.top < a.bottom - 1e-9;
      expect(meet, `${a.id} and ${b.id} overlap`).toBe(false);
    }
  };

  test("blocks are drawn at their true time and height, with no minimum that pushes one into the next", () => {
    const pieces = layoutDay([at("a", "09:00", "10:00"), at("b", "10:00", "10:30")], 7 * 60, PX);
    expect(pieces).toEqual([
      { kind: "block", item: at("a", "09:00", "10:00"), column: 0, columns: 1, top: 144, height: 72, textTop: 0 },
      { kind: "block", item: at("b", "10:00", "10:30"), column: 0, columns: 1, top: 216, height: 36, textTop: 0 }
    ]);
  });

  test("a block too short for a line of text is a bar, and two short ones back to back are one 「+N 项」 run", () => {
    // The real account's day: 11:35–11:47 and 11:47–11:55 had both been stretched to 22px and written over each other.
    const pieces = layoutDay([at("a", "11:35", "11:47"), at("b", "11:47", "11:55"), at("c", "13:00", "14:00")], 7 * 60, PX);
    expect(pieces.filter((piece) => piece.kind === "bar").map((piece) => piece.kind === "bar" && piece.item.id)).toEqual(["a", "b"]);
    const more = pieces.find((piece) => piece.kind === "more");
    expect(more?.kind === "more" && more.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(more?.height).toBe(MIN_TEXT_PX);
    expect(pieces.find((piece) => piece.kind === "block")?.kind === "block").toBe(true);
    noTextOverlaps(pieces);
  });

  test("a lone short block is a bar with no label; short blocks a line apart or more are separate", () => {
    const lone = layoutDay([at("a", "09:00", "09:10"), at("b", "10:00", "11:00")], 7 * 60, PX);
    expect(lone.map((piece) => piece.kind)).toEqual(["bar", "block"]);
    // 09:00–09:05 ends at 2h·72 + 6px; 09:25 starts 24px later, more than a line: two lone bars, no label.
    const apart = layoutDay([at("a", "09:00", "09:05"), at("b", "09:25", "09:30")], 7 * 60, PX);
    expect(apart.map((piece) => piece.kind)).toEqual(["bar", "bar"]);
  });

  test("a block starting under a run's label has its text moved below it, or joins the run when no line is left", () => {
    // Two 5-minute bars from 14:20, then a block at 14:30: the label covers 14:20 + 18px (15 minutes), so the block's text starts at 14:35.
    const pushed = layoutDay([at("a", "14:20", "14:25"), at("b", "14:25", "14:30"), at("c", "14:30", "15:30")], 7 * 60, PX);
    const block = pushed.find((piece) => piece.kind === "block");
    expect(block?.kind === "block" && block.textTop).toBeCloseTo(6);
    noTextOverlaps(pushed);
    // The same with a 20-minute block: 24px minus 6px pushed leaves exactly a line, so it keeps its text…
    expect(layoutDay([at("a", "14:20", "14:25"), at("b", "14:25", "14:30"), at("c", "14:30", "14:50")], 7 * 60, PX).some((piece) => piece.kind === "block")).toBe(true);
    // …and an 18-minute one would keep only 15.6px, so it joins the run, and the run takes the next short block too.
    const joined = layoutDay([at("a", "14:20", "14:25"), at("b", "14:25", "14:30"), at("c", "14:30", "14:48"), at("d", "14:50", "14:55")], 7 * 60, PX);
    expect(joined.filter((piece) => piece.kind === "block")).toEqual([]);
    const run = joined.find((piece) => piece.kind === "more");
    expect(run?.kind === "more" && run.items.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    noTextOverlaps(joined);
  });

  test("overlapping blocks keep their columns, and short ones beside a long one are bars in their own column", () => {
    const pieces = layoutDay([at("long", "09:00", "11:00"), at("x", "09:00", "09:10"), at("y", "09:10", "09:20"), at("z", "10:00", "10:30")], 7 * 60, PX);
    expect(pieces.find((piece) => piece.kind === "block" && piece.item.id === "long")).toMatchObject({ column: 0, columns: 2 });
    const run = pieces.find((piece) => piece.kind === "more");
    expect(run).toMatchObject({ column: 1, columns: 2 });
    noTextOverlaps(pieces);
  });

  test("no two pieces of text overlap on a crowded day", () => {
    const day = [at("a", "08:00", "08:07"), at("b", "08:07", "08:20"), at("c", "08:20", "08:31"), at("d", "08:31", "09:30"), at("e", "09:00", "09:12"),
      at("f", "09:12", "09:14"), at("g", "09:14", "10:00"), at("h", "10:00", "10:16"), at("i", "10:16", "10:30"), at("j", "11:35", "11:47"), at("k", "11:47", "11:55"),
      at("l", "11:55", "12:10"), at("m", "14:20", "14:22"), at("n", "14:22", "14:24"), at("o", "14:22", "15:00"), at("p", "14:30", "14:40")];
    const pieces = layoutDay(day, 7 * 60, PX);
    noTextOverlaps(pieces);
    // Nothing is lost: every item is a block or a bar exactly once.
    expect(pieces.flatMap((piece) => piece.kind === "more" ? [] : [piece.item.id]).sort()).toEqual(day.map((item) => item.id).sort());
  });
});
