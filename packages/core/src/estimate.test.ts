import { expect, test } from "vitest";
import {
  BACKTEST_MIN_SAMPLE, HIGH_MARGIN, HIGH_MIN_SAMPLE, MEDIUM_MARGIN, SHRINKAGE_K,
  backtestCalibration, deriveEstimate, graduateConfidence, type DurationObservation, type DurationPrior
} from "./estimate";

const PRIOR: DurationPrior = { p25Minutes: 15, p50Minutes: 30, p85Minutes: 50 };

const obs = (observedMinutes: number, day: number, interruptionDominant = false): DurationObservation => ({
  observedMinutes, observedAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  interruptionDominant, baseline: PRIOR
});

test("zero observations returns the prior unchanged, tagged as an unobserved identity prior", () => {
  expect(deriveEstimate([], PRIOR)).toEqual({ ...PRIOR, source: "identity_prior", observationCount: 0, confidence: "low" });
});

test("observations exactly matching the prior leave p50 unmoved — shrinkage toward agreement is a no-op", () => {
  const observations = Array.from({ length: 5 }, (_, i) => obs(PRIOR.p50Minutes, i + 1));
  expect(deriveEstimate(observations, PRIOR)).toMatchObject({
    p50Minutes: PRIOR.p50Minutes, source: "personal_history", observationCount: 5
  });
});

test("a single observation far from the prior moves the blend by exactly weight = 1/(1+k), not all the way", () => {
  const far = Math.round(PRIOR.p50Minutes * Math.exp(3));
  const result = deriveEstimate([obs(far, 1)], PRIOR);
  const weight = 1 / (1 + SHRINKAGE_K);
  const expectedP50 = Math.round(Math.exp(weight * Math.log(far) + (1 - weight) * Math.log(PRIOR.p50Minutes)));
  expect(result.p50Minutes).toBe(expectedP50);
  // Confirms the blend actually moved toward the observation, and stayed short of it.
  expect(result.p50Minutes).toBeGreaterThan(PRIOR.p50Minutes);
  expect(result.p50Minutes).toBeLessThan(far);
  expect(result.observationCount).toBe(1);
});

test("an interruption-dominant observation is excluded from the count and the blend", () => {
  const usable = [obs(60, 1), obs(65, 2), obs(58, 3)];
  const dominant = [obs(400, 4, true), obs(500, 5, true)];
  const withDominant = deriveEstimate([...usable, ...dominant], PRIOR);
  const usableOnly = deriveEstimate(usable, PRIOR);
  expect(withDominant).toEqual(usableOnly);
  expect(withDominant.observationCount).toBe(3);
});

test("confidence stays low below BACKTEST_MIN_SAMPLE regardless of how good the errors would be", () => {
  // Every observation exactly matches the truth this bucket actually settles on — as good as a
  // calibration signal can get — but there are only 7 of them.
  const observations = Array.from({ length: BACKTEST_MIN_SAMPLE - 1 }, (_, i) => obs(90, i + 1));
  expect(graduateConfidence(observations, PRIOR)).toBe("low");
});

test("a bucket whose real duration consistently diverges from the prior graduates past low once error improves enough", () => {
  // The prior insists on 30 minutes; reality is consistently ~90. Baseline's error therefore stays
  // pinned near 60 for every evaluated point, while the calibrated estimate converges toward 90 as
  // observations accumulate, so its error shrinks — this is the shape a real, working bucket looks like.
  const observations = Array.from({ length: BACKTEST_MIN_SAMPLE }, (_, i) => obs(90, i + 1));
  const backtest = backtestCalibration(observations, PRIOR);
  expect(backtest.evaluated).toBeGreaterThan(0);
  expect(backtest.improvementRatio).not.toBeNull();
  expect(backtest.improvementRatio!).toBeGreaterThan(MEDIUM_MARGIN);
  expect(graduateConfidence(observations, PRIOR)).toBe("medium");
});

test("high confidence needs HIGH_MIN_SAMPLE on top of a strong margin — the same margin at fewer samples stays medium", () => {
  // Same reality (a consistent 90-minute task the 30-minute prior never predicts), same excellent
  // margin — the only thing that differs is how many observations have accumulated.
  const fewer = Array.from({ length: BACKTEST_MIN_SAMPLE }, (_, i) => obs(90, i + 1));
  const enough = Array.from({ length: HIGH_MIN_SAMPLE }, (_, i) => obs(90, i + 1));
  expect(backtestCalibration(fewer, PRIOR).improvementRatio!).toBeGreaterThanOrEqual(HIGH_MARGIN);
  expect(backtestCalibration(enough, PRIOR).improvementRatio!).toBeGreaterThanOrEqual(HIGH_MARGIN);
  // The margin alone would promote both to "high" — the sample-size floor is what actually holds the
  // smaller bucket back, proving it is a real, independent gate rather than redundant with the margin.
  expect(graduateConfidence(fewer, PRIOR)).toBe("medium");
  expect(graduateConfidence(enough, PRIOR)).toBe("high");
});

test("a baseline that already matches reality exactly leaves no room to improve on it, and confidence stays low", () => {
  // Every observation equals the prior's own p50 — the naive guess is already perfect, so there is
  // nothing for calibration to beat. improvementRatio must read as "no improvement", not divide by zero.
  const observations = Array.from({ length: HIGH_MIN_SAMPLE }, (_, i) => obs(PRIOR.p50Minutes, i + 1));
  const backtest = backtestCalibration(observations, PRIOR);
  expect(backtest.maeBaseline).toBe(0);
  expect(backtest.improvementRatio).toBe(0);
  expect(graduateConfidence(observations, PRIOR)).toBe("low");
});

test("too few evaluated points refuses to report an improvement ratio at all", () => {
  expect(backtestCalibration([], PRIOR)).toEqual({ evaluated: 0, maeCalibrated: null, maeBaseline: null, improvementRatio: null });
});
