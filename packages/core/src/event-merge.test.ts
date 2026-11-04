import { expect, test } from "vitest";
import { applyMerges, matchesItem, mergeCandidates, mergeDecision, mergedAway, seriesKey, similarTitles, type MergeBook, type TimedItem } from "./event-merge";

const item = (id: string, kind: TimedItem["kind"], title: string, day: string, start: string, end: string, extra: Partial<TimedItem> = {}): TimedItem =>
  ({ id, kind, title, day, start, end, ...extra });

test("titles: same course or wording are alike; another course or another number never", () => {
  expect(similarTitles("ECE 555 Lecture", "ECE555 课堂")).toBe(true);
  expect(similarTitles("组会", "实验室组会（周三）")).toBe(true);
  expect(similarTitles("Advisor meeting", "Meeting with advisor")).toBe(true);
  expect(similarTitles("ECE 555 Lecture", "ECE 548 Lecture")).toBe(false);
  expect(similarTitles("ECE 548 Midterm 1", "ECE 548 Midterm 2")).toBe(false);
  expect(similarTitles("健身", "组会")).toBe(false);
});

test("a weekly pair is one question, with how many days it meets; an answered pair is not asked again", () => {
  const items = [
    item("graph_calendar:a1", "calendar", "ECE 555 Lecture", "2026-11-03", "11:00", "12:15", { source: "acct:cal" }),
    item("import:b:m1:2026-11-03", "file", "ECE 555 课堂", "2026-11-03", "11:00", "12:15"),
    item("graph_calendar:a2", "calendar", "ECE 555 Lecture", "2026-11-10", "11:00", "12:15", { source: "acct:cal" }),
    item("import:b:m1:2026-11-10", "file", "ECE 555 课堂", "2026-11-10", "11:00", "12:15"),
    item("event:ev-1:2026-11-03", "event", "健身", "2026-11-03", "11:30", "12:00")
  ];
  const pairs = mergeCandidates(items, {});
  expect(pairs).toHaveLength(1);
  expect(pairs[0]).toMatchObject({ firstDay: "2026-11-03", days: 2 });
  const { key, decision } = mergeDecision(pairs[0]!.a, pairs[0]!.b, "different", "person", "t");
  expect(mergeCandidates(items, { [key]: decision })).toHaveLength(0);
});

test("merged once, merged every week: the file's copy leaves each day it meets the calendar's, and stays on a day it is alone", () => {
  const cal = (day: string) => item(`graph_calendar:${day}`, "calendar", "ECE 555 Lecture", day, "11:00", "12:15", { source: "acct:cal" });
  const file = (day: string) => item(`import:b:m1:${day}`, "file", "ECE 555 课堂", day, "11:00", "12:15");
  const { key, decision } = mergeDecision(file("2026-11-03"), cal("2026-11-03"), "merge", "person", "t");
  // The person's own calendar is kept, whichever order the pair came in.
  expect(decision.keep).toBe(seriesKey(cal("2026-11-03")));
  const book: MergeBook = { [key]: decision };
  const { items, mergedInto } = applyMerges([cal("2026-11-03"), file("2026-11-03"), cal("2026-11-24"), file("2026-11-24"), file("2026-12-01")], book);
  expect(items.map((entry) => entry.id)).toEqual(["graph_calendar:2026-11-03", "graph_calendar:2026-11-24", "import:b:m1:2026-12-01"]);
  expect(mergedInto.get("graph_calendar:2026-11-24")).toEqual(["ECE 555 课堂"]);
  expect(mergedAway(book, seriesKey(file("2026-12-08")))).toBe(true);
});

test("a locked work block keeps itself over the calendar event it is", () => {
  const work = item("scheduled:wo-1:v1s2", "work", "复习 ECE 555", "2026-11-03", "14:00", "15:00", { orderId: "wo-1" });
  const cal = item("graph_calendar:x", "calendar", "ECE 555 study", "2026-11-03", "14:00", "15:00");
  const { decision } = mergeDecision(cal, work, "merge", "person", "t");
  expect(decision).toMatchObject({ keep: "work:wo-1", drop: seriesKey(cal) });
});

test("a named time matches what starts within fifteen minutes on that day and says the same thing", () => {
  const existing = { title: "ECE 555 Lecture", day: "2026-11-03", start: "11:00" };
  expect(matchesItem({ title: "ECE 555 上课", day: "2026-11-03", start: "11:10" }, existing)).toBe(true);
  expect(matchesItem({ title: "ECE 555 上课", day: "2026-11-03", start: "11:30" }, existing)).toBe(false);
  expect(matchesItem({ title: "ECE 555 上课", day: "2026-11-04", start: "11:00" }, existing)).toBe(false);
});
