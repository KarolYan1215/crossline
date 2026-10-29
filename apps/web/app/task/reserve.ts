/**
 * What the calendar holds for a step, said beside its usual time (walkthrough W-153, 2026-10-29). The planner reserves a low-confidence
 * estimate at its cautious figure (p85, `durationOf` in `@crossline/planner`) while the card says the usual one (p50): 「约 25 分」 on
 * the card and a 50-minute block on the calendar, with nothing on the page saying why. The card now says both, one wording everywhere:
 * 「约 25 分 · 预留 50 分」, with the reason on hover.
 */
export function reservedMinutes(estimate: { p50Minutes: number; p85Minutes: number }, confidence: string | undefined): number | undefined {
  return confidence === "low" && estimate.p85Minutes >= estimate.p50Minutes + 5 ? estimate.p85Minutes : undefined;
}
