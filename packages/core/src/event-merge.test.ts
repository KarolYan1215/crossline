import { expect, test } from "vitest";
import { applyMerges, matchesItem, mergeCandidates, mergeDecision, mergedAway, sameTitle, seriesKey, titlesWorthALook, type MergeBook, type TimedItem } from "./event-merge";

const item = (id: string, kind: TimedItem["kind"], title: string, day: string, start: string, end: string, extra: Partial<TimedItem> = {}): TimedItem =>
  ({ id, kind, title, day, start, end, ...extra });

// Code only circles candidates on shared characters (2026-11-22); the course-code and number rules that decided sameness are gone, and
// whether 「ECE 555 Lecture」 and 「ECE 555 Office Hours」 are one thing is the reviewer's, then the person's.
test("titles: code circles candidates on shared characters and acts alone only on the same title", () => {
  expect(titlesWorthALook("ECE 555 Lecture", "ECE555 课堂")).toBe(true);
  expect(titlesWorthALook("组会", "实验室组会（周三）")).toBe(true);
  expect(titlesWorthALook("Band rehearsal", "Rehearsal (band)")).toBe(true);
  expect(titlesWorthALook("健身", "组会")).toBe(false);
  expect(sameTitle("Advisor meeting", "advisor  meeting!")).toBe(true);
  expect(sameTitle("ECE 548 Midterm 1", "ECE 548 Midterm 2")).toBe(false);
  expect(sameTitle("ECE 555 Lecture", "ECE 555 Office Hours")).toBe(false);
});

test("the person is asked only about the same title or what the reviewer called the same thing", () => {
  const items = [
    item("graph_calendar:a", "calendar", "ECE 555 Lecture", "2026-11-03", "11:00", "12:15", { source: "acct:cal" }),
    item("import:b:m1:2026-11-03", "file", "ECE 555 Office Hours", "2026-11-03", "11:00", "12:15")
  ];
  const [pair] = mergeCandidates(items, {});
  expect(pair).toBeDefined();
  expect(mergeCandidates(items, {}, {})).toEqual([]);
  expect(mergeCandidates(items, {}, { [pair!.key]: { same: false, why: "不同的场次", at: "t" } })).toEqual([]);
  expect(mergeCandidates(items, {}, { [pair!.key]: { same: true, why: "同一节课", at: "t" } })).toHaveLength(1);
  const twins = [items[0]!, item("event:e:2026-11-03", "event", "ECE 555 lecture", "2026-11-03", "11:00", "12:15")];
  expect(mergeCandidates(twins, {}, {})).toHaveLength(1);
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

// Merged without asking, so only on the same title (2026-11-22): 「ECE 555 上课」 beside 「ECE 555 Lecture」 is written and asked about.
test("a named time is merged into what starts within fifteen minutes on that day with the same title, never on a resemblance", () => {
  const existing = { title: "ECE 555 Lecture", day: "2026-11-03", start: "11:00" };
  expect(matchesItem({ title: "ECE 555 lecture", day: "2026-11-03", start: "11:10" }, existing)).toBe(true);
  expect(matchesItem({ title: "ECE 555 上课", day: "2026-11-03", start: "11:10" }, existing)).toBe(false);
  expect(matchesItem({ title: "ECE 555 Lecture", day: "2026-11-03", start: "11:30" }, existing)).toBe(false);
  expect(matchesItem({ title: "ECE 555 Lecture", day: "2026-11-04", start: "11:00" }, existing)).toBe(false);
});
