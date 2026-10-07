import { defaultIdentityPacks } from "@crossline/identity-packs";

export type DurationPrior = { p25Minutes: number; p50Minutes: number; p85Minutes: number };

/** The identity pack's static prior for this WorkOrder's `(identityId, family)` — the "zero-personal-
 * data" baseline both acceptance paths freeze onto the observation they record at `evidence.accepted`.
 * `undefined` when there is no `family` yet (a pre-`family` WorkOrder) or no matching pack, in which
 * case the caller simply records no observation for this acceptance. */
export function durationPriorFor(identityId: string, payload: unknown): DurationPrior | undefined {
  const family = (payload as { family?: string } | undefined)?.family;
  if (!family) return undefined;
  return defaultIdentityPacks().find((pack) => pack.id === identityId)?.durationPriors[family];
}
