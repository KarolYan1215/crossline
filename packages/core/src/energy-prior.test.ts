import { describe, expect, test } from "vitest";
import {
  DEFAULT_AVAILABILITY, DEFAULT_CALIBRATION, DEFAULT_PEAKS, POPULATION_MID_SLEEP, ageFromBirthYear, energyRhythm, inertia, phaseShiftFromAge, phaseShiftFromPeak,
  priorPhase, statedPeakOf, typicalMidSleep, usualMidSleep
} from "./index";

// The prior the model starts from before anything is known about the person (docs/energy-and-ecosystem.md §2.1).
const rhythm = (phaseShift = 0) => energyRhythm({ episodes: [], hourOf: () => 0, weekdayOf: () => 1, phaseShift, calibration: DEFAULT_CALIBRATION, reports: [],
  now: "2026-11-11T12:00:00Z" });
const mean = (curve: Array<{ hour: number; value: number | null }>, from: number, to: number) => {
  const values = curve.filter((point) => point.hour >= from && point.hour < to && point.value !== null).map((point) => point.value!);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

describe("the default adult's day (23:30–7:30, no record)", () => {
  const { curve, peak } = rhythm();

  test("alertness rises through the morning and its best three hours are in the late morning", () => {
    expect(mean(curve, 8, 9)).toBeLessThan(mean(curve, 10, 12));
    expect(peak.start).toBeGreaterThanOrEqual(9);
    expect(peak.start).toBeLessThanOrEqual(11);
  });

  test("the post-lunch dip (13:30–15:00) stands below the late morning and below an early-evening second peak, which then declines", () => {
    expect(mean(curve, 13.5, 15)).toBeLessThan(mean(curve, 10, 12) - 0.5);
    expect(mean(curve, 13.5, 15)).toBeLessThan(mean(curve, 17.5, 19.5) - 0.5);
    expect(mean(curve, 22, 23.5)).toBeLessThan(mean(curve, 17.5, 19.5) - 1.5);
  });

  test("the two good stretches the stated best hours are matched against are where the curve's peaks are", () => {
    const awake = curve.filter((point) => point.value !== null) as Array<{ hour: number; value: number }>;
    const maxima = awake.filter((point, index) => index > 0 && index < awake.length - 1 && point.value >= awake[index - 1]!.value && point.value >= awake[index + 1]!.value)
      .map((point) => point.hour);
    expect(maxima.length).toBeGreaterThanOrEqual(2);
    DEFAULT_PEAKS.forEach((peak) => expect(Math.min(...maxima.map((hour) => Math.abs(hour - peak)))).toBeLessThanOrEqual(0.5));
  });
});

test("sleep inertia fades with Jewett et al. 1999's time constant for cognitive throughput, 1.17 h", () => {
  expect(inertia(1.17) / inertia(0)).toBeCloseTo(Math.exp(-1), 2);
});

describe("age", () => {
  test("typical mid-sleep is latest around 20 and earlier with every decade after (Fischer et al. 2017)", () => {
    expect(typicalMidSleep(20)).toBeGreaterThan(typicalMidSleep(16));
    expect(typicalMidSleep(20)).toBeGreaterThan(typicalMidSleep(30));
    expect(typicalMidSleep(30)).toBeGreaterThan(typicalMidSleep(50));
    expect(typicalMidSleep(50)).toBeGreaterThan(typicalMidSleep(70));
  });

  test("a 20-year-old's best hours come later than a 50-year-old's", () => {
    const young = rhythm(phaseShiftFromAge(20)), older = rhythm(phaseShiftFromAge(50));
    // 1.45 h apart, read on the curve's half-hour grid.
    expect(young.peak.start).toBeGreaterThanOrEqual(older.peak.start + 1);
    expect(young.sleep.from).toBeGreaterThan(older.sleep.from);
  });

  test("with no age the default is unchanged: the population's mean mid-sleep is the default night's to within five minutes", () => {
    expect(Math.abs(POPULATION_MID_SLEEP - 3.5)).toBeLessThan(5 / 60);
    expect(priorPhase({})).toEqual({ shift: 0, source: "default" });
  });

  test("the age comes from a birth year the person gave, and nothing else", () => {
    expect(ageFromBirthYear("1996", "2026-11-11T00:00:00Z")).toBe(30);
    expect(ageFromBirthYear(null, "2026-11-11T00:00:00Z")).toBeUndefined();
    expect(ageFromBirthYear("2030", "2026-11-11T00:00:00Z")).toBeUndefined();
    expect(ageFromBirthYear("abc", "2026-11-11T00:00:00Z")).toBeUndefined();
  });
});

describe("where the phase comes from", () => {
  test("measured sleep timing outranks stated best hours, which outrank age", () => {
    expect(priorPhase({ midSleep: { hours: 5.5, source: "chronotype" }, statedPeak: { start: 9, end: 12 }, age: 60 })).toEqual({ shift: 2, source: "chronotype" });
    expect(priorPhase({ statedPeak: { start: 7, end: 10 }, age: 20 }).source).toBe("stated");
    expect(priorPhase({ age: 20 })).toEqual({ shift: phaseShiftFromAge(20), source: "age" });
    expect(phaseShiftFromAge(20)).toBeGreaterThan(1);
    expect(phaseShiftFromAge(50)).toBeLessThan(0);
  });

  test("the default availability pattern states no best hours; a pattern the person changed does", () => {
    expect(statedPeakOf(DEFAULT_AVAILABILITY)).toBeNull();
    expect(statedPeakOf([{ days: [1, 2, 3, 4, 5], start: "07:30", end: "10:00", energy: "high" }])).toEqual({ start: 7.5, end: 10 });
  });

  test("sleep timing: MSF_sc with workday and free-day nights, else the median night, else the stated night", () => {
    const utcHour = (iso: string) => new Date(iso).getUTCHours() + new Date(iso).getUTCMinutes() / 60;
    const isoWeekday = (iso: string) => new Date(iso).getUTCDay() || 7;
    // 1:00–9:00 every night of four weeks ending 2026-11-11 (a Wednesday).
    const late = Array.from({ length: 28 }, (_, index) => {
      const wake = Date.parse("2026-11-11T09:00:00Z") - index * 86_400_000;
      return { sleepAt: new Date(wake - 8 * 3_600_000).toISOString(), wakeAt: new Date(wake).toISOString(), source: "ios-health" };
    });
    const now = "2026-11-11T12:00:00Z";
    expect(usualMidSleep({ episodes: late, hourOf: utcHour, weekdayOf: isoWeekday, now })).toEqual({ hours: 5, source: "chronotype" });
    expect(usualMidSleep({ episodes: late.slice(0, 3), hourOf: utcHour, weekdayOf: isoWeekday, now })).toEqual({ hours: 5, source: "sleep" });
    expect(usualMidSleep({ episodes: [], hourOf: utcHour, weekdayOf: isoWeekday, now, stated: { from: 23, to: 7 } })).toEqual({ hours: 3, source: "sleep" });
    expect(usualMidSleep({ episodes: [], hourOf: utcHour, weekdayOf: isoWeekday, now })).toBeUndefined();
  });

  test("best hours of 9–12 (the default pattern's) move the phase by under an hour, not to the six-hour limit", () => {
    expect(Math.abs(phaseShiftFromPeak(9, 12))).toBeLessThan(1);
    // Stated best hours land the curve's nearest peak on them.
    const shift = phaseShiftFromPeak(7, 10);
    expect(shift).toBeLessThan(-1);
    const curve = rhythm(shift);
    expect(Math.abs(curve.peak.start - 7)).toBeLessThanOrEqual(1);
  });
});
