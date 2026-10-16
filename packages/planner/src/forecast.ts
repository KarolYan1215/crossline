import { tFor, type Locale } from "@crossline/i18n";
import type { PlannerTask } from "./index";

export type ForecastGoal = { id: string; title: string; importance: "important" | "ordinary";
  confirmedDeadline: string | null; weight?: number };
export type ForecastDay = { day: string; netMinutes: number; source: "declared" | "calendar_adjusted" };
export type GoalForecast = { milestoneId: string; title: string; p50Day: string | null; p85Day: string | null;
  suggestedTargetDay: string | null; confirmedDeadline: string | null; bottleneck: string | null;
  /** Whole days between the p85 finish and the deadline; null without both. The room the plan leaves for a bad week. */
  slackDays: number | null;
  p50Minutes: number; p85Minutes: number };
/**
 * One milestone's share of one week in the simulation. `p50Minutes`/`p85Minutes` are the minutes the usual and the cautious scenario
 * spend on it that week, plus the work that was due that week and did not get done in time (`*OverdueMinutes`, already included):
 * work done after the milestone's deadline, or still undone at the end of the horizon, counts in the week of the deadline, because
 * that is the week it was needed. A week's total can therefore exceed its usable minutes, and the excess is what was overloaded.
 */
export type WeekDemand = { milestoneId: string; p50Minutes: number; p85Minutes: number; p50OverdueMinutes: number; p85OverdueMinutes: number };
export type ForecastWeek = { week: number; netMinutes: number; reservedMinutes: number; usableMinutes: number; demand: WeekDemand[] };
export type ForecastResult = { weeks: ForecastWeek[]; goals: GoalForecast[] };

/** A goal that only just finishes at p85 has no room for the week that goes wrong; this much has to be left. */
export const DEADLINE_MARGIN_DAYS = 2;

/**
 * Daily capacity simulation, shared by p50 and p85 so the two dates have the same assumptions. The horizon is as many weeks as `days`
 * covers: eight for the usual 56 days; the plan page may ask for four, or up to six months.
 */
/** `locale`: the language of each goal's `bottleneck`, which the plan page shows as written (omitted = Chinese). */
export function forecastGoals(goals: ForecastGoal[], tasks: PlannerTask[], days: ForecastDay[],
  completedIds = new Set<string>(), locale?: Locale): ForecastResult {
  const t = tFor(locale);
  const weekCount = Math.max(1, Math.ceil(days.length / 7));
  const spans = Array.from({ length: weekCount }, (_, week) => {
    const netMinutes = days.slice(week * 7, week * 7 + 7).reduce((sum, day) => sum + day.netMinutes, 0);
    const usableMinutes = Math.floor(netMinutes * (week === 0 ? 0.85 : 0.8));
    return { week: week + 1, netMinutes, reservedMinutes: netMinutes - usableMinutes, usableMinutes };
  });
  const remaining = days.map((day, index) => Math.floor(day.netMinutes * (index < 7 ? 0.85 : 0.8)));
  const lastDay = days.at(-1)?.day ?? "";
  // The week a day falls in; a day before the horizon (a deadline already passed) belongs to the first week.
  const weekOfDay = (day: string) => { const index = days.findIndex((item) => item.day >= day); return index < 0 ? weekCount - 1 : Math.floor(index / 7); };
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const work = tasks.filter((task) => task.milestoneId && goalById.has(task.milestoneId));
  const priority = (a: PlannerTask, b: PlannerTask) => {
    const ga = goalById.get(a.milestoneId!)!;
    const gb = goalById.get(b.milestoneId!)!;
    const da = ga.confirmedDeadline ?? "9999-12-31";
    const db = gb.confirmedDeadline ?? "9999-12-31";
    return da.localeCompare(db) || (gb.weight ?? (gb.importance === "important" ? 75 : 40)) - (ga.weight ?? (ga.importance === "important" ? 75 : 40))
      || a.id.localeCompare(b.id);
  };
  const pending = new Map(work.map((task) => [task.id, task]));
  const ordered: PlannerTask[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((task) => (task.dependsOn ?? []).every((id) => !pending.has(id)))
      .sort(priority);
    if (!ready.length) break;
    for (const task of ready) { ordered.push(task); pending.delete(task.id); }
  }
  const cycleTasks = [...pending.values()];
  const cycles = new Set(cycleTasks.map((task) => task.milestoneId!));
  const scenario = (field: "p50Minutes" | "p85Minutes") => {
    const capacity = [...remaining];
    const finished = new Map<string, string>();
    const blocked = new Set<string>(cycles);
    // Minutes per week per milestone, and the part of them that was overdue.
    const load = Array.from({ length: weekCount }, () => new Map<string, { minutes: number; overdue: number }>());
    const charge = (week: number, milestoneId: string, minutes: number, overdue: boolean) => {
      if (minutes <= 0) return;
      const entry = load[week]!.get(milestoneId) ?? { minutes: 0, overdue: 0 };
      entry.minutes += minutes;
      if (overdue) entry.overdue += minutes;
      load[week]!.set(milestoneId, entry);
    };
    // Work still undone is overdue in its deadline's week when that deadline falls inside the horizon; otherwise it is only later.
    const leftOver = (goal: ForecastGoal, amount: number) => {
      if (goal.confirmedDeadline && goal.confirmedDeadline <= lastDay) charge(weekOfDay(goal.confirmedDeadline), goal.id, amount, true);
    };
    const followed = (goal: ForecastGoal) => goal.importance === "important" || Boolean(goal.confirmedDeadline);
    for (const task of cycleTasks) {
      const goal = goalById.get(task.milestoneId!)!;
      if (followed(goal)) leftOver(goal, task.estimate[field]);
    }
    for (const task of ordered) {
      const goal = goalById.get(task.milestoneId!)!;
      if (!followed(goal)) continue;
      let amount = task.estimate[field];
      const dependencyDays = (task.dependsOn ?? []).map((id) => finished.get(id)).filter((day): day is string => Boolean(day));
      if ((task.dependsOn ?? []).some((id) => !completedIds.has(id) && !finished.has(id))) {
        blocked.add(task.milestoneId!); leftOver(goal, amount); continue;
      }
      // Neither before its prerequisites finish nor before what it waits for is due to arrive.
      const release = task.notBefore ? task.notBefore.slice(0, 10) : "";
      const startDay = [...dependencyDays.sort().slice(-1), release].filter(Boolean).sort().at(-1);
      const first = startDay ? days.findIndex((day) => day.day >= startDay) : 0;
      if (first < 0) { blocked.add(task.milestoneId!); leftOver(goal, amount); continue; }
      for (let i = Math.max(0, first); i < days.length && amount > 0; i++) {
        const used = Math.min(amount, capacity[i]!);
        amount -= used;
        capacity[i]! -= used;
        const late = Boolean(goal.confirmedDeadline && days[i]!.day > goal.confirmedDeadline);
        charge(late ? weekOfDay(goal.confirmedDeadline!) : Math.floor(i / 7), goal.id, used, late);
        if (amount === 0) finished.set(task.id, days[i]!.day);
      }
      if (amount > 0) { blocked.add(task.milestoneId!); leftOver(goal, amount); }
    }
    return { finished, blocked, load };
  };
  const p50 = scenario("p50Minutes");
  const p85 = scenario("p85Minutes");
  const weeks = spans.map((span, index) => {
    const ids = [...new Set([...p50.load[index]!.keys(), ...p85.load[index]!.keys()])].sort();
    const demand = ids.map((milestoneId) => {
      const usual = p50.load[index]!.get(milestoneId), cautious = p85.load[index]!.get(milestoneId);
      return { milestoneId, p50Minutes: usual?.minutes ?? 0, p85Minutes: cautious?.minutes ?? 0,
        p50OverdueMinutes: usual?.overdue ?? 0, p85OverdueMinutes: cautious?.overdue ?? 0 };
    });
    return { ...span, demand };
  });

  return { weeks, goals: goals.map((goal) => {
    const own = work.filter((task) => task.milestoneId === goal.id);
    const finalDay = (result: { finished: Map<string, string>; blocked: Set<string> }) => {
      if (!own.length || result.blocked.has(goal.id)) return null;
      return own.map((task) => result.finished.get(task.id) ?? "").sort().at(-1) || null;
    };
    const p50Day = finalDay(p50);
    const p85Day = finalDay(p85);
    const slackDays = goal.confirmedDeadline && p85Day
      ? Math.round((Date.parse(`${goal.confirmedDeadline}T00:00:00Z`) - Date.parse(`${p85Day}T00:00:00Z`)) / 86_400_000) : null;
    const bottleneck = !own.length ? t("尚无绑定作业；需先反推步骤")
      : goal.importance === "ordinary" && !goal.confirmedDeadline ? t("第四象限暂缓；请确认日期或提升重要性")
        : !p85Day ? (weekCount === 8 ? t("八周内容量或步骤依赖不足") : t("{{count}} 周内容量或步骤依赖不足", { count: weekCount }))
          : goal.confirmedDeadline && p85Day > goal.confirmedDeadline ? t("p85 情景晚于已确认截止时间")
            : slackDays !== null && slackDays < DEADLINE_MARGIN_DAYS ? t("p85 情景只比截止早 {{slack}} 天，没有留出 {{margin}} 天的余量", { slack: slackDays, margin: DEADLINE_MARGIN_DAYS }) : null;
    return { milestoneId: goal.id, title: goal.title, p50Day, p85Day,
      suggestedTargetDay: goal.confirmedDeadline ? null : p85Day,
      confirmedDeadline: goal.confirmedDeadline, bottleneck, slackDays,
      p50Minutes: own.reduce((sum, task) => sum + task.estimate.p50Minutes, 0),
      p85Minutes: own.reduce((sum, task) => sum + task.estimate.p85Minutes, 0) };
  }) };
}
