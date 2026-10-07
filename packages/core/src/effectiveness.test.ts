import { expect, test } from "vitest";
import { computeEffectiveness, type EffectivenessInput } from "./effectiveness";

const base: EffectivenessInput = {
  today: "2026-10-20",
  milestones: [
    { id: "a", title: "参数映射", deadline: "2026-10-12", requiredCriteria: ["c1"], metOn: { c1: "2026-10-11" } },
    { id: "b", title: "图表交付", deadline: "2026-10-18", requiredCriteria: ["c2", "c3"], metOn: { c2: "2026-10-17", c3: "2026-10-19" } },
    { id: "c", title: "论文投出", deadline: "2026-10-31", requiredCriteria: ["c4"], metOn: {}, p85Finish: "2026-10-30" }
  ],
  durations: [{ llmP50: 60, llmP85: 90, calibratedP50: 80, calibratedP85: 120, actual: 84 }, { llmP50: 30, llmP85: 45, calibratedP50: 40, calibratedP85: 60, actual: 50 }],
  minutesByLine: { research: 900, startup: 300, media: 0, investment: 60 }, deadlineMinutes: 700, totalMinutes: 1260, priorityOrder: ["research", "startup"],
  decisions: { count: 21, minutes: 35 }, captureToScheduledMinutes: [3, 10, 120], pendingNow: 4,
  committedOrders: 10, committedWithBlock: 7, liveMilestones: 8, milestonesWithProgressLast7d: 3, waitingAnswered: 2, waitingAnsweredOnTime: 1
};

test("on time means every required criterion met by the deadline; a thin forecast margin is flagged", () => {
  const result = computeEffectiveness(base);
  expect(result.onTime).toEqual({ due: 2, met: 1, rate: 0.5, atRisk: ["论文投出"] });
});

test("estimate accuracy is compared raw against calibrated, and coverage of the wide estimate is reported", () => {
  const { estimates } = computeEffectiveness(base);
  expect(estimates.n).toBe(2);
  expect(estimates.maeCalibrated!).toBeLessThan(estimates.maeRaw!);
  expect(estimates.coverageRaw).toBe(0.5);
  expect(estimates.coverageCalibrated).toBe(1);
});

test("priorities, overhead and mechanism coverage come out as shares and per-day figures", () => {
  const result = computeEffectiveness(base);
  expect(result.priorities).toMatchObject({ deadlineShare: 0.56, topLine: "research", topLineShare: 0.71 });
  expect(result.overhead).toEqual({ decisionsPerDay: 3, decisionMinutesPerDay: 5, medianCaptureToScheduled: 10, pendingNow: 4 });
  expect(result.coverage).toEqual({ datedAndTimed: 0.7, progressRecorded: 0.38, followUpsOnTime: 0.5 });
});

test("with no data every rate is unknown rather than zero", () => {
  const empty = computeEffectiveness({ ...base, milestones: [], durations: [], minutesByLine: {}, deadlineMinutes: 0, totalMinutes: 0,
    captureToScheduledMinutes: [], committedOrders: 0, committedWithBlock: 0, liveMilestones: 0, milestonesWithProgressLast7d: 0, waitingAnswered: 0, waitingAnsweredOnTime: 0 });
  expect(empty.onTime.rate).toBeNull();
  expect(empty.estimates.maeRaw).toBeNull();
  expect(empty.coverage.datedAndTimed).toBeNull();
});
