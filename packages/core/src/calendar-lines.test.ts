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

test("unknown events are dropped and an unknown line is filed under none, never refused", () => {
  const result = validateCalendarClassification({ items: [
    { key: "a", lineId: "research", why: "组会" }, { key: "b", lineId: "ghost", why: "" }, { key: "zzz", lineId: "research", why: "" },
    { key: "a", lineId: "media", why: "重复" }] }, ["a", "b"], ["research", "media"]);
  expect(result.items).toEqual([{ key: "a", lineId: "research", why: "组会" }, { key: "b", lineId: "", why: "" }]);
  expect(calendarLinesBasis([{ id: "b", label: "创业者" }, { id: "a", label: "研究者" }])).toBe("a=研究者|b=创业者");
});

test("a file date imported without its course is shown and filed with it, from its batch item's project", async () => {
  const { importedProjects, importedTitle, taskTitleOf } = await import("./index");
  const projects = importedProjects([{ entityId: "b1", payload: { dates: [{ id: "final", project: "ECE 555" }, { id: "mid", project: "课程待确认（可能为 ECE 548）" }],
    recurring: [{ id: "lec", project: "ECE 555" }] } }]);
  expect(importedTitle("import:b1:final", "课堂期末考试", projects)).toBe("ECE 555 课堂期末考试");
  expect(importedTitle("import:b1:lec:2026-10-13", "每周上课", projects)).toBe("ECE 555 每周上课");
  expect(importedTitle("import:b1:mid", "期中考试 1", projects)).toBe("期中考试 1");
  expect(importedTitle("graph_calendar:x", "课堂期末考试", projects)).toBe("课堂期末考试");
  // A task's shown name carries its course the same way.
  expect(taskTitleOf({ intent: "复习第 3 章", payload: { title: "复习第 3 章" }, projectId: "ece548" })).toBe("ECE 548 复习第 3 章");
  expect(taskTitleOf({ intent: "x", payload: { title: "完成 Crossline 介入" }, projectId: "crossline" })).toBe("完成 Crossline 介入");
});
