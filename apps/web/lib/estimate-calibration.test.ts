import { expect, test } from "vitest";
import { durationPriorFor, effectiveEstimate, type DurationPrior, type DurationRow } from "./estimate-calibration";

const FALLBACK = { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const PRIOR: DurationPrior = { p25Minutes: 15, p50Minutes: 30, p85Minutes: 50 };
const row = (minutes: number, day: number): DurationRow => ({
  observedMinutes: minutes, observedAt: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  interruptionDominant: false, baselineP25Minutes: PRIOR.p25Minutes, baselineP50Minutes: PRIOR.p50Minutes, baselineP85Minutes: PRIOR.p85Minutes
});

test("with no prior or no rows, the analysis-time estimate passes through unchanged", () => {
  expect(effectiveEstimate(FALLBACK, undefined, [row(90, 1)])).toEqual(FALLBACK);
  expect(effectiveEstimate(FALLBACK, PRIOR, [])).toEqual(FALLBACK);
});

test("real observations for the bucket override the stored analysis-time guess", () => {
  const observations = Array.from({ length: 5 }, (_, i) => row(90, i + 1));
  const result = effectiveEstimate(FALLBACK, PRIOR, observations);
  expect(result.source).toBe("personal_history");
  expect(result.observationCount).toBe(5);
  expect(result.p50Minutes).not.toBe(FALLBACK.p50Minutes);
});

test("durationPriorFor resolves the identity pack's static prior from the WorkOrder's own family tag", () => {
  expect(durationPriorFor("research", { family: "deep_work" })).toEqual({ p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 });
  expect(durationPriorFor("research", { family: "review" })).toEqual({ p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 });
});

test("durationPriorFor is undefined for a pre-family WorkOrder or an identity with no pack", () => {
  expect(durationPriorFor("research", {})).toBeUndefined();
  expect(durationPriorFor("research", undefined)).toBeUndefined();
  expect(durationPriorFor("no-such-identity", { family: "deep_work" })).toBeUndefined();
});
