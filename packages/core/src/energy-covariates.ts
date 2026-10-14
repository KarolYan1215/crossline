/**
 * Extra signals for the energy model, each earning its place (docs/energy-and-ecosystem.md §3.1 rule 3, decided 2026-10-14): the desktop
 * input rhythm, the camera's eye and pulse aggregates. None is trusted on its own word. Each is a covariate: at every self-report the
 * signal's value near that moment is paired with the person's level, a coefficient is fitted that shifts the model's alertness, and the
 * covariate is switched on only when a rolling backtest — each report predicted from the reports before it — matches the person's word
 * more often than the model without it, by `PROMOTE_MARGIN`, over at least `RESIDUAL_MIN_EVALUATED` reports. Until then it is recorded
 * and nothing else.
 */

import { PROMOTE_MARGIN, RESIDUAL_MIN_EVALUATED } from "./calibration";
import type { EnergyCalibration } from "./energy-model";

export type CovariateLevel = "low" | "medium" | "high";
/** One self-report with the model's alertness at that moment and the covariate's value then (undefined when not measured). */
export type CovariateSample = { at: string; alertness: number; level: CovariateLevel; value: number | undefined };
export type CovariateFit = { mean: number; sd: number; beta: number };
export type CovariateVerdict = { id: string; evaluated: number; hitsWithout: number; hitsWith: number; enabled: boolean; fit?: CovariateFit };

/** Ridge strength: a coefficient needs this many reports' worth of evidence before it moves far from zero. */
const LAMBDA = 6;
/** The most one standard deviation of a covariate may move alertness: one band (the default cut points are three apart). */
const MAX_BETA = 3;

const levelOf = (value: number, calibration: EnergyCalibration): CovariateLevel =>
  value < calibration.low ? "low" : value < calibration.high ? "medium" : "high";
/** The middle of the band the person said they were in, on the model's scale. */
const target = (level: CovariateLevel, calibration: EnergyCalibration) =>
  level === "low" ? calibration.low - 1 : level === "high" ? calibration.high + 1 : (calibration.low + calibration.high) / 2;

/**
 * Fits how far one standard deviation of the covariate moves alertness: ridge regression of (where the person's word puts them − where
 * the model put them) on the standardised covariate, shrunk towards zero, bounded.
 */
export function fitCovariate(samples: CovariateSample[], calibration: EnergyCalibration): CovariateFit | undefined {
  const measured = samples.filter((sample): sample is CovariateSample & { value: number } => sample.value !== undefined && Number.isFinite(sample.value));
  if (measured.length < 3) return undefined;
  const mean = measured.reduce((sum, sample) => sum + sample.value, 0) / measured.length;
  const sd = Math.sqrt(measured.reduce((sum, sample) => sum + (sample.value - mean) ** 2, 0) / (measured.length - 1));
  // A signal that hardly varies says nothing (and would divide by almost nothing).
  if (!(sd > 1e-6 * Math.max(1, Math.abs(mean)))) return undefined;
  let xy = 0, xx = 0;
  for (const sample of measured) {
    const z = (sample.value - mean) / sd;
    xy += z * (target(sample.level, calibration) - sample.alertness);
    xx += z * z;
  }
  const beta = Math.max(-MAX_BETA, Math.min(MAX_BETA, xy / (xx + LAMBDA)));
  return { mean, sd, beta };
}

/** The shift a fitted covariate adds to alertness at a value (none when unmeasured). */
export const covariateShift = (fit: CovariateFit, value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) ? 0 : fit.beta * Math.max(-3, Math.min(3, (value - fit.mean) / fit.sd));

/**
 * Rolling-origin backtest: each measured report from the fourth on is predicted with the coefficient fitted on the reports before it,
 * and compared with the prediction without it. Enabled only when it is right more often by the margin.
 */
export function judgeCovariate(id: string, samples: CovariateSample[], calibration: EnergyCalibration): CovariateVerdict {
  const ordered = [...samples].sort((a, b) => a.at.localeCompare(b.at));
  let evaluated = 0, hitsWithout = 0, hitsWith = 0;
  ordered.forEach((sample, index) => {
    if (sample.value === undefined) return;
    const fit = fitCovariate(ordered.slice(0, index), calibration);
    if (!fit) return;
    evaluated += 1;
    if (levelOf(sample.alertness, calibration) === sample.level) hitsWithout += 1;
    if (levelOf(sample.alertness + covariateShift(fit, sample.value), calibration) === sample.level) hitsWith += 1;
  });
  const fit = fitCovariate(ordered, calibration);
  const improved = evaluated >= RESIDUAL_MIN_EVALUATED && hitsWith - hitsWithout >= Math.max(1, PROMOTE_MARGIN * evaluated);
  return { id, evaluated, hitsWithout, hitsWith, enabled: improved && Boolean(fit), ...(fit ? { fit } : {}) };
}
