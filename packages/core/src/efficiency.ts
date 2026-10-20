/**
 * How much an hour short of the work's energy really yields, learned from the person's confirmed blocks (docs/energy-and-ecosystem.md
 * §3, decided 2026-10-14). The planner assumes a slot one level short yields 0.8 of an hour and two levels short 0.65 — stated as
 * assumptions in packages/planner/src/optimizer.ts. Each completion check of a block records the slot's energy, the work's, the factor
 * the plan used and the minutes the person says it took; a block's observed yield is the work the plan put in it over those minutes.
 *
 * The person's general pace cancels out: the factor for k levels short is the observed yield there relative to the observed yield in
 * matching slots, shrunk towards the assumed factor with K = 5 blocks' weight. It is used only once a rolling backtest predicts the
 * minutes of short blocks better than the assumed factors by the calibration's own margin.
 *
 * Blocks that produced nothing (decided 2026-10-20): a block the person answered 「未执行」, or one seen under way with no timer and no
 * answer, is a sample with `done: false` — its time went by and no work came of it. Counted as zero yield, a slot short of energy that
 * often goes unused looks as costly as it is; but an unanswered block may also have been done without a word, so the factors that count
 * them (`fitEfficiencyWithMisses`) replace the others only when a rolling backtest of every short block's yield, misses included, favours
 * them over both the assumed factors and the done-only ones by the same margin.
 */

import { PROMOTE_MARGIN, RESIDUAL_MIN_EVALUATED } from "./calibration";

export type EnergyLevelName = "low" | "medium" | "high";
/**
 * One confirmed block: the slot's and the work's energy, the factor the plan used, the block's own minutes, the minutes it took.
 * `done: false` is a block that produced nothing (its `minutes` are not read).
 */
export type EfficiencySample = { at: string; slot: EnergyLevelName; need: EnergyLevelName; planned: number; blockMinutes: number; minutes: number; done?: boolean };

export const ASSUMED_EFFICIENCY: readonly [number, number] = [0.8, 0.65];
const K = 5;
const RANK = { low: 0, medium: 1, high: 2 } as const;
const shortOf = (sample: EfficiencySample) => Math.max(0, RANK[sample.need] - RANK[sample.slot]);
/** The work the plan expected of the block, over the minutes it took. */
const yieldOf = (sample: EfficiencySample) => sample.blockMinutes * sample.planned / sample.minutes;
const usable = (sample: EfficiencySample) => sample.done !== false && sample.minutes > 0 && sample.blockMinutes > 0 && sample.planned > 0 && sample.planned <= 1;
const usableWithMisses = (sample: EfficiencySample) => sample.done === false ? sample.blockMinutes > 0 && sample.planned > 0 && sample.planned <= 1 : usable(sample);
/** The work a block yielded per minute of it, relative to the plan: zero for one that produced nothing. */
const realized = (sample: EfficiencySample) => sample.done === false ? 0 : yieldOf(sample);

/** The factors for one and two levels short; each never above the one for fewer levels short, and between 0.4 and 1. */
export function fitEfficiency(samples: EfficiencySample[]): [number, number] {
  const valid = samples.filter(usable);
  const meanLog = (items: EfficiencySample[]) => items.reduce((sum, item) => sum + Math.log(yieldOf(item)), 0) / items.length;
  const matching = valid.filter((sample) => shortOf(sample) === 0);
  const base = matching.length ? meanLog(matching) : undefined;
  const factor = (k: 1 | 2, prior: number) => {
    const own = valid.filter((sample) => shortOf(sample) === k);
    if (base === undefined || !own.length) return prior;
    const learned = meanLog(own) - base;
    const shrunk = (own.length * learned + K * Math.log(prior)) / (own.length + K);
    return Math.min(1, Math.max(0.4, Math.exp(shrunk)));
  };
  const one = factor(1, ASSUMED_EFFICIENCY[0]);
  const two = Math.min(one, factor(2, ASSUMED_EFFICIENCY[1]));
  return [Math.round(one * 100) / 100, Math.round(two * 100) / 100];
}

export type EfficiencyBacktest = { evaluated: number; maeAssumed: number | null; maeLearned: number | null };

/**
 * Rolling-origin: each short block in time order is predicted from the blocks before it — its minutes as the work in it over the
 * factor — once by the assumed factors and once by the factors fitted so far; the error is the absolute log ratio to what it took.
 */
export function backtestEfficiency(samples: EfficiencySample[]): EfficiencyBacktest {
  const ordered = samples.filter(usable).sort((a, b) => a.at.localeCompare(b.at));
  let evaluated = 0, assumed = 0, learned = 0;
  ordered.forEach((sample, index) => {
    const k = shortOf(sample);
    if (k === 0) return;
    const before = ordered.slice(0, index);
    if (!before.some((item) => shortOf(item) === 0)) return;
    const work = sample.blockMinutes * sample.planned;
    const fitted = fitEfficiency(before)[k - 1]!;
    assumed += Math.abs(Math.log(work / ASSUMED_EFFICIENCY[k - 1]! / sample.minutes));
    learned += Math.abs(Math.log(work / fitted / sample.minutes));
    evaluated += 1;
  });
  return { evaluated, maeAssumed: evaluated ? assumed / evaluated : null, maeLearned: evaluated ? learned / evaluated : null };
}

/** The done-only factors, or undefined while the assumed ones are as good. */
function learnedDoneOnly(samples: EfficiencySample[]): [number, number] | undefined {
  const backtest = backtestEfficiency(samples);
  if (backtest.evaluated < RESIDUAL_MIN_EVALUATED || !backtest.maeAssumed || backtest.maeLearned === null) return undefined;
  return (backtest.maeAssumed - backtest.maeLearned) / backtest.maeAssumed >= PROMOTE_MARGIN ? fitEfficiency(samples) : undefined;
}

/**
 * The factors with blocks that produced nothing counted as zero: the mean yield k levels short over the mean yield in matching slots,
 * misses included on both sides, shrunk towards the assumed factor with K blocks' weight; same bounds as `fitEfficiency`.
 */
export function fitEfficiencyWithMisses(samples: EfficiencySample[]): [number, number] {
  const valid = samples.filter(usableWithMisses);
  const mean = (items: EfficiencySample[]) => items.reduce((sum, item) => sum + realized(item), 0) / items.length;
  const matching = valid.filter((sample) => shortOf(sample) === 0);
  const base = matching.length ? mean(matching) : 0;
  const factor = (k: 1 | 2, prior: number) => {
    const own = valid.filter((sample) => shortOf(sample) === k);
    if (!(base > 0) || !own.length) return prior;
    const shrunk = (own.length * (mean(own) / base) + K * prior) / (own.length + K);
    return Math.min(1, Math.max(0.4, shrunk));
  };
  const one = factor(1, ASSUMED_EFFICIENCY[0]);
  const two = Math.min(one, factor(2, ASSUMED_EFFICIENCY[1]));
  return [Math.round(one * 100) / 100, Math.round(two * 100) / 100];
}

export type MissesBacktest = { evaluated: number; mseAssumed: number | null; mseDoneOnly: number | null; mseWithMisses: number | null };

/**
 * Rolling-origin over every short block, misses included: its yield is predicted as the matching slots' mean yield so far times a
 * factor — assumed, done-only (`fitEfficiency`) or with misses — and the error is the squared difference over that mean (a yield is
 * zero or near the plan's, so an absolute error would score the mean no better than either end).
 */
export function backtestMisses(samples: EfficiencySample[]): MissesBacktest {
  const ordered = samples.filter(usableWithMisses).sort((a, b) => a.at.localeCompare(b.at));
  let evaluated = 0, assumed = 0, doneOnly = 0, withMisses = 0;
  ordered.forEach((sample, index) => {
    const k = shortOf(sample);
    if (k === 0) return;
    const before = ordered.slice(0, index);
    const matching = before.filter((item) => shortOf(item) === 0);
    const base = matching.length ? matching.reduce((sum, item) => sum + realized(item), 0) / matching.length : 0;
    if (!(base > 0)) return;
    const error = (factor: number) => ((base * factor - realized(sample)) / base) ** 2;
    assumed += error(ASSUMED_EFFICIENCY[k - 1]!);
    doneOnly += error(fitEfficiency(before)[k - 1]!);
    withMisses += error(fitEfficiencyWithMisses(before)[k - 1]!);
    evaluated += 1;
  });
  return { evaluated, mseAssumed: evaluated ? assumed / evaluated : null, mseDoneOnly: evaluated ? doneOnly / evaluated : null,
    mseWithMisses: evaluated ? withMisses / evaluated : null };
}

/**
 * The person's factors, or undefined while the assumed ones are as good. With blocks that produced nothing on record, the factors that
 * count them win only when their backtest beats both the assumed factors and the done-only ones (or whichever of those is in use).
 */
export function learnedEfficiency(samples: EfficiencySample[]): [number, number] | undefined {
  const doneOnly = learnedDoneOnly(samples);
  if (!samples.some((sample) => sample.done === false)) return doneOnly;
  const backtest = backtestMisses(samples);
  if (backtest.evaluated < RESIDUAL_MIN_EVALUATED || backtest.mseWithMisses === null) return doneOnly;
  const current = doneOnly ? backtest.mseDoneOnly : backtest.mseAssumed;
  if (!current) return doneOnly;
  return (current - backtest.mseWithMisses) / current >= PROMOTE_MARGIN ? fitEfficiencyWithMisses(samples) : doneOnly;
}
