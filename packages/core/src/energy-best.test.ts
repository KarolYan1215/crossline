import { describe, expect, test } from "vitest";
import { DEFAULT_AVAILABILITY, availabilityFromHours, type AvailabilityWindow } from "./availability";
import { WORKDAYS, bestWindows, dayLevels, statedBands, statedEnergyWindows } from "./energy-best";
import { energyAdviceRule, levelRanges, workedRhythm } from "./energy-advice";
import { DEFAULT_CALIBRATION, priorPhase } from "./energy-model";
import { energyRhythm } from "./energy-rhythm";
import type { EnergyLevel } from "./index";

const now = "2026-11-20T12:00:00Z";
const utcHour = (iso: string) => { const date = new Date(iso); return date.getUTCHours() + date.getUTCMinutes() / 60; };
const weekday = (iso: string) => new Date(iso).getUTCDay() || 7;
const overlaps = (window: { start: number; end: number }, from: number, to: number) => window.start < to && window.end > from;
const range = (window: { start: number; end: number }) => `${Math.floor(window.start)}:${window.start % 1 ? "30" : "00"}–${Math.floor(window.end)}:${window.end % 1 ? "30" : "00"}`;

describe("best hours from what the person said (W-265)", () => {
  // The tester: sleeps 1:00–9:00, most tired 10–13, clearest 18–23 (the interview's pattern, every day).
  const all = [0, 1, 2, 3, 4, 5, 6];
  const tester: AvailabilityWindow[] = [{ days: all, start: "10:00", end: "13:00", energy: "low" },
    { days: all, start: "14:00", end: "18:00", energy: "medium" }, { days: all, start: "18:00", end: "23:00", energy: "high" }];
  const night = { from: 25, to: 9 };
  const phaseShift = priorPhase({ midSleep: { hours: 5, source: "sleep" } }).shift;
  const rhythm = (statedEnergy = statedBands(statedEnergyWindows({ windows: tester, source: "interview" }), WORKDAYS),
    reports: Array<{ at: string; level: EnergyLevel }> = []) =>
    energyRhythm({ episodes: [], hourOf: utcHour, weekdayOf: weekday, phaseShift, calibration: DEFAULT_CALIBRATION, reports, now, stated: night, statedEnergy });

  test("stated 18–23 clearest and 10–13 most tired: the best hours are the evening, never 11–14 and never a stated low hour", () => {
    // The model alone put the best hours in the stated tired stretch (the portrait said 11:00–14:00).
    expect(overlaps(rhythm([]).peak, 11, 14)).toBe(true);
    const said = rhythm();
    expect(said.bestFrom).toBe("self");
    expect(said.best).toEqual([{ start: 18, end: 23 }]);
    for (const window of said.best) { expect(overlaps(window, 11, 14)).toBe(false); expect(overlaps(window, 10, 13)).toBe(false); }
    // The model's own peak is kept for what reads it, but it is not what is shown.
    expect(said.peak).toEqual(rhythm([]).peak);
  });

  test("two two-hour bands of high self-ratings: both are best hours, and the plan page's advice names the same hours", () => {
    const at = (day: number, hour: number) => new Date(Date.parse("2026-11-02T00:00:00Z") + day * 86_400_000 + hour * 3_600_000).toISOString();
    const reports = [at(0, 10.25), at(2, 11.5), at(1, 16.5), at(3, 17.25)].map((iso) => ({ at: iso, level: "high" as const }));
    const portrait = energyRhythm({ episodes: [], hourOf: utcHour, weekdayOf: weekday, phaseShift: 0, calibration: DEFAULT_CALIBRATION, reports, now });
    expect(portrait.bestFrom).toBe("self");
    expect(portrait.best.some((window) => window.start <= 10 && window.end >= 12)).toBe(true);
    expect(portrait.best.some((window) => window.start <= 16 && window.end >= 18)).toBe(true);
    const advice = energyAdviceRule({ now, zone: "UTC", episodes: [], reports, worked: workedRhythm([], "UTC", now) });
    if ("insufficient" in advice) throw new Error(advice.insufficient);
    expect(levelRanges(advice.levels[1]!, 3)).toEqual(portrait.best.map(range));
  });

  test("the advice takes the stated levels the same way: high 18–23, the stated tired hours low", () => {
    const at = (day: number) => new Date(Date.parse("2026-11-02T20:00:00Z") + day * 86_400_000).toISOString();
    const advice = energyAdviceRule({ now, zone: "UTC", episodes: [], worked: workedRhythm([], "UTC", now), statedWindows: tester,
      reports: [{ at: at(0), level: "high" }, { at: at(1), level: "high" }] });
    if ("insufficient" in advice) throw new Error(advice.insufficient);
    expect(levelRanges(advice.levels[1]!, 3)).toEqual(["18:00–23:00"]);
    expect(advice.levels[1]!.slice(20, 26).every((level) => level === 1)).toBe(true);
    expect(advice.basis.join(" ")).toContain("工作日按本人所述精力：");
  });

  test("with nothing said, the best hours are the model's three, as before", () => {
    const plain = energyRhythm({ episodes: [], hourOf: utcHour, weekdayOf: weekday, phaseShift: 0, calibration: DEFAULT_CALIBRATION, reports: [], now });
    expect(plain.bestFrom).toBe("model");
    expect(plain.best).toEqual([plain.peak]);
    expect(plain.peak.end - plain.peak.start).toBe(3);
    // One report, or reports older than eight weeks, are not a band the person agreed on.
    const single = energyRhythm({ episodes: [], hourOf: utcHour, weekdayOf: weekday, phaseShift: 0, calibration: DEFAULT_CALIBRATION, now,
      reports: [{ at: "2026-11-18T20:00:00Z", level: "high" }] });
    expect(single.best).toEqual([plain.peak]);
    // The advice's levels with nothing said are the model's ranked quarters, unchanged.
    const curve = Array.from({ length: 48 }, (_, slot) => (slot < 16 ? null : 10 - Math.abs(slot - 22)));
    expect(dayLevels(curve, { stated: [], reports: [] }).filter((level) => level === 3).length).toBe(8);
  });

  test("only levels the person stated count: not the default pattern nor one spread from weekly hours", () => {
    expect(statedEnergyWindows({ windows: DEFAULT_AVAILABILITY, source: "default" })).toEqual([]);
    expect(statedEnergyWindows({ windows: DEFAULT_AVAILABILITY, source: "saved" })).toEqual([]);
    expect(statedEnergyWindows({ windows: availabilityFromHours(50), source: "stated_hours" })).toEqual([]);
    expect(statedEnergyWindows({ windows: tester, source: "saved" })).toEqual(tester);
    expect(statedBands([{ days: [0, 6], start: "08:00", end: "10:30", energy: "high" }], WORKDAYS)).toEqual([]);
    expect(bestWindows([0, 0, 2, 2, 3, 3, 2, 3, 3])).toEqual([{ start: 2, end: 3 }, { start: 3.5, end: 4.5 }]);
  });
});
