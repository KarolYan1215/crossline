import { describe, expect, test } from "vitest";
import {
  asPlannedOutcome, dayCapacityMinutes, inferBlockOutcome, measuredCapacity, measuredWeeklyHours, measuredWorkDays, mergeSpans, type MeasuredDay
} from "./measured-capacity";

const H = 3_600_000, M = 60_000;
// UTC midnights stand in for local ones: the zone's arithmetic is the caller's.
const at = (day: string, hour: number, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * H + minute * M;
const starts = (days: string[]) => [...days, nextDay(days.at(-1)!)].map((day) => ({ day, start: Date.parse(`${day}T00:00:00Z`) }));
const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const day = (date: string, minutes: number, missing = false): MeasuredDay => ({ day: date, minutes, missing, bySource: { timer: minutes, screen: 0, agent: 0 }, fileChanges: 0 });

describe("measured work minutes", () => {
  test("signals are joined in time: an hour timed while the screen shows the same hour of writing counts once", () => {
    const [d] = measuredWorkDays({
      timer: [{ start: at("2026-11-02", 9), end: at("2026-11-02", 10) }],
      screen: [{ start: at("2026-11-02", 9, 30), end: at("2026-11-02", 11) }],
      agent: [{ start: at("2026-11-02", 14), end: at("2026-11-02", 14, 30) }]
    }, starts(["2026-11-02"]));
    expect(d!.minutes).toBe(150);
    expect(d!.bySource).toEqual({ timer: 60, screen: 90, agent: 30 });
    expect(d!.missing).toBe(false);
  });

  test("a day without any signal is missing, not zero; a confirmation alone makes it a day of zero minutes", () => {
    const days = measuredWorkDays({ timer: [], screen: [], agent: [], confirmedDays: ["2026-11-03"] }, starts(["2026-11-02", "2026-11-03"]));
    expect(days.map((item) => [item.minutes, item.missing])).toEqual([[0, true], [0, false]]);
  });

  test("file changes are evidence only: counted on their day, never minutes, and alone they do not make a day present", () => {
    const [d] = measuredWorkDays({ timer: [], screen: [], agent: [], fileChanges: [at("2026-11-02", 15)] }, starts(["2026-11-02"]));
    expect(d).toMatchObject({ minutes: 0, missing: true, fileChanges: 1 });
  });

  test("hourly active minutes stand in only on a day with no screen segment at all", () => {
    const hourly = [{ start: new Date(at("2026-11-02", 9)).toISOString(), active: 40 }, { start: new Date(at("2026-11-03", 9)).toISOString(), active: 40 }];
    const days = measuredWorkDays({ timer: [], screen: [], agent: [], hourly, segmentDays: ["2026-11-03"] }, starts(["2026-11-02", "2026-11-03"]));
    expect(days.map((item) => item.minutes)).toEqual([40, 0]);
  });

  test("spans across midnight are split between the two days", () => {
    const days = measuredWorkDays({ timer: [{ start: at("2026-11-02", 23), end: at("2026-11-03", 1) }], screen: [], agent: [] }, starts(["2026-11-02", "2026-11-03"]));
    expect(days.map((item) => item.minutes)).toEqual([60, 60]);
    expect(mergeSpans([{ start: 5, end: 9 }, { start: 1, end: 6 }, { start: 12, end: 13 }])).toEqual([{ start: 1, end: 9 }, { start: 12, end: 13 }]);
  });
});

describe("capacity", () => {
  // 2026-11-02 is a Monday.
  const weekdays = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
  test("the median of five or more same-kind days with a signal, times 1.25; missing days are left out", () => {
    const days = [...weekdays.map((date, index) => day(date, [120, 180, 200, 240, 600][index]!)), day("2026-11-09", 0, true), day("2026-11-07", 30)];
    const capacity = measuredCapacity(days, { hasScreen: false });
    expect(capacity.weekday).toEqual({ basis: "measured", samples: 5, median: 200, minutes: 250 });
    // One weekend day and no screen: still the stated hours at half.
    expect(capacity.weekend.basis).toBe("stated");
    expect(dayCapacityMinutes(capacity, "2026-11-08", 600)).toBe(300);
    expect(dayCapacityMinutes(capacity, "2026-11-10", 600)).toBe(250);
  });

  test("at least an hour a day", () => {
    const capacity = measuredCapacity(weekdays.map((date) => day(date, 10)), { hasScreen: false });
    expect(capacity.weekday.minutes).toBe(60);
  });

  test("cold start: with the screen connected the first day counts; without it, five days are needed", () => {
    const two = [day("2026-11-02", 100), day("2026-11-03", 200)];
    expect(measuredCapacity(two, { hasScreen: true }).weekday).toMatchObject({ basis: "screen", minutes: 188 });
    expect(measuredCapacity(two, { hasScreen: false }).weekday).toMatchObject({ basis: "stated", samples: 2 });
  });

  test("the typical measured week", () => {
    expect(measuredWeeklyHours([day("2026-11-02", 180), day("2026-11-03", 0, true), day("2026-11-04", 60)])).toBe(14);
    expect(measuredWeeklyHours([day("2026-11-02", 0, true)])).toBeUndefined();
  });
});

describe("one block", () => {
  test("60% or more worked is done, under 20% probably not done, between is partial", () => {
    expect(inferBlockOutcome(36, 60)).toBe("done");
    expect(inferBlockOutcome(30, 60)).toBe("partial");
    expect(inferBlockOutcome(11, 60)).toBe("not_done");
    expect(inferBlockOutcome(0, 0)).toBe("not_done");
  });
  test("按预估完成 records under 70% of the planned minutes as partial", () => {
    expect(asPlannedOutcome(41, 60)).toBe("partial");
    expect(asPlannedOutcome(42, 60)).toBe("done");
  });
});
