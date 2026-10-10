import type { ForecastResult } from "@crossline/planner";

/** What the comparison reads: each goal's dates and each week's net minutes (not the per-week demand). */
export type ForecastSummary = { goals: ForecastResult["goals"]; weeks: Array<{ week: number; netMinutes: number }> };

/** Comparison with the last forecast the person actually viewed, not an invented historical promise. */
export function forecastDiff(previous: ForecastSummary, current: ForecastSummary): string[] {
  const changes: string[] = [];
  const before = new Map(previous.goals.map((goal) => [goal.milestoneId, goal]));
  for (const goal of current.goals) {
    const old = before.get(goal.milestoneId);
    if (!old) { changes.push(`新增里程碑「${goal.title}」`); continue; }
    if (old.p85Day !== goal.p85Day)
      changes.push(`「${goal.title}」保守完成日 ${old.p85Day ?? "无法推算"} → ${goal.p85Day ?? "无法推算"}`);
  }
  for (const week of current.weeks) {
    const old = previous.weeks.find((item) => item.week === week.week);
    if (old && old.netMinutes !== week.netMinutes)
      changes.push(`第 ${week.week} 周净可用时间 ${old.netMinutes} → ${week.netMinutes} 分钟`);
  }
  return changes;
}
