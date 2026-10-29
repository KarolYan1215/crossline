/**
 * How long clearing 待确认 takes (2026-10-29, after Akiflow's 「N items · about X min」 group head): what the page decides, each kind at
 * its own pace. A question takes what the person's own timed answers took (the median of `seconds` on `ask.answered`/`ask.snoozed`)
 * once there are five, else `ASK_SECONDS`; an assistant result is read, so it is given longer. Rounded up to whole minutes.
 */
export const ASK_SECONDS = 45;
const SECONDS = { workOrders: 30, evidence: 60, assistantReviews: 120, assistantOther: 30 } as const;
export const MEASURED_MIN = 5;

export function clearMinutes(counts: { asks: number; workOrders: number; evidence: number; assistantReviews: number; assistantOther: number },
  measured: number[] = []): number {
  const sorted = measured.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const perAsk = sorted.length >= MEASURED_MIN ? sorted[Math.floor(sorted.length / 2)]! : ASK_SECONDS;
  const seconds = counts.asks * perAsk + counts.workOrders * SECONDS.workOrders + counts.evidence * SECONDS.evidence
    + counts.assistantReviews * SECONDS.assistantReviews + counts.assistantOther * SECONDS.assistantOther;
  return seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 0;
}
