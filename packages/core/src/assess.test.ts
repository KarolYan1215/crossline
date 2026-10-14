import { describe, expect, test } from "vitest";
import { QUIZ_ITEMS, clockHours, mctqLite, pvtIsi, pvtSummary, quizScores, quizType } from "./assess";
import { TYPE_AXES, portraitType, typeFromScores } from "./portrait-type";
import { DEFAULT_CALIBRATION } from "./energy-model";
import { energyRhythm } from "./energy-rhythm";

const all = (value: number) => Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, value]));

describe("quiz", () => {
  test("four statements per axis, two keyed to each pole", () => {
    for (const axis of TYPE_AXES) {
      const items = QUIZ_ITEMS.filter((item) => item.axis === axis.id);
      expect(items).toHaveLength(4);
      expect(items.filter((item) => item.reverse)).toHaveLength(2);
    }
    expect(new Set(QUIZ_ITEMS.map((item) => item.id)).size).toBe(16);
  });

  test("agreeing with everything cancels out on every axis; reversed statements are keyed the other way", () => {
    expect(quizScores(all(5))).toEqual({ scope: 50, basis: 50, output: 50, rhythm: 50 });
    // Agree with the right-keyed statements, disagree with the reversed ones: every axis at its right pole.
    const right = Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, item.reverse ? 1 : 5]));
    expect(quizScores(right)).toEqual({ scope: 100, basis: 100, output: 100, rhythm: 100 });
    expect(quizType(right).code).toBe("GIRA");
    const left = Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, item.reverse ? 5 : 1]));
    expect(quizType(left).code).toBe("SEMP");
  });

  test("a single axis moves only with its own statements", () => {
    const answers = all(3);
    for (const item of QUIZ_ITEMS.filter((entry) => entry.axis === "basis")) answers[item.id] = item.reverse ? 2 : 4;
    expect(quizScores(answers)).toEqual({ scope: 50, basis: 75, output: 50, rhythm: 50 });
  });

  test("an unanswered or out-of-range statement is refused", () => {
    const answers = all(3);
    delete answers.q7;
    expect(() => quizScores(answers)).toThrow(/QUIZ_INCOMPLETE: q7/);
    expect(() => quizScores({ ...all(3), q1: 6 })).toThrow(/QUIZ_INCOMPLETE: q1/);
  });

  test("the portrait's type and the quiz's type are the same reading of the same scores", () => {
    const scores = { scope: 20, basis: 80, output: 50, rhythm: 49 };
    const report = { type: { ...scores, evidence: { scope: "因为", basis: "", output: "", rhythm: "" } } } as unknown as Parameters<typeof portraitType>[0];
    expect(portraitType(report)).toEqual(typeFromScores(scores, report.type!.evidence));
    expect(typeFromScores(scores).code).toBe("SIRP");
    expect(typeFromScores(scores).axes.map((axis) => axis.percent)).toEqual([80, 80, 50, 51]);
  });
});

describe("MCTQ lite", () => {
  test("clock parsing", () => {
    expect(clockHours("23:30")).toBe(23.5);
    expect(clockHours("7:05")).toBeCloseTo(7.0833, 3);
    expect(clockHours("24:00")).toBeNaN();
    expect(clockHours("7h")).toBeNaN();
  });

  test("mid-sleep, the sleep-debt correction and signed social jetlag, as the mctq package computes them", () => {
    // Workdays 23:00–7:00 (8 h, mid 3:00); free days 1:00–10:00 (9 h, mid 5:30).
    const result = mctqLite({ workdays: 5, work: { sleep: "23:00", wake: "7:00" }, free: { sleep: "1:00", wake: "10:00" } });
    expect(result.sdWork).toBe(8);
    expect(result.sdFree).toBe(9);
    expect(result.sdWeek).toBeCloseTo((8 * 5 + 9 * 2) / 7, 6);
    expect(result.msw).toBe(3);
    expect(result.msf).toBe(5.5);
    // MSF_sc = MSF − (SD_f − SD_week)/2
    expect(result.msfSc).toBeCloseTo(5.5 - (9 - 58 / 7) / 2, 6);
    expect(result.sjlRel).toBe(2.5);
    expect(result.sjl).toBe(2.5);
    expect(result.chronotype).toBe("late");
  });

  test("no correction when free-day sleep is not longer; an alarm on free days leaves MSF_sc unknown", () => {
    const same = mctqLite({ workdays: 5, work: { sleep: "22:00", wake: "6:00" }, free: { sleep: "22:30", wake: "6:00" } });
    expect(same.msfSc).toBe(same.msf);
    expect(same.chronotype).toBe("early");
    expect(mctqLite({ workdays: 5, work: { sleep: "22:00", wake: "6:00" }, free: { sleep: "0:00", wake: "9:00", alarm: true } }).msfSc).toBeNull();
  });

  test("social jetlag is taken the shorter way round midnight and keeps its sign", () => {
    // Free days earlier than workdays: mid 23:30 against 0:30.
    const result = mctqLite({ workdays: 5, work: { sleep: "20:30", wake: "4:30" }, free: { sleep: "19:30", wake: "3:30" } });
    expect(result.msw).toBe(0.5);
    expect(result.msf).toBe(23.5);
    expect(result.sjlRel).toBe(-1);
    expect(result.sjl).toBe(1);
  });

  test("malformed input is refused", () => {
    expect(() => mctqLite({ workdays: 8, work: { sleep: "23:00", wake: "7:00" }, free: { sleep: "1:00", wake: "10:00" } })).toThrow("MCTQ_INVALID");
    expect(() => mctqLite({ workdays: 5, work: { sleep: "late", wake: "7:00" }, free: { sleep: "1:00", wake: "10:00" } })).toThrow("MCTQ_INVALID");
  });
});

describe("PVT-B", () => {
  test("lapses at 355 ms or a timeout, false starts under 100 ms or before the stimulus, median and speed over valid responses", () => {
    const trials = [{ rtMs: 250 }, { rtMs: 300 }, { rtMs: 354 }, { rtMs: 355 }, { rtMs: 500 }, { rtMs: 80 }, { rtMs: null }];
    const summary = pvtSummary(trials, 2);
    expect(summary).toMatchObject({ stimuli: 7, valid: 5, medianRt: 354, lapses: 3, falseStarts: 3, reliable: false });
    expect(summary.meanSpeed).toBeCloseTo((1000 / 250 + 1000 / 300 + 1000 / 354 + 1000 / 355 + 1000 / 500) / 5, 2);
    expect(pvtSummary([{ rtMs: 200 }, { rtMs: 300 }]).medianRt).toBe(250);
    expect(pvtSummary([]).medianRt).toBeNull();
    expect(pvtSummary(Array.from({ length: 20 }, () => ({ rtMs: 260 }))).reliable).toBe(true);
  });

  test("the wait between stimuli is 2–5 s", () => {
    expect(pvtIsi(0)).toBe(2000);
    expect(pvtIsi(0.999999)).toBe(5000);
  });
});

describe("energy rhythm", () => {
  const zone = (iso: string) => { const date = new Date(iso); return date.getUTCHours() + date.getUTCMinutes() / 60; };
  const weekday = (iso: string) => { const day = new Date(iso).getUTCDay(); return day === 0 ? 7 : day; };
  const now = "2026-10-14T12:00:00Z";

  test("with no sleep on record the usual night is 23:30–7:30, asleep hours carry no value and the peak is three waking hours", () => {
    const rhythm = energyRhythm({ episodes: [], hourOf: zone, weekdayOf: weekday, phaseShift: 0, calibration: DEFAULT_CALIBRATION, reports: [], now });
    expect(rhythm.sleep).toEqual({ from: 23.5, to: 7.5 });
    expect(rhythm.curve).toHaveLength(49);
    expect(rhythm.curve.find((point) => point.hour === 3)!.value).toBeNull();
    expect(rhythm.curve.find((point) => point.hour === 12)!.value).not.toBeNull();
    expect(rhythm.peak.end - rhythm.peak.start).toBe(3);
    expect(rhythm.peak.start).toBeGreaterThanOrEqual(7.5);
    expect(rhythm.peak.end).toBeLessThanOrEqual(23.5);
    expect(rhythm.nights).toBe(0);
    expect(rhythm.chronotype).toBeNull();
  });

  test("a late sleeper's usual night and chronotype come from their own nights; an earlier phase moves the peak earlier", () => {
    // Workdays 0:30–8:00, weekends 2:00–10:30, four weeks.
    const episodes = Array.from({ length: 28 }, (_, index) => {
      const day = new Date(Date.parse("2026-09-16T00:00:00Z") + index * 86_400_000);
      const free = day.getUTCDay() === 0 || day.getUTCDay() === 6;
      const date = day.toISOString().slice(0, 10);
      return { sleepAt: `${date}T${free ? "02:00" : "00:30"}:00.000Z`, wakeAt: `${date}T${free ? "10:30" : "08:00"}:00.000Z`, source: "ios-health" };
    }).filter((episode) => episode.wakeAt <= now);
    const rhythm = energyRhythm({ episodes, hourOf: zone, weekdayOf: weekday, phaseShift: 0, calibration: DEFAULT_CALIBRATION,
      reports: [{ at: "2026-10-13T10:10:00Z", level: "high" }], now });
    expect(rhythm.sleep.from).toBe(24.5);
    expect(rhythm.sleep.to).toBe(8);
    expect(rhythm.curve.find((point) => point.hour === 0)!.value).not.toBeNull();
    expect(rhythm.curve.find((point) => point.hour === 1)!.value).toBeNull();
    expect(rhythm.chronotype!.sjlRel).toBeCloseTo(2, 6);
    expect(rhythm.chronotype!.chronotype).toBe("late");
    expect(rhythm.reports).toEqual([{ hour: 10, level: "high" }]);
    const earlier = energyRhythm({ episodes, hourOf: zone, weekdayOf: weekday, phaseShift: -4, calibration: DEFAULT_CALIBRATION, reports: [], now });
    expect(earlier.peak.start).toBeLessThan(rhythm.peak.start);
  });
});
