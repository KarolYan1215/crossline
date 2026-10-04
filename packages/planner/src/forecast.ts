import type { PlannerTask } from "./index";

export type ForecastGoal = { id: string; title: string; importance: "important" | "ordinary";
  confirmedDeadline: string | null };
export type ForecastDay = { day: string; netMinutes: number; source: "declared" | "calendar_adjusted" };
export type GoalForecast = { milestoneId: string; title: string; p50Day: string | null; p85Day: string | null;
  suggestedTargetDay: string | null; confirmedDeadline: string | null; bottleneck: string | null;
  /** Whole days between the p85 finish and the deadline; null without both. The room the plan leaves for a bad week. */
  slackDays: number | null;
  p50Minutes: number; p85Minutes: number };
export type ForecastResult = { weeks: Array<{ week: number; netMinutes: number; reservedMinutes: number;
  usableMinutes: number }>; goals: GoalForecast[] };

/** A goal that only just finishes at p85 has no room for the week that goes wrong; this much has to be left. */
export const DEADLINE_MARGIN_DAYS = 2;

/** Daily capacity simulation, shared by p50 and p85 so the two dates have the same assumptions. */
export function forecastGoals(goals: ForecastGoal[], tasks: PlannerTask[], days: ForecastDay[],
  completedIds = new Set<string>()): ForecastResult {
  const weeks = Array.from({ length: 8 }, (_, week) => {
    const netMinutes = days.slice(week * 7, week * 7 + 7).reduce((sum, day) => sum + day.netMinutes, 0);
    const usableMinutes = Math.floor(netMinutes * (week === 0 ? 0.85 : 0.8));
    return { week: week + 1, netMinutes, reservedMinutes: netMinutes - usableMinutes, usableMinutes };
  });
  const remaining = days.map((day, index) => Math.floor(day.netMinutes * (index < 7 ? 0.85 : 0.8)));
  const goalById = new Map(goals.map((goal) => [goal.id, goal]));
  const work = tasks.filter((task) => task.milestoneId && goalById.has(task.milestoneId));
  const priority = (a: PlannerTask, b: PlannerTask) => {
    const ga = goalById.get(a.milestoneId!)!;
    const gb = goalById.get(b.milestoneId!)!;
    const da = ga.confirmedDeadline ?? "9999-12-31";
    const db = gb.confirmedDeadline ?? "9999-12-31";
    return da.localeCompare(db) || (ga.importance === "important" ? 0 : 1)
      - (gb.importance === "important" ? 0 : 1) || a.id.localeCompare(b.id);
  };
  const pending = new Map(work.map((task) => [task.id, task]));
  const ordered: PlannerTask[] = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((task) => (task.dependsOn ?? []).every((id) => !pending.has(id)))
      .sort(priority);
    if (!ready.length) break;
    for (const task of ready) { ordered.push(task); pending.delete(task.id); }
  }
  const cycles = new Set([...pending.values()].map((task) => task.milestoneId!));
  const scenario = (field: "p50Minutes" | "p85Minutes") => {
    const capacity = [...remaining];
    const finished = new Map<string, string>();
    const blocked = new Set<string>(cycles);
    for (const task of ordered) {
      const goal = goalById.get(task.milestoneId!)!;
      if (goal.importance === "ordinary" && !goal.confirmedDeadline) continue;
      let amount = task.estimate[field];
      const dependencyDays = (task.dependsOn ?? []).map((id) => finished.get(id)).filter((day): day is string => Boolean(day));
      if ((task.dependsOn ?? []).some((id) => !completedIds.has(id) && !finished.has(id))) {
        blocked.add(task.milestoneId!); continue;
      }
      const first = dependencyDays.length ? days.findIndex((day) => day.day >= dependencyDays.sort().at(-1)!) : 0;
      for (let i = Math.max(0, first); i < days.length && amount > 0; i++) {
        const used = Math.min(amount, capacity[i]!);
        amount -= used;
        capacity[i]! -= used;
        if (amount === 0) finished.set(task.id, days[i]!.day);
      }
      if (amount > 0) blocked.add(task.milestoneId!);
    }
    return { finished, blocked };
  };
  const p50 = scenario("p50Minutes");
  const p85 = scenario("p85Minutes");
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
    const bottleneck = !own.length ? "尚无绑定作业；需先反推步骤"
      : goal.importance === "ordinary" && !goal.confirmedDeadline ? "第四象限暂缓；请确认日期或提升重要性"
        : !p85Day ? "八周内容量或步骤依赖不足"
          : goal.confirmedDeadline && p85Day > goal.confirmedDeadline ? "p85 情景晚于已确认截止时间"
            : slackDays !== null && slackDays < DEADLINE_MARGIN_DAYS ? `p85 情景只比截止早 ${slackDays} 天，没有留出 ${DEADLINE_MARGIN_DAYS} 天的余量` : null;
    return { milestoneId: goal.id, title: goal.title, p50Day, p85Day,
      suggestedTargetDay: goal.confirmedDeadline ? null : p85Day,
      confirmedDeadline: goal.confirmedDeadline, bottleneck, slackDays,
      p50Minutes: own.reduce((sum, task) => sum + task.estimate.p50Minutes, 0),
      p85Minutes: own.reduce((sum, task) => sum + task.estimate.p85Minutes, 0) };
  }) };
}
