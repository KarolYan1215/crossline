import { expect, test } from "vitest";
import { CALENDAR_CLASSIFICATION_SCHEMA, calendarEventKey, calendarLineOf, calendarLinesBasis, structuredOutputProblems, validateCalendarClassification } from "./index";

test("the classifier's schema follows the strict structured-output rules", () => {
  expect(structuredOutputProblems(CALENDAR_CLASSIFICATION_SCHEMA)).toEqual([]);
});

test("every occurrence of a recurring event shares one key, and the filing answers by title", () => {
  expect(calendarEventKey("  ECE 555   Lecture ")).toBe(calendarEventKey("ece 555 lecture"));
  const filing = { basis: "", entries: { [calendarEventKey("ECE 555 Lecture")]: { lineId: "research", why: "课程", at: "" }, "dentist": { lineId: "", why: "", at: "" } } };
  expect(calendarLineOf(filing, "ECE 555  lecture")).toBe("research");
  expect(calendarLineOf(filing, "Dentist")).toBeUndefined();
  expect(calendarLineOf(null, "x")).toBeUndefined();
});

test("unknown events are dropped; an unknown line is asked about, not refused; personal events stay plainly uncoloured", () => {
  const result = validateCalendarClassification({ items: [
    { key: "a", lineId: "research", why: "组会", unclear: false }, { key: "b", lineId: "ghost", why: "", unclear: false },
    { key: "c", lineId: "", why: "个人事务", unclear: false }, { key: "d", lineId: "", why: "标题看不出", unclear: true },
    { key: "zzz", lineId: "research", why: "", unclear: false }, { key: "a", lineId: "media", why: "重复", unclear: false }] }, ["a", "b", "c", "d"], ["research", "media"]);
  expect(result.items.map(({ rest: _rest, cancelled: _cancelled, ...item }) => item)).toEqual([{ key: "a", lineId: "research", why: "组会", unclear: false }, { key: "b", lineId: "", why: "", unclear: true },
    { key: "c", lineId: "", why: "个人事务", unclear: false }, { key: "d", lineId: "", why: "标题看不出", unclear: true }]);
  expect(calendarLinesBasis([{ id: "b", label: "创业者" }, { id: "a", label: "研究者" }])).toBe("a=研究者|b=创业者");
});

test("a task's shown name is its own: no course code is put in front by a pattern any more (the models name the course)", async () => {
  const { taskTitleOf } = await import("./index");
  expect(taskTitleOf({ intent: "复习第 3 章", payload: { title: "复习第 3 章" }, projectId: "ece548" })).toBe("复习第 3 章");
  expect(taskTitleOf({ intent: "x", payload: { title: "完成 Crossline 介入" }, projectId: "crossline" })).toBe("完成 Crossline 介入");
});

test("a meeting the organiser cancelled is the classifier's mark, not a title prefix", async () => {
  const { isCancelledEvent } = await import("./calendar-lines");
  const filing = { basis: "", entries: { "canceled: deja-vu monthly meeting": { lineId: "", why: "", at: "", rest: false, cancelled: true } } };
  expect(isCancelledEvent(filing, "Canceled: DEJA-VU Monthly Meeting")).toBe(true);
  // Unmarked, it is not dropped on the strength of its words.
  expect(isCancelledEvent(filing, "Cancelled: Lab sync")).toBe(false);
});
