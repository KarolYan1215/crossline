import type { ForecastResult } from "@crossline/planner";
import { monthDay, tFor, type Locale } from "./i18n";

/** What the comparison reads: each goal's dates and each week's net minutes (not the per-week demand). */
export type ForecastSummary = { goals: ForecastResult["goals"]; weeks: Array<{ week: number; netMinutes: number }> };

/** At most this many lines; the rest is counted. A first approval of fifteen milestones listed fifteen lines and eight weeks in minutes. */
const MAX_LINES = 5;

/** Comparison with the last forecast the person actually viewed, not an invented historical promise. */
export function forecastDiff(previous: ForecastSummary, current: ForecastSummary, locale?: Locale): string[] {
  const t = tFor(locale);
  const hours = (minutes: number) => t("{{hours}} 小时", { hours: Math.round(minutes / 6) / 10 });
  const day = (value: string | null) => value ? (locale === "en" ? monthDay(locale, value) : value) : t("无法推算");
  const moved: string[] = [];
  const before = new Map(previous.goals.map((goal) => [goal.milestoneId, goal]));
  const added = current.goals.filter((goal) => !before.has(goal.milestoneId));
  for (const goal of current.goals) {
    const old = before.get(goal.milestoneId);
    if (old && old.p85Day !== goal.p85Day)
      moved.push(t("「{{title}}」保守完成日 {{from}} → {{to}}", { title: goal.title, from: day(old.p85Day), to: day(goal.p85Day) }));
  }
  const weeks = current.weeks.flatMap((week) => {
    const old = previous.weeks.find((item) => item.week === week.week);
    return old && old.netMinutes !== week.netMinutes ? [{ week: week.week, from: old.netMinutes, to: week.netMinutes }] : [];
  });
  const changes = [
    ...moved,
    ...(added.length === 1 ? [t("新增里程碑「{{title}}」", { title: added[0]!.title })] : added.length ? [t("新增 {{count}} 个里程碑", { count: added.length })] : []),
    // Every week changing the same way (new availability) is one line, not eight.
    ...(weeks.length > 1 && weeks.every((week) => week.to - week.from === weeks[0]!.to - weeks[0]!.from)
      ? [t(weeks[0]!.to > weeks[0]!.from ? "每周净可用时间 增加 {{hours}}（共 {{count}} 周）" : "每周净可用时间 减少 {{hours}}（共 {{count}} 周）",
        { hours: hours(Math.abs(weeks[0]!.to - weeks[0]!.from)), count: weeks.length })]
      : weeks.map((week) => t("第 {{week}} 周净可用时间 {{from}} → {{to}}", { week: week.week, from: hours(week.from), to: hours(week.to) })))
  ];
  return changes.length > MAX_LINES ? [...changes.slice(0, MAX_LINES - 1), t("另有 {{count}} 项变化", { count: changes.length - MAX_LINES + 1 })] : changes;
}
