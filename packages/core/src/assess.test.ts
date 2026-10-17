import { describe, expect, test } from "vitest";
import { QUIZ_ITEMS, clockHours, mctqLite, poleBalance, pvtIsi, pvtSummary, quizResult, quizScores, quizType } from "./assess";
import { TYPE_AXES, portraitType, typeFromScores } from "./portrait-type";
import { DEFAULT_CALIBRATION } from "./energy-model";
import { energyRhythm } from "./energy-rhythm";

const all = (value: number) => Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, value]));

describe("quiz", () => {
  test("eight questions per dimension: three statements for each pole and two situations", () => {
    for (const axis of TYPE_AXES) {
      const items = QUIZ_ITEMS.filter((item) => item.axis === axis.id);
      expect(items).toHaveLength(8);
      expect(items.filter((item) => item.kind === "pole" && item.pole === "left")).toHaveLength(3);
      expect(items.filter((item) => item.kind === "pole" && item.pole === "right")).toHaveLength(3);
      expect(items.filter((item) => item.kind === "pair")).toHaveLength(2);
    }
    expect(new Set(QUIZ_ITEMS.map((item) => item.id)).size).toBe(32);
    for (let index = 1; index < QUIZ_ITEMS.length; index++) expect(QUIZ_ITEMS[index]!.axis).not.toBe(QUIZ_ITEMS[index - 1]!.axis);
  });

  // The answer that points every question towards one side: agree with that side's statements, disagree with the other's, and pick that
  // side's option clearly.
  const towards = (side: "left" | "right") => Object.fromEntries(QUIZ_ITEMS.map((item) => {
    if (item.kind === "pole") return [item.id, item.pole === side ? 5 : 1];
    const aIsSide = (side === "right") === item.aRight;
    return [item.id, aIsSide ? 1 : 5];
  }));

  test("each side's answers land on its pole; the poles are kept apart", () => {
    expect(quizScores(towards("right"))).toEqual({ concentration: 100, orientation: 100, boundary: 100, pacing: 100 });
    expect(quizType(towards("right")).code).toBe("DXBV");
    expect(quizType(towards("left")).code).toBe("CLWU");
    expect(quizResult(towards("left")).poles.boundary).toEqual({ left: 100, right: 0 });
  });

  test("agreeing with both poles is shown as both strong, and the situations decide the letter", () => {
    const answers = Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, item.kind === "pole" ? 5 : 3]));
    for (const item of QUIZ_ITEMS.filter((entry) => entry.axis === "orientation" && entry.kind === "pair")) answers[item.id] = item.kind === "pair" && item.aRight ? 2 : 4;
    const { scores, poles } = quizResult(answers);
    expect(poles.orientation).toEqual({ left: 100, right: 100 });
    expect(poleBalance(poles.orientation)).toBe("both_high");
    expect(scores.orientation).toBe(56);
    // Everything else even: exactly 50, decided by the poles' order (equal) → left, shown as 49.
    expect(scores.concentration).toBe(49);
    expect(poleBalance({ left: 0, right: 25 })).toBe("both_low");
    expect(poleBalance({ left: 80, right: 50 })).toBeNull();
  });

  test("a single dimension moves only with its own questions", () => {
    const answers = all(3);
    for (const item of QUIZ_ITEMS.filter((entry) => entry.axis === "pacing" && entry.kind === "pole")) answers[item.id] = item.kind === "pole" && item.pole === "right" ? 4 : 2;
    expect(quizScores(answers)).toEqual({ concentration: 49, orientation: 49, boundary: 49, pacing: 69 });
  });

  test("an unanswered or out-of-range answer is refused", () => {
    const answers = all(3);
    delete answers.q7;
    expect(() => quizScores(answers)).toThrow(/QUIZ_INCOMPLETE: q7/);
    expect(() => quizScores({ ...all(3), q1: 6 })).toThrow(/QUIZ_INCOMPLETE: q1/);
  });

  test("the portrait's type and the quiz's type are the same reading of the same scores", () => {
    const scores = { concentration: 20, orientation: 80, boundary: 50, pacing: 49 };
    const report = { type: { ...scores, evidence: { concentration: "因为", orientation: "", boundary: "", pacing: "" } } } as unknown as Parameters<typeof portraitType>[0];
    expect(portraitType(report)).toEqual(typeFromScores(scores, report.type!.evidence));
    expect(typeFromScores(scores).code).toBe("CXBU");
    expect(typeFromScores(scores).axes.map((axis) => axis.percent)).toEqual([80, 80, 50, 51]);
  });

  test("a report on the first version's axes has no type until it is rewritten", () => {
    const report = { type: { scope: 20, basis: 80, output: 50, rhythm: 49, evidence: {} } } as unknown as Parameters<typeof portraitType>[0];
    expect(portraitType(report)).toBeNull();
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
