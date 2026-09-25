import type { Estimate } from "./index";

export type DurationPrior = { p25Minutes: number; p50Minutes: number; p85Minutes: number };

/**
 * One completed execution's real duration, plus what a zero-personal-data guess would have said at the
 * time — the `baseline` is frozen by the caller the instant the observation is recorded (from the
 * identity pack's static prior, never from a WorkOrder's own `estimate`, which may already be
 * calibrated by then). Without that freeze, a backtest comparing "calibrated" against "baseline" would
 * be comparing calibration against itself.
 */
export type DurationObservation = {
  observedMinutes: number;
  observedAt: string;
  interruptionDominant: boolean;
  baseline: DurationPrior;
};

/**
 * `weight = n / (n + SHRINKAGE_K)`: linear empirical-Bayes shrinkage toward the group prior, in
 * log-space (task/software durations are empirically log-normal — shrinking the raw minutes would
 * treat a symmetric, sometimes-negative band as sensible, which a right-skewed real distribution is
 * not). `k = 5` is picked round, not fitted from data that does not exist yet: personal signal already
 * carries ~17% weight at the very first observation (reference-class forecasting says the outside view
 * should count once it exists at all, not only once "enough" of it exists), reaches half weight at
 * n = 5, and ~80% by n = 20 — fast enough to matter, slow enough that one unusual completion cannot
 * swing the number on its own.
 */
export const SHRINKAGE_K = 5;

/** Standard-normal z-scores for the 25th/85th percentiles — turns one log-space spread into the same
 * asymmetric p25/p85 band shape `Estimate` has always used, still centred on the shrunk p50. */
const Z25 = -0.6745;
const Z85 = 1.0364;

/** Below this many *evaluated* backtest points, an error-margin comparison is closer to a coin flip
 * than a measurement — confidence cannot leave "low" no matter how good the numbers look. */
export const MEDIUM_MIN_EVALUATED = 5;
export const HIGH_MIN_EVALUATED = 15;
/** Total usable observations required, independent of the error margin — mirrors the only other
 * "personal history beats a baseline" precedent in this codebase (`energy-learning.ts`'s own `n >= 20`
 * for its highest tier), rather than inventing an unrelated number for "high". `8` for the low→medium
 * floor is chosen so at least `MEDIUM_MIN_EVALUATED` points can ever be evaluated once
 * `BACKTEST_WARMUP` observations are spent seeding the first prediction. */
export const BACKTEST_MIN_SAMPLE = 8;
export const HIGH_MIN_SAMPLE = 20;
/** Observations spent seeding the first calibrated prediction before backtesting starts scoring —
 * `deriveEstimate` on zero or one point is barely a prediction at all. */
export const BACKTEST_WARMUP = 3;
/** Trailing, not cumulative: task mix and workload can genuinely drift over months, and a bucket whose
 * recent predictions have gone bad should be able to fall back toward "low" rather than staying
 * permanently "high" on the strength of observations from a different season of work. */
export const BACKTEST_WINDOW = 20;
/** Calibrated MAE must beat baseline MAE by at least this fraction before confidence leaves "low" —
 * MAE on a handful of points is noisy, so "any improvement at all" would promote on sampling luck. A
 * round, defensible-but-not-derived margin; the most arguable constant in this file. */
export const MEDIUM_MARGIN = 0.15;
/** "high" is what flips `packages/planner`'s scheduler from the conservative p85 to p50 — a real
 * scheduling-risk decision, so it demands a decisively better track record, not a marginal one. */
export const HIGH_MARGIN = 0.30;

const usableSorted = (observations: DurationObservation[]): DurationObservation[] =>
  observations.filter((o) => !o.interruptionDominant).sort((a, b) => a.observedAt.localeCompare(b.observedAt));

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

/** Sample standard deviation (n-1 denominator); only ever called with at least 2 values. */
const sampleStd = (values: number[]): number => {
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
};

/** The prior's own implied log-space spread, averaged from both sides of its p25/p85 band — used as
 * the shrinkage target for spread the same way `prior.p50Minutes` is the target for the center. */
function priorLogSigma(prior: DurationPrior): number {
  const fromLow = (Math.log(prior.p50Minutes) - Math.log(prior.p25Minutes)) / -Z25;
  const fromHigh = (Math.log(prior.p85Minutes) - Math.log(prior.p50Minutes)) / Z85;
  return (fromLow + fromHigh) / 2;
}

type BlendedPoint = { p25Minutes: number; p50Minutes: number; p85Minutes: number; n: number };

/**
 * The numeric blend only, with no confidence computation — used both by the public `deriveEstimate` and,
 * internally, by `backtestCalibration`'s per-point predictions. Keeping confidence out of this function
 * is what keeps the backtest linear: `graduateConfidence` calls `backtestCalibration`, which calls this
 * for O(n) shrinking sub-slices — if that inner call also computed confidence (which itself calls
 * `backtestCalibration` again), the cost would compound at every one of those O(n) points instead of
 * being paid once at the top level.
 */
function blendPoint(observations: DurationObservation[], prior: DurationPrior): BlendedPoint {
  const usable = usableSorted(observations);
  const n = usable.length;
  if (n === 0) return { ...prior, n: 0 };

  const logs = usable.map((o) => Math.log(o.observedMinutes));
  const weight = n / (n + SHRINKAGE_K);
  const blendedLogP50 = weight * mean(logs) + (1 - weight) * Math.log(prior.p50Minutes);
  const sampleSigma = n >= 2 ? sampleStd(logs) : priorLogSigma(prior);
  const blendedSigma = n >= 2 ? weight * sampleSigma + (1 - weight) * priorLogSigma(prior) : sampleSigma;

  const p50Minutes = Math.max(1, Math.round(Math.exp(blendedLogP50)));
  const p25Minutes = Math.min(p50Minutes, Math.max(1, Math.round(Math.exp(blendedLogP50 + Z25 * blendedSigma))));
  const p85Minutes = Math.max(p50Minutes, Math.round(Math.exp(blendedLogP50 + Z85 * blendedSigma)));
  return { p25Minutes, p50Minutes, p85Minutes, n };
}

/**
 * Blends a bucket's real observations with its identity-pack prior in log-space. Returns the prior
 * unchanged (tagged `"identity_prior"`, `observationCount: 0`) when there is no usable personal history
 * yet — `interruption_dominant` observations never count as usable, at read time rather than having
 * been excluded when written, so the exclusion rule can change later without losing any data.
 */
export function deriveEstimate(observations: DurationObservation[], prior: DurationPrior): Estimate {
  const { n, ...blended } = blendPoint(observations, prior);
  if (n === 0) return { ...prior, source: "identity_prior", observationCount: 0, confidence: "low" };
  return { ...blended, source: "personal_history", observationCount: n, confidence: graduateConfidence(observations, prior) };
}

export type BacktestResult = {
  evaluated: number;
  maeCalibrated: number | null;
  maeBaseline: number | null;
  /** `(maeBaseline - maeCalibrated) / maeBaseline`; `null` when too few points have been evaluated to
   * mean anything, not when calibration happens to be worse (that is a real, valid negative ratio). */
  improvementRatio: number | null;
};

/**
 * Pure, non-recursive backtest: for each usable observation from index `BACKTEST_WARMUP` onward,
 * predicts using `deriveEstimate` over only the observations strictly before it — never the observation
 * itself or anything later — and compares that prediction's absolute error against the same point's own
 * immutable frozen `baseline`. MAE is computed over the trailing `BACKTEST_WINDOW` evaluated points.
 */
export function backtestCalibration(observations: DurationObservation[], prior: DurationPrior): BacktestResult {
  const usable = usableSorted(observations);
  const calibratedErrors: number[] = [];
  const baselineErrors: number[] = [];
  for (let i = BACKTEST_WARMUP; i < usable.length; i += 1) {
    const point = usable[i]!;
    const predicted = blendPoint(usable.slice(0, i), prior).p50Minutes;
    calibratedErrors.push(Math.abs(predicted - point.observedMinutes));
    baselineErrors.push(Math.abs(point.baseline.p50Minutes - point.observedMinutes));
  }
  const evaluated = calibratedErrors.length;
  if (evaluated === 0) return { evaluated: 0, maeCalibrated: null, maeBaseline: null, improvementRatio: null };

  const windowed = <T,>(values: T[]) => values.slice(Math.max(0, values.length - BACKTEST_WINDOW));
  const maeCalibrated = mean(windowed(calibratedErrors));
  const maeBaseline = mean(windowed(baselineErrors));
  // A baseline that was perfectly right on every point in the window is not something calibration can
  // beat by a fraction of it — treat matching it as no improvement rather than dividing by zero.
  const improvementRatio = maeBaseline === 0 ? (maeCalibrated === 0 ? 0 : -1) : (maeBaseline - maeCalibrated) / maeBaseline;
  return { evaluated, maeCalibrated, maeBaseline, improvementRatio };
}

/**
 * Confidence graduates only from measured prediction error against a real baseline, never from a bare
 * observation count — `docs/crossline-plan-critical-review.md` explicitly rules out a hardcoded
 * "N observations is trustworthy" threshold, and this is what replaces it. Sample-size floors still
 * apply on top of the error margin, because a strong-looking margin from very few evaluated points is
 * exactly the kind of sampling luck the margin check alone cannot rule out.
 */
export function graduateConfidence(observations: DurationObservation[], prior: DurationPrior): Estimate["confidence"] {
  const n = usableSorted(observations).length;
  if (n < BACKTEST_MIN_SAMPLE) return "low";
  const { evaluated, improvementRatio } = backtestCalibration(observations, prior);
  if (evaluated < MEDIUM_MIN_EVALUATED || improvementRatio === null || improvementRatio < MEDIUM_MARGIN) return "low";
  if (n < HIGH_MIN_SAMPLE || evaluated < HIGH_MIN_EVALUATED || improvementRatio < HIGH_MARGIN) return "medium";
  return "high";
}
