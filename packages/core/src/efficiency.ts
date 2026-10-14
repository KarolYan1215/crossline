/**
 * How much an hour short of the work's energy really yields, learned from the person's confirmed blocks (docs/energy-and-ecosystem.md
 * §3, decided 2026-10-14). The planner assumes a slot one level short yields 0.8 of an hour and two levels short 0.65 — stated as
 * assumptions in packages/planner/src/optimizer.ts. Each completion check of a block records the slot's energy, the work's, the factor
 * the plan used and the minutes the person says it took; a block's observed yield is the work the plan put in it over those minutes.
 *
 * The person's general pace cancels out: the factor for k levels short is the observed yield there relative to the observed yield in
 * matching slots, shrunk towards the assumed factor with K = 5 blocks' weight. It is used only once a rolling backtest predicts the
 * minutes of short blocks better than the assumed factors by the calibration's own margin.
 */

import { PROMOTE_MARGIN, RESIDUAL_MIN_EVALUATED } from "./calibration";

export type EnergyLevelName = "low" | "medium" | "high";
/** One confirmed block: the slot's and the work's energy, the factor the plan used, the block's own minutes, the minutes it took. */
export type EfficiencySample = { at: string; slot: EnergyLevelName; need: EnergyLevelName; planned: number; blockMinutes: number; minutes: number };

export const ASSUMED_EFFICIENCY: readonly [number, number] = [0.8, 0.65];
const K = 5;
const RANK = { low: 0, medium: 1, high: 2 } as const;
const shortOf = (sample: EfficiencySample) => Math.max(0, RANK[sample.need] - RANK[sample.slot]);
/** The work the plan expected of the block, over the minutes it took. */
const yieldOf = (sample: EfficiencySample) => sample.blockMinutes * sample.planned / sample.minutes;
const usable = (sample: EfficiencySample) => sample.minutes > 0 && sample.blockMinutes > 0 && sample.planned > 0 && sample.planned <= 1;

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

/** The person's factors, or undefined while the assumed ones are as good. */
export function learnedEfficiency(samples: EfficiencySample[]): [number, number] | undefined {
  const backtest = backtestEfficiency(samples);
  if (backtest.evaluated < RESIDUAL_MIN_EVALUATED || !backtest.maeAssumed || backtest.maeLearned === null) return undefined;
  return (backtest.maeAssumed - backtest.maeLearned) / backtest.maeAssumed >= PROMOTE_MARGIN ? fitEfficiency(samples) : undefined;
}
