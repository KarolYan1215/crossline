import type { ForecastResult } from "@crossline/planner";

/** What the comparison reads: each goal's dates and each week's net minutes (not the per-week demand). */
export type ForecastSummary = { goals: ForecastResult["goals"]; weeks: Array<{ week: number; netMinutes: number }> };

const hours = (minutes: number) => `${Math.round(minutes / 6) / 10} 小时`;
/** At most this many lines; the rest is counted. A first approval of fifteen milestones listed fifteen lines and eight weeks in minutes. */
const MAX_LINES = 5;

/** Comparison with the last forecast the person actually viewed, not an invented historical promise. */
export function forecastDiff(previous: ForecastSummary, current: ForecastSummary): string[] {
  const moved: string[] = [];
  const before = new Map(previous.goals.map((goal) => [goal.milestoneId, goal]));
  const added = current.goals.filter((goal) => !before.has(goal.milestoneId));
  for (const goal of current.goals) {
    const old = before.get(goal.milestoneId);
    if (old && old.p85Day !== goal.p85Day)
      moved.push(`「${goal.title}」保守完成日 ${old.p85Day ?? "无法推算"} → ${goal.p85Day ?? "无法推算"}`);
  }
  const weeks = current.weeks.flatMap((week) => {
    const old = previous.weeks.find((item) => item.week === week.week);
    return old && old.netMinutes !== week.netMinutes ? [{ week: week.week, from: old.netMinutes, to: week.netMinutes }] : [];
  });
  const changes = [
    ...moved,
    ...(added.length === 1 ? [`新增里程碑「${added[0]!.title}」`] : added.length ? [`新增 ${added.length} 个里程碑`] : []),
    // Every week changing the same way (new availability) is one line, not eight.
    ...(weeks.length > 1 && weeks.every((week) => week.to - week.from === weeks[0]!.to - weeks[0]!.from)
      ? [`每周净可用时间 ${weeks[0]!.to > weeks[0]!.from ? "增加" : "减少"} ${hours(Math.abs(weeks[0]!.to - weeks[0]!.from))}（共 ${weeks.length} 周）`]
      : weeks.map((week) => `第 ${week.week} 周净可用时间 ${hours(week.from)} → ${hours(week.to)}`))
  ];
  return changes.length > MAX_LINES ? [...changes.slice(0, MAX_LINES - 1), `另有 ${changes.length - MAX_LINES + 1} 项变化`] : changes;
}
