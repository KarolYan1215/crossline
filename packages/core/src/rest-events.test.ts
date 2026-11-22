import { expect, test } from "vitest";
import { isCancelledEvent, needsMarks, validateCalendarClassification, type CalendarLines } from "./calendar-lines";
import { isRestEvent } from "./rest-events";

const filing: CalendarLines = { basis: "r=研究", entries: {
  "休息": { lineId: "", why: "休息", at: "", rest: true, cancelled: false },
  "lunch seminar": { lineId: "r", why: "讲座", at: "", rest: false, cancelled: false },
  "canceled: group meeting": { lineId: "r", why: "已取消", at: "", rest: false, cancelled: true },
  "old": { lineId: "r", why: "", at: "" } } };

test("rest is the classifier's mark, not a word in the title; free time on the calendar is rest", () => {
  expect(isRestEvent({ title: "休息" }, filing)).toBe(true);
  // A lunch seminar is attended: the model told it apart, no word list did.
  expect(isRestEvent({ title: "Lunch Seminar" }, filing)).toBe(false);
  // Unfiled, or filed before the marks: not rest until the classifier says so.
  expect(isRestEvent({ title: "Lunch" }, filing)).toBe(false);
  expect(isRestEvent({ title: "old" }, filing)).toBe(false);
  expect(isRestEvent({ title: "Focus", showAs: "free" }, undefined)).toBe(true);
  expect(isRestEvent({ title: "休息", showAs: "busy" }, undefined)).toBe(false);
});

test("a cancelled meeting is the classifier's mark; an entry filed before the marks is read again", () => {
  expect(isCancelledEvent(filing, "Canceled:  Group Meeting")).toBe(true);
  expect(isCancelledEvent(filing, "Canceled: Something else")).toBe(false);
  expect(isCancelledEvent(undefined, "Canceled: Group Meeting")).toBe(false);
  expect(needsMarks(filing.entries.old)).toBe(true);
  expect(needsMarks(filing.entries["休息"])).toBe(false);
  expect(needsMarks(undefined)).toBe(false);
  const kept = validateCalendarClassification({ items: [{ key: "a", lineId: "r", why: "x", unclear: false, rest: true, cancelled: "yes" }] }, ["a"], ["r"]);
  expect(kept.items[0]).toMatchObject({ rest: true, cancelled: false });
});
