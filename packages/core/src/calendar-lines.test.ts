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
