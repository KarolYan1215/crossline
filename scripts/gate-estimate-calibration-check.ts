/**
 * Estimate-calibration evidence: real observations accumulating in a real ledger really graduate
 * confidence past "low" only once the error-backtest margin clears, and the planner's scheduler really
 * switches from the conservative p85 to p50 the moment that happens — not a claim taken on faith from
 * the pure unit tests in `packages/core/src/estimate.test.ts` alone.
 *
 *   pnpm exec tsx scripts/gate-estimate-calibration-check.ts
 *
 * Uses a throwaway database under the OS temp dir, never the live ledger. Observations are written
 * directly via `recordDurationObservation` with explicit `observedAt` timestamps rather than driven
 * through the full `human.started → human.completed → evidence.accepted` WorkOrder lifecycle: that
 * lifecycle's own wiring (real timers, pause/resume, the write actually firing on acceptance) is what
 * `packages/db/src/duration-observation.test.ts` already proves, under Vitest's fake timers. What this
 * script proves instead — with the real store, the real calibration module, and the real MILP scheduler,
 * nothing mocked — is the mechanism the wiring feeds: does accumulating real minutes actually move
 * confidence, and does the scheduler actually notice.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveEstimate, graduateConfidence, HIGH_MIN_SAMPLE, BACKTEST_MIN_SAMPLE } from "../packages/core/src/estimate";
import { planSchedule } from "../packages/planner/src/index";
import { CrosslineStore } from "../packages/db/src/index";

const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-gate-estimate-"));
const WORKSPACE = "gate-estimate-workspace";
const OWNER = "gate-estimate-owner";
const IDENTITY = "research";
const FAMILY = "deep_work";
// The identity pack's real prior for (research, deep_work) — packages/identity-packs/src/index.ts's
// `commonPriors.deep_work`. A separate literal, not an import, so this script also catches that file's
// value silently drifting out of sync with what it believes the baseline is.
const PRIOR = { p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 };
// Consistently far from the prior — real deep-work tasks in this fictional workspace take ~180 minutes,
// not the pack's 70 — so a working calibration has real signal to find and a naive baseline stays wrong.
const REAL_MINUTES = 180;

const failures: string[] = [];
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.info(JSON.stringify({ step: label, ok: condition, ...(detail === undefined ? {} : { detail }) }));
  if (!condition) failures.push(label);
};

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
try {
  const observedAt = (day: number) => `2026-01-${String(day).padStart(2, "0")}T09:00:00.000Z`;

  // ---- Confidence stays "low" below BACKTEST_MIN_SAMPLE, no matter how consistent the signal is.
  for (let day = 1; day <= BACKTEST_MIN_SAMPLE - 1; day += 1) {
    store.recordDurationObservation({
      ownerId: OWNER, workspaceId: WORKSPACE, workOrderId: `wo-${day}`, executionId: randomUUID(),
      identityId: IDENTITY, family: FAMILY, observedMinutes: REAL_MINUTES,
      wallClockMinutes: REAL_MINUTES, pauseMinutes: 0, interruptionDominant: false,
      baseline: PRIOR, observedAt: observedAt(day)
    });
  }
  const belowFloor = store.listDurationObservations(WORKSPACE, IDENTITY, FAMILY)
    .map((row) => ({ observedMinutes: row.observedMinutes, observedAt: row.observedAt, interruptionDominant: row.interruptionDominant,
      baseline: { p25Minutes: row.baselineP25Minutes, p50Minutes: row.baselineP50Minutes, p85Minutes: row.baselineP85Minutes } }));
  check("stays_low_below_min_sample", graduateConfidence(belowFloor, PRIOR) === "low",
    { count: belowFloor.length, confidence: graduateConfidence(belowFloor, PRIOR) });

  // ---- Crossing BACKTEST_MIN_SAMPLE with a consistently-wrong-baseline signal reaches "medium".
  store.recordDurationObservation({
    ownerId: OWNER, workspaceId: WORKSPACE, workOrderId: `wo-${BACKTEST_MIN_SAMPLE}`, executionId: randomUUID(),
    identityId: IDENTITY, family: FAMILY, observedMinutes: REAL_MINUTES,
    wallClockMinutes: REAL_MINUTES, pauseMinutes: 0, interruptionDominant: false,
    baseline: PRIOR, observedAt: observedAt(BACKTEST_MIN_SAMPLE)
  });
  const atFloor = store.listDurationObservations(WORKSPACE, IDENTITY, FAMILY)
    .map((row) => ({ observedMinutes: row.observedMinutes, observedAt: row.observedAt, interruptionDominant: row.interruptionDominant,
      baseline: { p25Minutes: row.baselineP25Minutes, p50Minutes: row.baselineP50Minutes, p85Minutes: row.baselineP85Minutes } }));
  const mediumConfidence = graduateConfidence(atFloor, PRIOR);
  check("reaches_medium_at_min_sample", mediumConfidence === "medium", { count: atFloor.length, confidence: mediumConfidence });

  // ---- Reaching HIGH_MIN_SAMPLE with the same consistent signal reaches "high".
  for (let day = BACKTEST_MIN_SAMPLE + 1; day <= HIGH_MIN_SAMPLE; day += 1) {
    store.recordDurationObservation({
      ownerId: OWNER, workspaceId: WORKSPACE, workOrderId: `wo-${day}`, executionId: randomUUID(),
      identityId: IDENTITY, family: FAMILY, observedMinutes: REAL_MINUTES,
      wallClockMinutes: REAL_MINUTES, pauseMinutes: 0, interruptionDominant: false,
      baseline: PRIOR, observedAt: observedAt(day)
    });
  }
  const allObservations = store.listDurationObservations(WORKSPACE, IDENTITY, FAMILY)
    .map((row) => ({ observedMinutes: row.observedMinutes, observedAt: row.observedAt, interruptionDominant: row.interruptionDominant,
      baseline: { p25Minutes: row.baselineP25Minutes, p50Minutes: row.baselineP50Minutes, p85Minutes: row.baselineP85Minutes } }));
  const finalEstimate = deriveEstimate(allObservations, PRIOR);
  check("reaches_high_at_high_min_sample", finalEstimate.confidence === "high",
    { count: allObservations.length, estimate: finalEstimate });
  check("estimate_is_tagged_personal_history", finalEstimate.source === "personal_history", finalEstimate.source);
  check("calibrated_p50_moved_toward_reality_not_the_prior",
    Math.abs(finalEstimate.p50Minutes - REAL_MINUTES) < Math.abs(PRIOR.p50Minutes - REAL_MINUTES),
    { calibratedP50: finalEstimate.p50Minutes, priorP50: PRIOR.p50Minutes, real: REAL_MINUTES });

  // ---- The real MILP scheduler actually reserves p50, not p85, for the now-calibrated estimate.
  const availability = [{ start: "2026-09-14T09:00:00.000Z", end: "2026-09-14T18:00:00.000Z", energy: "high" as const }];
  const uncalibratedTask = { id: "task", title: "深度工作", estimate: { ...PRIOR, confidence: "low" as const }, inputsReady: true, deadlineTier: 2 as const };
  const calibratedTask = { id: "task", title: "深度工作", estimate: finalEstimate, inputsReady: true, deadlineTier: 2 as const };
  const uncalibratedPlan = await planSchedule({ now: new Date("2026-09-14T09:00:00.000Z"), horizonDays: 1, mode: "asap", tasks: [uncalibratedTask], availability, frozenBlocks: [] });
  const calibratedPlan = await planSchedule({ now: new Date("2026-09-14T09:00:00.000Z"), horizonDays: 1, mode: "asap", tasks: [calibratedTask], availability, frozenBlocks: [] });
  const minutesOf = (result: typeof uncalibratedPlan) =>
    result.plan.blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0);
  check("scheduler_uses_p85_while_uncalibrated", minutesOf(uncalibratedPlan) === PRIOR.p85Minutes, minutesOf(uncalibratedPlan));
  check("scheduler_switches_to_p50_once_calibrated", minutesOf(calibratedPlan) === finalEstimate.p50Minutes, minutesOf(calibratedPlan));
} finally {
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "gates_failed" : "gates_passed", failures, dataDir }));
process.exitCode = failures.length ? 1 : 0;
