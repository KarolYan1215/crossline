import type { Estimate } from "./index";

/**
 * Duration calibration as one residual model over the model's own estimates.
 *
 * What is learned is not "how long tasks of this kind take" but "how wrong the analysis's p50 tends to be
 * for this person": `r = ln(actual / llmP50)`. The estimate the analysis wrote for *this* task stays the
 * starting point, so a 30-minute and a 6-hour deep-work order are corrected by the same factor instead of
 * both being replaced by one bucket average (what `effectiveEstimate` used to do).
 *
 *  - Hierarchical empirical Bayes: the person's overall bias μ is shrunk toward 0 (the model assumed
 *    unbiased until shown otherwise), and each (line × family) bucket's extra bias δ is shrunk toward 0
 *    around μ. A person finishes ~10 tasks a week, so μ means something after a couple of weeks and a
 *    bucket only after months — pooling is what makes the early weeks usable at all.
 *  - Recency: weights halve every `HALF_LIFE_DAYS`; observations made under a different analysis context
 *    version count half, because a changed prompt changes the bias being measured.
 *  - Spread: with `CONFORMAL_MIN` residuals the p85 is their empirical 85th percentile (split-conformal —
 *    finite-sample coverage without assuming a distribution); before that it blends the observed σ with
 *    the model's own p85/p50 ratio.
 *  - Promotion: a rolling-origin backtest against the *frozen raw model estimate*. Calibration is applied
 *    only once it beats the raw number by `PROMOTE_MARGIN` in log error without worse p85 coverage —
 *    otherwise the screen says it is still learning and the raw number is used.
 */
export type CalibrationObservation = {
  identityId: string;
  family: string;
  llmP50: number;
  llmP85: number;
  actualMinutes: number;
  observedAt: string;
  contextVersion: string;
  /** Abandoned or sent back: the real duration is unknown. Counted, never fitted. */
  censored: boolean;
};

export const K_GLOBAL = 5;
export const K_BUCKET = 5;
export const HALF_LIFE_DAYS = 60;
export const OTHER_VERSION_WEIGHT = 0.5;
export const CONFORMAL_MIN = 20;
export const RESIDUAL_WARMUP = 3;
export const RESIDUAL_MIN_EVALUATED = 5;
export const RESIDUAL_WINDOW = 20;
export const PROMOTE_MARGIN = 0.1;
export const TARGET_COVERAGE = 0.85;
const Z85 = 1.0364;

export type CalibrationModel = {
  n: number;
  censored: number;
  mu: number;
  sigma: number | null;
  buckets: Record<string, { n: number; delta: number }>;
  residualQ85: number | null;
};

export type ResidualBacktest = {
  evaluated: number;
  maeRaw: number | null;
  maeCalibrated: number | null;
  coverageRaw: number | null;
  coverageCalibrated: number | null;
};

export type CalibrationReport = { model: CalibrationModel; backtest: ResidualBacktest; promoted: boolean };

export const bucketKey = (identityId: string, family: string) => `${identityId}/${family}`;

const usable = (observations: CalibrationObservation[]) => observations
  .filter((o) => !o.censored && o.actualMinutes > 0 && o.llmP50 > 0 && o.llmP85 >= o.llmP50)
  .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

function weightOf(o: CalibrationObservation, nowMs: number, version: string): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(o.observedAt)) / 86_400_000);
  return 0.5 ** (ageDays / HALF_LIFE_DAYS) * (o.contextVersion === version ? 1 : OTHER_VERSION_WEIGHT);
}

const logRatio = (o: CalibrationObservation) => Math.log(o.actualMinutes / o.llmP50);

export function fitCalibration(observations: CalibrationObservation[], now: Date, version: string): CalibrationModel {
  const all = observations.filter((o) => o.actualMinutes > 0 || o.censored);
  const points = usable(observations);
  const nowMs = now.getTime();
  const weights = points.map((o) => weightOf(o, nowMs, version));
  const W = weights.reduce((sum, w) => sum + w, 0);
  if (!points.length || W === 0) {
    return { n: 0, censored: all.filter((o) => o.censored).length, mu: 0, sigma: null, buckets: {}, residualQ85: null };
  }
  const mean = points.reduce((sum, o, i) => sum + weights[i]! * logRatio(o), 0) / W;
  const mu = (W / (W + K_GLOBAL)) * mean;

  const grouped = new Map<string, { W: number; sum: number; n: number }>();
  points.forEach((o, i) => {
    const key = bucketKey(o.identityId, o.family);
    const entry = grouped.get(key) ?? { W: 0, sum: 0, n: 0 };
    entry.W += weights[i]!; entry.sum += weights[i]! * (logRatio(o) - mu); entry.n += 1;
    grouped.set(key, entry);
  });
  const buckets: CalibrationModel["buckets"] = {};
  for (const [key, entry] of grouped) {
    buckets[key] = { n: entry.n, delta: entry.W ? (entry.W / (entry.W + K_BUCKET)) * (entry.sum / entry.W) : 0 };
  }

  const residuals = points.map((o) => logRatio(o) - mu - (buckets[bucketKey(o.identityId, o.family)]?.delta ?? 0));
  let sigma: number | null = null;
  if (points.length >= 2) {
    const rMean = residuals.reduce((sum, e, i) => sum + weights[i]! * e, 0) / W;
    const variance = residuals.reduce((sum, e, i) => sum + weights[i]! * (e - rMean) ** 2, 0) / W;
    sigma = Math.sqrt(variance * points.length / (points.length - 1));
  }
  let residualQ85: number | null = null;
  if (points.length >= CONFORMAL_MIN) {
    const sorted = [...residuals].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.ceil((sorted.length + 1) * TARGET_COVERAGE));
    residualQ85 = sorted[rank - 1]!;
  }
  return { n: points.length, censored: all.filter((o) => o.censored).length, mu, sigma, buckets, residualQ85 };
}

/** The corrected p50/p85 for one estimate, whether or not the model has been promoted. */
export function predictCalibrated(model: CalibrationModel, raw: { p50Minutes: number; p85Minutes: number },
  identityId: string, family: string | undefined): { p50Minutes: number; p85Minutes: number; factor: number } {
  const shift = model.mu + (family ? model.buckets[bucketKey(identityId, family)]?.delta ?? 0 : 0);
  const p50 = raw.p50Minutes * Math.exp(shift);
  const rawSpread = Math.log(Math.max(raw.p85Minutes, raw.p50Minutes) / raw.p50Minutes);
  let spread: number;
  if (model.residualQ85 !== null) spread = Math.max(0, model.residualQ85);
  else if (model.sigma !== null) {
    const weight = model.n / (model.n + K_GLOBAL);
    spread = weight * Z85 * model.sigma + (1 - weight) * rawSpread;
  } else spread = rawSpread;
  const p50Minutes = Math.max(1, Math.round(p50));
  return { p50Minutes, p85Minutes: Math.max(p50Minutes, Math.round(p50 * Math.exp(spread))),
    factor: Math.round(Math.exp(shift) * 100) / 100 };
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

export function backtestResidual(observations: CalibrationObservation[], version: string): ResidualBacktest {
  const points = usable(observations);
  const rawErrors: number[] = []; const calErrors: number[] = [];
  const rawCover: number[] = []; const calCover: number[] = [];
  for (let i = RESIDUAL_WARMUP; i < points.length; i += 1) {
    const point = points[i]!;
    const model = fitCalibration(points.slice(0, i), new Date(point.observedAt), version);
    const predicted = predictCalibrated(model, { p50Minutes: point.llmP50, p85Minutes: point.llmP85 }, point.identityId, point.family);
    rawErrors.push(Math.abs(Math.log(point.actualMinutes / point.llmP50)));
    calErrors.push(Math.abs(Math.log(point.actualMinutes / predicted.p50Minutes)));
    rawCover.push(point.actualMinutes <= point.llmP85 ? 1 : 0);
    calCover.push(point.actualMinutes <= predicted.p85Minutes ? 1 : 0);
  }
  const evaluated = rawErrors.length;
  if (!evaluated) return { evaluated: 0, maeRaw: null, maeCalibrated: null, coverageRaw: null, coverageCalibrated: null };
  const tail = <T,>(values: T[]) => values.slice(Math.max(0, values.length - RESIDUAL_WINDOW));
  return { evaluated, maeRaw: mean(tail(rawErrors)), maeCalibrated: mean(tail(calErrors)),
    coverageRaw: mean(tail(rawCover)), coverageCalibrated: mean(tail(calCover)) };
}

export function shouldPromote(backtest: ResidualBacktest): boolean {
  if (backtest.evaluated < RESIDUAL_MIN_EVALUATED || backtest.maeRaw === null || backtest.maeCalibrated === null
    || backtest.coverageRaw === null || backtest.coverageCalibrated === null) return false;
  if (backtest.maeRaw === 0) return false;
  const improved = (backtest.maeRaw - backtest.maeCalibrated) / backtest.maeRaw >= PROMOTE_MARGIN;
  const coverageNotWorse = Math.abs(backtest.coverageCalibrated - TARGET_COVERAGE)
    <= Math.abs(backtest.coverageRaw - TARGET_COVERAGE) + 1e-9;
  return improved && coverageNotWorse;
}

export function calibrationReport(observations: CalibrationObservation[], now: Date, version: string): CalibrationReport {
  const backtest = backtestResidual(observations, version);
  return { model: fitCalibration(observations, now, version), backtest, promoted: shouldPromote(backtest) };
}

/** Observations needed before a backtest can promote anything at all. */
export const MIN_OBSERVATIONS_TO_PROMOTE = RESIDUAL_WARMUP + RESIDUAL_MIN_EVALUATED;

/**
 * The estimate to schedule and show. Only a model's guess is corrected — a person's own number or a
 * history-derived one is theirs. The raw guess always rides along so the screen can show both.
 */
export function calibratedEstimate(estimate: Estimate, report: CalibrationReport, identityId: string,
  family: string | undefined): Estimate {
  if (estimate.source !== "llm_prior") return estimate;
  const raw = { p50Minutes: estimate.p50Minutes, p85Minutes: estimate.p85Minutes };
  if (!report.promoted) {
    return { ...estimate, calibration: { factor: 1, basedOn: report.model.n, state: "learning",
      needed: Math.max(0, MIN_OBSERVATIONS_TO_PROMOTE - report.model.n), raw } };
  }
  const predicted = predictCalibrated(report.model, raw, identityId, family);
  const bucketN = family ? report.model.buckets[bucketKey(identityId, family)]?.n ?? 0 : 0;
  return {
    ...estimate,
    p25Minutes: Math.min(predicted.p50Minutes, Math.max(1, Math.round(estimate.p25Minutes * predicted.factor))),
    p50Minutes: predicted.p50Minutes,
    p85Minutes: predicted.p85Minutes,
    calibration: { factor: predicted.factor, basedOn: bucketN || report.model.n, state: "applied", raw }
  };
}
