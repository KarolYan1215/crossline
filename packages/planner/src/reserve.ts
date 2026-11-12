// Kept apart from the optimizer so a client component can import it without pulling HiGHS, node:module and node:crypto into
// the browser bundle (the image build failed on it, 2026-11-11).
/**
 * What the calendar holds for a task. With no measured time behind the estimate (`confidence: "low"`) the plan adds 10% to the usual
 * time and lets measured time correct it (the person's decision of 2026-11-11, W-255): reserving p85 here, multiplied again by the
 * low-energy efficiency, gave a 90-minute step 3.5 hours of one day. Never more than p85, which `clampContinuousBuffers` lowers to
 * the longest slot for work that has to sit in one piece. A calibrated estimate is held at its p50.
 */
export function reserveMinutes(estimate: { p50Minutes: number; p85Minutes: number; confidence?: string | undefined }): number {
  return estimate.confidence === "low"
    ? Math.max(estimate.p50Minutes, Math.min(estimate.p85Minutes, Math.ceil(estimate.p50Minutes * 1.1 - 1e-9))) : estimate.p50Minutes;
}
