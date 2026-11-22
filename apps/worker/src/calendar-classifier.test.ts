import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { CALENDAR_LINES, calendarLineOf } from "@crossline/core";
import { LINE_SETTING } from "@crossline/identity-packs";
import { createCalendarClassifier, readCalendarLines, unfiledCalendarEvents } from "./calendar-classifier";
import { fakeRuntime } from "./testing/fake-runtime";

const ws = "w";
const block = (id: string, title: string, day: string, start = "10:00", end = "11:00") => ({ id, lane: "human", title, day, start, end, source: "日历", readOnly: true });

test("calendar events are filed under lines by title, once per recurring title, and refiled when the lines change", async () => {
  const store = new CrosslineStore(":memory:");
  store.savePlanVersion({ id: "plan-1", ownerId: "o", workspaceId: ws, version: 1, status: "approved", payload: { blocks: [
    block("graph_calendar:a1", "ECE 555 Lecture", "2026-10-13"), block("graph_calendar:a2", "ECE 555  lecture", "2026-10-15"),
    block("graph_calendar:b", "Dentist", "2026-10-14"), block("import:x:1", "ECE 548 Midterm", "2026-10-27"),
    block("scheduled:wo-1:1", "完成作业 2", "2026-10-13") ] } });
  const events = unfiledCalendarEvents(store, ws);
  expect(events.map((event) => [event.title, event.count, event.source])).toEqual([
    ["ECE 555 Lecture", 2, "calendar"], ["Dentist", 1, "calendar"], ["ECE 548 Midterm", 1, "file"]]);
  expect(events[0]!.when[0]).toBe("2026-10-13 周二 10:00–11:00");

  const answer = { items: [
    { key: "ece 555 lecture", lineId: "research", why: "研究者主线下的课程", unclear: false, rest: false, cancelled: false },
    { key: "dentist", lineId: "", why: "个人事务", unclear: false, rest: false, cancelled: false },
    { key: "ece 548 midterm", lineId: "nonexistent", why: "", unclear: false, rest: false, cancelled: false }] };
  const runtime = fakeRuntime([JSON.stringify(answer)], "crossline:crossline-calendar-classifier");
  expect(await createCalendarClassifier(store, ws, "C:\repo", () => runtime.rpc)()).toEqual({ filed: 3 });
  const filing = readCalendarLines(store, ws);
  expect(calendarLineOf(filing, "ECE 555 Lecture")).toBe("research");
  expect(calendarLineOf(filing, "Dentist")).toBeUndefined();
  expect(calendarLineOf(filing, "ECE 548 Midterm")).toBeUndefined();
  expect(filing.entries["ece 548 midterm"]).toMatchObject({ unclear: true, by: "model" });
  expect(filing.entries["dentist"]?.unclear).toBeUndefined();
  // Filed once: nothing is asked again.
  expect(unfiledCalendarEvents(store, ws)).toEqual([]);
  expect(store.getSetting(ws, CALENDAR_LINES)).toBeTruthy();

  // A renamed line changes what the answers were made against: every event is filed again.
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "research", label: "科研者", color: "research", goal: "", goals: [] }]));
  expect(unfiledCalendarEvents(store, ws)).toHaveLength(3);
  store.close();
});

test("an entry filed before the rest and cancelled marks is read once more; the person's line is kept, only the marks are added", async () => {
  const store = new CrosslineStore(":memory:");
  store.savePlanVersion({ id: "plan-1", ownerId: "o", workspaceId: ws, version: 1, status: "approved", payload: { blocks: [
    block("graph_calendar:a", "Lunch", "2026-10-13", "12:00", "13:00"), block("graph_calendar:b", "Canceled: Lab sync", "2026-10-14"),
    block("graph_calendar:c", "Lunch Seminar", "2026-10-15") ] } });
  const basis = readCalendarLines(store, ws).basis;
  store.setSetting(ws, CALENDAR_LINES, JSON.stringify({ basis, entries: {
    "lunch": { lineId: "", why: "", at: "2026-10-01T00:00:00Z", by: "person" },
    "canceled: lab sync": { lineId: "", why: "", at: "2026-10-01T00:00:00Z", by: "model" },
    "lunch seminar": { lineId: "", why: "", at: "2026-10-01T00:00:00Z", by: "model", rest: false, cancelled: false } } }));
  expect(unfiledCalendarEvents(store, ws).map((event) => event.title)).toEqual(["Lunch", "Canceled: Lab sync"]);
  const answer = { items: [
    { key: "lunch", lineId: "", why: "用餐", unclear: false, rest: true, cancelled: false },
    { key: "canceled: lab sync", lineId: "", why: "组织者已取消", unclear: false, rest: false, cancelled: true }] };
  const runtime = fakeRuntime([JSON.stringify(answer)], "crossline:crossline-calendar-classifier");
  await createCalendarClassifier(store, ws, "C:\\repo", () => runtime.rpc)();
  const filing = readCalendarLines(store, ws);
  expect(filing.entries["lunch"]).toMatchObject({ by: "person", rest: true, cancelled: false });
  expect(filing.entries["canceled: lab sync"]).toMatchObject({ cancelled: true });
  expect(unfiledCalendarEvents(store, ws)).toEqual([]);
  store.close();
});
