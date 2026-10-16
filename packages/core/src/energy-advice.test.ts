import { describe, expect, test } from "vitest";
import {
  adviceChanges, adviceId, adviceProfiles, applyAdvice, energyAdviceRule, levelRanges, readEnergyAdvice, settledReports, validateEnergyAdviceReview,
  withAdjustments, workedRhythm, type AdviceGrid
} from "./energy-advice";
import { structuredOutputProblems } from "./structured-output";
import { ENERGY_ADVICE_REVIEW_SCHEMA } from "./energy-advice";

const now = "2026-10-15T15:00:00Z";
const zone = "America/Chicago";
const none = workedRhythm([], zone, now);

/** Four weeks of nights in Chicago (UTC−5 in October): workdays `work`, weekends `free`, each [sleep, wake] local hours. */
function nights(work: [number, number], free: [number, number]) {
  return Array.from({ length: 27 }, (_, index) => {
    const day = new Date(Date.parse("2026-09-19T12:00:00Z") + index * 86_400_000);
    const weekday = day.getUTCDay();
    const [sleep, wake] = weekday === 0 || weekday === 6 ? free : work;
    const wakeAt = Date.parse(`${day.toISOString().slice(0, 10)}T00:00:00Z`) + (wake + 5) * 3_600_000;
    const hours = (wake + 24 - sleep) % 24;
    return { sleepAt: new Date(wakeAt - hours * 3_600_000).toISOString(), wakeAt: new Date(wakeAt).toISOString(), source: "ios-health" };
  });
}
const firstHigh = (levels: AdviceGrid) => levels[2]!.indexOf(3);

describe("energy advice rule", () => {
  test("without sleep or reports it says what it needs instead of advising from the generic curve", () => {
    const rule = energyAdviceRule({ now, zone, episodes: [], reports: [], worked: none });
    expect(rule).toMatchObject({ insufficient: expect.stringContaining("3 晚睡眠记录") });
  });

  test("a correction within ten minutes replaces the report before it", () => {
    expect(settledReports([{ at: "2026-10-07T22:04:23Z", level: "low" }, { at: "2026-10-07T22:04:25Z", level: "high" }]))
      .toEqual([{ at: "2026-10-07T22:04:25Z", level: "high" }]);
  });

  test("two agreeing reports set their two-hour band, over the model", () => {
    const rule = energyAdviceRule({ now, zone, episodes: [], worked: none,
      reports: [{ at: "2026-10-07T13:10:00Z", level: "low" }, { at: "2026-10-09T13:40:00Z", level: "low" }] });
    if (!("levels" in rule)) throw new Error("expected advice");
    // 8:10 and 8:40 in Chicago: the 8–10 band is low on every day.
    for (let slot = 16; slot < 20; slot += 1) expect(rule.levels[3]![slot]).toBe(1);
    expect(rule.evidence.reportBands).toEqual([{ from: 8, to: 10, level: "low", count: 2 }]);
    expect(rule.basis.join("；")).toContain("8–10 时按本人 2 次自评定为低精力");
  });

  test("a late sleeper's best hours come later, the phase taken from sleep timing, with workdays and free days apart", () => {
    const early = energyAdviceRule({ now, zone, episodes: nights([22.5, 6.5], [23, 7.5]), reports: [], worked: none });
    const late = energyAdviceRule({ now, zone, episodes: nights([1, 9], [2.5, 10.5]), reports: [], worked: none });
    if (!("levels" in early) || !("levels" in late)) throw new Error("expected advice");
    expect(firstHigh(late.levels)).toBeGreaterThan(firstHigh(early.levels));
    expect(late.evidence.chronotype?.label).toBe("偏晚型");
    expect(late.evidence.phaseShift).toBeGreaterThan(early.evidence.phaseShift);
    // Asleep half hours carry no advice; the free-day row follows the later free-day night.
    expect(late.levels[2]!.slice(2, 18).every((level) => level === 0)).toBe(true);
    expect(late.levels[6]![19]).toBe(0);
    expect(late.summary).toMatch(/^按近四周 27 晚睡眠（通常 1:00 入睡、9:00 醒）：工作日高精力 /);
    const profiles = adviceProfiles(late.levels);
    expect(profiles[0]!.high.length).toBeGreaterThan(0);
    expect(profiles[1]!.days).toBe("free");
  });

  test("with no night on record the person's stated best hours place the peak; recorded nights outrank them", () => {
    const reports = [{ at: "2026-10-07T21:30:00Z", level: "high" as const }, { at: "2026-10-09T22:00:00Z", level: "high" as const }];
    const stated = energyAdviceRule({ now, zone, episodes: [], reports, worked: none, statedPeak: { start: 9, end: 12 } });
    const generic = energyAdviceRule({ now, zone, episodes: [], reports, worked: none });
    if (!("levels" in stated) || !("levels" in generic)) throw new Error("expected advice");
    expect(stated.evidence.phaseSource).toBe("stated");
    expect(firstHigh(stated.levels)).toBeLessThan(firstHigh(generic.levels));
    expect(stated.basis[2]).toContain("按本人所述高效时段");
    const measured = energyAdviceRule({ now, zone, episodes: nights([23.5, 7.5], [23.5, 7.5]), reports: [], worked: none, statedPeak: { start: 9, end: 12 } });
    expect(measured.evidence.phaseSource).toBe("chronotype");
  });

  test("timed work in an hour read as low is flagged, not used to raise it", () => {
    const sessions = Array.from({ length: 5 }, (_, index) => ({ startedAt: `2026-10-0${index + 5}T12:30:00Z`, endedAt: `2026-10-0${index + 5}T13:30:00Z` }));
    const worked = workedRhythm(sessions, zone, now);
    expect(worked[1]![7]).toBe(30);
    const rule = energyAdviceRule({ now, zone, episodes: nights([23.5, 7.5], [23.5, 7.5]), reports: [], worked });
    if (!("levels" in rule)) throw new Error("expected advice");
    expect(rule.levels[1]![15]).toBe(1);
    expect(rule.evidence.workedInLow).toEqual([7, 8]);
    expect(rule.basis.at(-1)).toContain("7 时、8 时常有计时工作");
  });
});

describe("applying and adjusting advice", () => {
  const grid = (fill: (day: number, slot: number) => number): AdviceGrid => Array.from({ length: 7 }, (_, day) => Array.from({ length: 48 }, (_, slot) => fill(day, slot)));
  test("only the person's available cells change, and only their level", () => {
    const current = grid((_, slot) => slot >= 18 && slot < 24 ? 3 : 0);
    const advice = grid((_, slot) => slot >= 14 && slot < 20 ? 1 : slot >= 20 && slot < 46 ? 2 : 0);
    const applied = applyAdvice(current, advice);
    expect(applied[1]!.slice(16, 26)).toEqual([0, 0, 1, 1, 2, 2, 2, 2, 0, 0]);
    expect(adviceChanges(advice, current)).toEqual({ cells: 42, raised: 0, lowered: 42 });
    expect(adviceChanges(advice, applied).cells).toBe(0);
    expect(adviceId(advice)).toMatch(/^[0-9a-f]{8}$/);
    expect(adviceId(advice)).not.toBe(adviceId(current));
  });

  test("an adjustment moves at most one level from the rule and never into sleep", () => {
    const rule = grid((_, slot) => slot < 14 ? 0 : 1);
    const { levels, applied } = withAdjustments(rule, [{ days: "workdays", start: "06:00", end: "09:00", level: "high", why: "x", sourceIds: ["s1"] }]);
    expect(applied).toBe(1);
    expect(levels[1]!.slice(12, 18)).toEqual([0, 0, 2, 2, 2, 2]);
    expect(levels[0]![14]).toBe(1);
  });

  test("ranges read 24:00 at the end of the day", () => {
    expect(levelRanges([...Array(44).fill(0), 3, 3, 3, 3], 3)).toEqual(["22:00–24:00"]);
  });

  test("stored advice is read back only in shape", () => {
    expect(readEnergyAdvice("{")).toBeNull();
    expect(readEnergyAdvice(JSON.stringify({ computedAt: now, insufficient: "x", evidence: {} }))).toMatchObject({ insufficient: "x" });
    expect(readEnergyAdvice(JSON.stringify({ computedAt: now, levels: [[1]], ruleLevels: [[1]] }))).toBeNull();
  });
});

describe("the review's contract", () => {
  const ok = { verdict: "adjust", summary: "午后低谷证据较强，下调 13:30–15:00。", findings: [{ claim: "午后存在警觉低谷", sourceIds: ["s1"] }],
    adjustments: [{ days: "workdays", start: "13:30", end: "15:00", level: "low", why: "午后低谷", sourceIds: ["s1"] }],
    sources: [{ id: "s1", url: "https://example.org/dip", title: "Post-lunch dip" }] };
  test("the schema keeps to strict structured output", () => {
    expect(structuredOutputProblems(ENERGY_ADVICE_REVIEW_SCHEMA)).toEqual([]);
  });
  test("refuses uncited claims, non-https pages, empty adjustments and the second person", () => {
    expect(validateEnergyAdviceReview(ok).adjustments).toHaveLength(1);
    expect(() => validateEnergyAdviceReview({ ...ok, findings: [{ claim: "午后低谷", sourceIds: ["s9"] }] })).toThrow("ENERGY_REVIEW_UNKNOWN_SOURCE");
    expect(() => validateEnergyAdviceReview({ ...ok, sources: [{ id: "s1", url: "http://example.org", title: "x x" }] })).toThrow("NOT_HTTPS");
    expect(() => validateEnergyAdviceReview({ ...ok, adjustments: [] })).toThrow("ADJUST_EMPTY");
    expect(() => validateEnergyAdviceReview({ ...ok, verdict: "agree" })).toThrow("ADJUST_UNEXPECTED");
    expect(() => validateEnergyAdviceReview({ ...ok, summary: "你的午后偏低" })).toThrow("ENERGY_REVIEW_PERSON");
    // The same in English: third person only.
    expect(() => validateEnergyAdviceReview({ ...ok, summary: "Your afternoons run low" })).toThrow("ENERGY_REVIEW_PERSON");
    expect(() => validateEnergyAdviceReview({ ...ok, summary: "I would lower 13:30–15:00" })).toThrow("ENERGY_REVIEW_PERSON");
    expect(validateEnergyAdviceReview({ ...ok, summary: "The post-lunch dip is well supported; 13:30–15:00 lowered." }).verdict).toBe("adjust");
    expect(() => validateEnergyAdviceReview({ ...ok, adjustments: [{ ...ok.adjustments[0], start: "15:00", end: "13:30" }] })).toThrow("RANGE_INVALID");
  });
});
