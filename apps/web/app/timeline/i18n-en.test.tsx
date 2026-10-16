import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { LocaleProvider } from "../locale-context";
import type { TimelineItem } from "./model";
import { clip, dayWithWeekday, minutesText, monthLabel } from "./format";
import { hoursLabel } from "./panel-model";
import { DayTimeline, MonthView, WeekView } from "./views";
import { CalendarPanel } from "./calendar-panel";

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({ id: "scheduled:wo-1", title: "Draft the review", day: "2026-10-12", start: "14:00", end: "15:30",
  kind: "scheduled", workOrderId: "wo-1", identityId: "research", source: "排程", readOnly: false, ...over });

describe("durations and dates in both languages", () => {
  test("Chinese reads exactly as before; English is 45 min, 1 h 30 min, Oct", () => {
    expect([minutesText(undefined, 45), minutesText(undefined, 60), minutesText(undefined, 90)]).toEqual(["45 分", "1 小时", "1 时 30 分"]);
    expect([minutesText("en", 45), minutesText("en", 60), minutesText("en", 90)]).toEqual(["45 min", "1 h", "1 h 30 min"]);
    expect([hoursLabel(90), hoursLabel(90, "en")]).toEqual(["1.5 小时", "1.5 h"]);
    expect([monthLabel("zh", 2026, 10), monthLabel("zh", 2026, 10, true), monthLabel("en", 2026, 10), monthLabel("en", 2027, 1, true)])
      .toEqual(["10月", "2026年10月", "Oct", "Jan 2027"]);
    expect([dayWithWeekday("zh", "2026-10-14"), dayWithWeekday("en", "2026-10-14")]).toEqual(["10/14 周三", "Wed 10/14"]);
  });

  test("a label is cut by characters in Chinese and by drawn width in English, so English keeps about twice as many letters", () => {
    expect(clip("zh", "成为神经形态计算方向能独立立项的研究者", 16)).toBe("成为神经形态计算方向能独立立项…");
    const english = clip("en", "Become a researcher who can run an independent project in neuromorphic computing", 16);
    expect(english.endsWith("…")).toBe(true);
    expect(english.length).toBeGreaterThan(20);
  });
});

describe("the calendar in English", () => {
  test("the day view names its parts and writes durations in English; tags from the schedule are translated", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><DayTimeline day="2026-10-12" items={[item({ tag: "预排" })]} deadlines={[]}
      nowMinute={13 * 60} labels={{ research: "Research" }} /></LocaleProvider>);
    expect(html).toContain("1.5 h");
    expect(html).toContain(">Now<");
    expect(html).toContain(">Pencilled in<");
    expect(html).toContain("Timeline for 2026-10-12");
    expect(html).not.toMatch(/[一-鿿]/);
  });

  test("an empty day explains itself in English", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><DayTimeline day="2026-10-12" items={[]} deadlines={[]} nowMinute={undefined} labels={{}} /></LocaleProvider>);
    expect(html).toContain("Nothing planned for this day.");
  });

  test("week and month heads use English weekday names, Monday first", () => {
    const week = renderToStaticMarkup(<LocaleProvider locale="en"><WeekView anchor="2026-10-12" today="2026-10-12" items={[item()]} deadlines={[]} labels={{}} /></LocaleProvider>);
    expect(week).toContain("Mon <b>12</b>");
    expect(week).toContain("Sun <b>18</b>");
    const month = renderToStaticMarkup(<LocaleProvider locale="en"><MonthView anchor="2026-10-12" today="2026-10-12" items={[item()]} deadlines={[]} labels={{}} /></LocaleProvider>);
    expect(month.indexOf(">Mon<")).toBeLessThan(month.indexOf(">Sun<"));
    expect(month).not.toMatch(/[一-鿿]/);
    // Chinese is unchanged.
    expect(renderToStaticMarkup(<WeekView anchor="2026-10-12" today="2026-10-12" items={[]} deadlines={[]} labels={{}} />)).toContain("周一 <b>12</b>");
  });

  test("the panel's head: view tabs, today and the day's title in English", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><CalendarPanel items={[item()]} deadlines={[]} today="2026-10-12" nowIso="2026-10-12T13:00:00.000Z"
      timeZone="UTC" labels={{ research: "Research" }} /></LocaleProvider>);
    expect(html).toContain(">Day<");
    expect(html).toContain(">Week<");
    expect(html).toContain(">Today<");
    expect(html).toContain("Mon, 2026-10-12");
    expect(html).toContain("Load for the day");
  });
});
