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
    { key: "ece 555 lecture", lineId: "research", why: "研究者主线下的课程" },
    { key: "dentist", lineId: "", why: "个人事务" },
    { key: "ece 548 midterm", lineId: "nonexistent", why: "" }] };
  const runtime = fakeRuntime([JSON.stringify(answer)], "crossline:crossline-calendar-classifier");
  expect(await createCalendarClassifier(store, ws, "C:\repo", () => runtime.rpc)()).toEqual({ filed: 3 });
  const filing = readCalendarLines(store, ws);
  expect(calendarLineOf(filing, "ECE 555 Lecture")).toBe("research");
  expect(calendarLineOf(filing, "Dentist")).toBeUndefined();
  expect(calendarLineOf(filing, "ECE 548 Midterm")).toBeUndefined();
  // Filed once: nothing is asked again.
  expect(unfiledCalendarEvents(store, ws)).toEqual([]);
  expect(store.getSetting(ws, CALENDAR_LINES)).toBeTruthy();

  // A renamed line changes what the answers were made against: every event is filed again.
  store.setSetting(ws, LINE_SETTING, JSON.stringify([{ id: "research", label: "科研者", color: "research", goal: "", goals: [] }]));
  expect(unfiledCalendarEvents(store, ws)).toHaveLength(3);
  store.close();
});
