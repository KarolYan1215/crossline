import { deriveEstimate, type Estimate } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";

export type DurationRow = {
  observedMinutes: number; observedAt: string; interruptionDominant: boolean;
  baselineP25Minutes: number; baselineP50Minutes: number; baselineP85Minutes: number;
};
export type DurationPrior = { p25Minutes: number; p50Minutes: number; p85Minutes: number };

/**
 * The estimate a WorkOrder should actually be scheduled and shown with: `fallback` (its stored,
 * analysis-time value) unless this `(identityId, family)` bucket already has real completions, in which
 * case a shrinkage blend of that history with the identity pack's static prior
 * (`packages/core/src/estimate.ts`). Pure — like `energy-learning.ts`'s functions, hydration
 * (`getStore().listDurationObservations`, the identity-pack lookup) happens in `crossline.ts`.
 *
 * Deliberately never rewrites `work_orders.estimate_json`. `transitionWorkOrder` only ever writes
 * `estimate` once, at `analysis.accepted`, and this keeps that true rather than merely appearing true —
 * a WorkOrder analysed before its bucket had history benefits automatically as observations accumulate,
 * with no separate recalibration sweep needed. The real source of truth is `duration_observations`,
 * which is exported/restored like any other table, so a restored workspace reproduces the identical
 * calibrated number by re-running this same deterministic function — nothing needs a second backup.
 *
 * A direct read of `work_orders` (an audit script, say) sees only the original analysis-time guess —
 * this is the one place the effective, possibly-calibrated number is available.
 */
export function effectiveEstimate(fallback: Estimate, prior: DurationPrior | undefined, rows: DurationRow[]): Estimate {
  if (!prior || !rows.length) return fallback;
  return deriveEstimate(rows.map((row) => ({
    observedMinutes: row.observedMinutes, observedAt: row.observedAt, interruptionDominant: row.interruptionDominant,
    baseline: { p25Minutes: row.baselineP25Minutes, p50Minutes: row.baselineP50Minutes, p85Minutes: row.baselineP85Minutes }
  })), prior);
}

/** The identity pack's static prior for this WorkOrder's `(identityId, family)` — the "zero-personal-
 * data" baseline both acceptance paths freeze onto the observation they record at `evidence.accepted`.
 * `undefined` when there is no `family` yet (a pre-`family` WorkOrder) or no matching pack, in which
 * case the caller simply records no observation for this acceptance. */
export function durationPriorFor(identityId: string, payload: unknown): DurationPrior | undefined {
  const family = (payload as { family?: string } | undefined)?.family;
  if (!family) return undefined;
  return defaultIdentityPacks().find((pack) => pack.id === identityId)?.durationPriors[family];
}
