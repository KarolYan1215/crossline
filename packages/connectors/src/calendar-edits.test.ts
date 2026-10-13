import { describe, expect, test } from "vitest";
import { classifyCalendarEdits, type PublishedEntry } from "./calendar-edits";

const now = new Date("2026-10-12T15:00:00.000Z");
const entry = (over: Partial<PublishedEntry> = {}): PublishedEntry =>
  ({ eventId: "e1", title: "作业 3", start: "2026-10-13T16:00:00.000Z", end: "2026-10-13T17:00:00.000Z", ...over });

describe("classifyCalendarEdits", () => {
  test("the time moved: the person put it there, so it is locked at the new time", () => {
    const edits = classifyCalendarEdits({ "scheduled:hw3": entry() },
      [{ blockId: "scheduled:hw3", eventId: "e1", title: "作业 3", start: "2026-10-13T18:00:00.000Z", end: "2026-10-13T19:00:00.000Z" }], now);
    expect(edits).toEqual({ moved: [{ blockId: "scheduled:hw3", start: "2026-10-13T18:00:00.000Z", end: "2026-10-13T19:00:00.000Z" }], retitled: [], removed: [] });
  });

  test("only the title changed: not a lock, the title is the person's from now on", () => {
    const edits = classifyCalendarEdits({ "scheduled:hw3": entry() },
      [{ blockId: "scheduled:hw3", eventId: "e1", title: "作业 3（图书馆）", start: "2026-10-13T16:00:00.000Z", end: "2026-10-13T17:00:00.000Z" }], now);
    expect(edits).toEqual({ moved: [], retitled: [{ blockId: "scheduled:hw3", title: "作业 3（图书馆）" }], removed: [] });
  });

  test("a title the person already set is not reported again", () => {
    const edits = classifyCalendarEdits({ "scheduled:hw3": entry({ personTitle: "作业 3（图书馆）" }) },
      [{ blockId: "scheduled:hw3", eventId: "e1", title: "作业 3（图书馆）", start: "2026-10-13T16:00:00.000Z", end: "2026-10-13T17:00:00.000Z" }], now);
    expect(edits).toEqual({ moved: [], retitled: [], removed: [] });
  });

  test("a future event the person deleted is removed by the person; a past one is just over", () => {
    const edits = classifyCalendarEdits({
      "scheduled:hw3": entry(),
      "scheduled:old": entry({ eventId: "e2", start: "2026-10-11T16:00:00.000Z", end: "2026-10-11T17:00:00.000Z" }),
      "scheduled:gone": entry({ eventId: "e3", removedByPerson: true })
    }, [], now);
    expect(edits).toEqual({ moved: [], retitled: [], removed: ["scheduled:hw3"] });
  });

  test("an unchanged event is not an edit; a record from before (only a hash) is not classified", () => {
    const edits = classifyCalendarEdits({ "scheduled:hw3": entry(), "scheduled:legacy": { eventId: "e9", hash: "abc", title: "", start: "", end: "" } },
      [{ blockId: "scheduled:hw3", eventId: "e1", title: "作业 3", start: "2026-10-13T16:00:00.000Z", end: "2026-10-13T17:00:00.000Z" },
        { blockId: "scheduled:legacy", eventId: "e9", title: "x", start: "2026-10-13T20:00:00.000Z", end: "2026-10-13T21:00:00.000Z" }], now);
    expect(edits).toEqual({ moved: [], retitled: [], removed: [] });
  });

  test("times compare at minute precision, whatever the format the calendar returns", () => {
    const edits = classifyCalendarEdits({ "scheduled:hw3": entry() },
      [{ blockId: "scheduled:hw3", eventId: "e1", title: "作业 3", start: "2026-10-13T16:00:00.0000000Z", end: "2026-10-13T11:00:00-06:00" }], now);
    expect(edits).toEqual({ moved: [], retitled: [], removed: [] });
  });
});
