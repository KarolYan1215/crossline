import { workedRhythm, type AvailabilityWindow } from "@crossline/core";
import type { ForecastWeek, GoalForecast } from "@crossline/planner";
import type { Translate } from "./i18n";

/**
 * The plan page's long-range statistics as pure functions of what the ledger and the forecast already hold (decided 2026-10-10,
 * docs/flywheel-and-views.md §3): the horizon, capacity against demand per week and line, the milestone finish ranges, planned against
 * timed hours per line, estimate accuracy and the weekly rhythm. Nothing here reads the store, so the server loader
 * (`lib/plan-board.ts`) and the preview (`lib/impact.ts`) share one computation and the tests need no database.
 */

const DAY = 86_400_000;
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

/* ── horizon ── */

export type HorizonChoice = "4" | "8" | "far";
/** 「到最远截止」 stops at six months: past that a weekly bar is too thin to read and the estimates behind it are guesses. */
export const HORIZON_CAP_DAYS = 182;
export type Horizon = { choice: HorizonChoice; days: number; weeks: number;
  /** The farthest deadline of an approved milestone from today on; null when there is none (and so no 「到最远截止」). */
  farthest: string | null; capped: boolean };

/** The horizon the page draws: eight weeks unless four or 「到最远截止」 was chosen; whole weeks, at least one, at most 26. */
export function horizonFor(requested: string | undefined, today: string, deadlines: Array<string | null | undefined>): Horizon {
  const future = deadlines.filter((day): day is string => Boolean(day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= today)).sort();
  const farthest = future.at(-1) ?? null;
  if (requested === "4") return { choice: "4", days: 28, weeks: 4, farthest, capped: false };
  if (requested === "far" && farthest) {
    const span = daysBetween(today, farthest) + 1;
    const days = Math.min(HORIZON_CAP_DAYS, Math.max(7, Math.ceil(span / 7) * 7));
    return { choice: "far", days, weeks: days / 7, farthest, capped: span > HORIZON_CAP_DAYS };
  }
  return { choice: "8", days: 56, weeks: 8, farthest, capped: false };
}

/* ── capacity and demand ── */

/** One line's part of one week's bar, in minutes: already given a block, still to be placed, and what the cautious estimate adds. */
export type LineLoad = { line: string; scheduled: number; pending: number; extra: number };
export type CapacityWeek = {
  week: number; start: string; end: string; netMinutes: number; usableMinutes: number;
  lines: LineLoad[];
  /** Usual demand (scheduled + pending) and with the cautious extra on top. */
  totalP50: number; totalP85: number;
  /** Demand over the usable minutes; zero when it fits. */
  overloadMinutes: number; overloadP85Minutes: number;
  /** Work that was due this week and is done late or not at all (part of the totals). */
  overdueMinutes: number;
  /** The milestone that takes most of the week, usual scenario. */
  top: { milestoneId: string; title: string; minutes: number } | null;
};

export function capacityWeeks(input: { today: string; weeks: ForecastWeek[]; lineOf: Record<string, string>; titleOf: Record<string, string>;
  /** Minutes of blocks the scheduler placed, by day and line. */
  scheduled: Array<{ day: string; line: string; minutes: number }>; lineOrder: string[] }): CapacityWeek[] {
  const rank = (line: string) => { const index = input.lineOrder.indexOf(line); return index < 0 ? input.lineOrder.length : index; };
  return input.weeks.map((week, index) => {
    const start = addDays(input.today, index * 7), end = addDays(start, 6);
    const usual = new Map<string, number>(), cautious = new Map<string, number>();
    let overdue = 0;
    for (const item of week.demand) {
      const line = input.lineOf[item.milestoneId] ?? "none";
      usual.set(line, (usual.get(line) ?? 0) + item.p50Minutes);
      cautious.set(line, (cautious.get(line) ?? 0) + item.p85Minutes);
      overdue += item.p50OverdueMinutes;
    }
    const booked = new Map<string, number>();
    for (const block of input.scheduled) if (block.day >= start && block.day <= end) booked.set(block.line, (booked.get(block.line) ?? 0) + block.minutes);
    const lines = [...new Set([...usual.keys(), ...cautious.keys(), ...booked.keys()])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map((line) => {
      // A block the scheduler placed is real time whether or not the forecast followed its milestone, so a line is never drawn below it.
      const scheduled = booked.get(line) ?? 0;
      const total = Math.max(scheduled, usual.get(line) ?? 0);
      return { line, scheduled, pending: total - scheduled, extra: Math.max(0, (cautious.get(line) ?? 0) - total) };
    }).filter((line) => line.scheduled + line.pending + line.extra > 0);
    const totalP50 = lines.reduce((sum, line) => sum + line.scheduled + line.pending, 0);
    const totalP85 = totalP50 + lines.reduce((sum, line) => sum + line.extra, 0);
    const topItem = [...week.demand].sort((a, b) => b.p50Minutes - a.p50Minutes || a.milestoneId.localeCompare(b.milestoneId))[0];
    return { week: week.week, start, end, netMinutes: week.netMinutes, usableMinutes: week.usableMinutes, lines, totalP50, totalP85,
      overloadMinutes: Math.max(0, totalP50 - week.usableMinutes), overloadP85Minutes: Math.max(0, totalP85 - week.usableMinutes),
      overdueMinutes: overdue,
      top: topItem && topItem.p50Minutes > 0 ? { milestoneId: topItem.milestoneId, title: input.titleOf[topItem.milestoneId] ?? "", minutes: topItem.p50Minutes } : null };
  });
}

/* ── milestone finish ranges ── */

export type GoalRowStatus = "forecast" | "no_tasks" | "unforecast" | "unfinished";
export type GoalRow = { id: string; title: string; line: string; p50Day: string | null; p85Day: string | null; deadline: string | null;
  slackDays: number | null; atRisk: boolean; remainingP50Minutes: number; remainingP85Minutes: number;
  /** The earliest day one of its tasks leaves the task library and is scheduled; null when none waits there. */
  libraryDay: string | null; status: GoalRowStatus; bottleneck: string | null;
  /** Task proposals for it waiting for the person: a milestone with none approved yet is not 「尚无任务」 when work is proposed. */
  proposals: number };

export function goalRows(input: { goals: GoalForecast[]; lineOf: Record<string, string>; lineOrder: string[]; marginDays: number;
  /** Milestones the forecast does not follow (ordinary importance, no deadline). */ unforecast: Set<string>;
  library: Array<{ milestoneId: string; libraryUntil: string | null }>; proposals?: Record<string, number> }): GoalRow[] {
  const libraryDay = new Map<string, string>();
  for (const task of input.library) {
    if (!task.libraryUntil) continue;
    const known = libraryDay.get(task.milestoneId);
    if (!known || task.libraryUntil < known) libraryDay.set(task.milestoneId, task.libraryUntil);
  }
  const rank = (line: string) => { const index = input.lineOrder.indexOf(line); return index < 0 ? input.lineOrder.length : index; };
  return input.goals.map((goal): GoalRow => {
    const status: GoalRowStatus = !goal.p50Minutes ? "no_tasks" : input.unforecast.has(goal.milestoneId) ? "unforecast" : goal.p85Day ? "forecast" : "unfinished";
    return { id: goal.milestoneId, title: goal.title, line: input.lineOf[goal.milestoneId] ?? "none", p50Day: goal.p50Day, p85Day: goal.p85Day,
      deadline: goal.confirmedDeadline, slackDays: goal.slackDays, atRisk: goal.slackDays !== null && goal.slackDays < input.marginDays,
      remainingP50Minutes: goal.p50Minutes, remainingP85Minutes: goal.p85Minutes, libraryDay: libraryDay.get(goal.milestoneId) ?? null, status,
      bottleneck: goal.bottleneck, proposals: input.proposals?.[goal.milestoneId] ?? 0 };
  }).sort((a, b) => rank(a.line) - rank(b.line) || a.line.localeCompare(b.line) || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
    || a.title.localeCompare(b.title));
}

/* ── one timeline per line ── */

/**
 * What can be said about a milestone at a glance (decided 2026-10-15, the plan page's top): it may not finish in time (its cautious finish
 * leaves under the margin, or it does not finish inside the horizon), nothing is ready to work on yet (no task, or only proposals
 * waiting), or its tasks still wait in the task library. A milestone can be several at once; none means on track.
 */
export type MilestoneState = "risk" | "unprepared" | "library";
export const MILESTONE_STATE_ORDER: MilestoneState[] = ["risk", "unprepared", "library"];
export type MilestoneMark = { id: string; title: string; line: string;
  /** Where it sits: the deadline, else the cautious finish, else the usual one; null in the 「未定日期」 zone. */
  day: string | null; states: MilestoneState[]; row: GoalRow };

export function milestoneMarks(rows: GoalRow[], today: string): MilestoneMark[] {
  return rows.map((row) => {
    const states: MilestoneState[] = [];
    if (row.atRisk || row.status === "unfinished") states.push("risk");
    if (row.status === "no_tasks") states.push("unprepared");
    if (row.libraryDay && row.libraryDay > today) states.push("library");
    return { id: row.id, title: row.title, line: row.line, day: row.deadline ?? row.p85Day ?? row.p50Day, states, row };
  });
}

/**
 * What the timeline shows by default (decided 2026-10-15): the unfinished milestones due inside the chosen horizon, and those already
 * past their day and not finished; the rest are counted, not drawn. `done`: milestones whose work is all accepted.
 */
export function timelineMarks(marks: MilestoneMark[], today: string, horizonDays: number, done: ReadonlySet<string>): { shown: MilestoneMark[]; outside: number } {
  const end = addDays(today, horizonDays);
  const shown = marks.filter((mark) => !done.has(mark.id) && mark.day !== null && mark.day <= end);
  return { shown, outside: marks.length - shown.length };
}

/* ── planned against timed hours ── */

export type ExecutionLike = { workOrderId: string; startedAt: string; endedAt?: string | undefined; pauseMinutes: number;
  interruptions?: Array<{ pausedAt: string; resumedAt?: string | undefined }> };
export type InvestmentWeek = { start: string; end: string;
  /** Days of this week with a recorded plan length; the planned figure covers only these. */ recordedDays: number;
  planned: Record<string, number>; actual: Record<string, number> };
export type InvestmentLine = { line: string;
  /** Percent of the person's stated time (interview), of the timed hours in the four weeks, and of the planned hours; null without data. */
  stated: number | null; actualShare: number | null; plannedShare: number | null };
export type Investment = { weeks: InvestmentWeek[]; next7: Record<string, number>; lines: InvestmentLine[]; hasActual: boolean; hasPlanned: boolean };

/** Worked minutes of an execution: wall clock to its end (or now, while it runs), less its pauses. */
export function workedMinutes(execution: ExecutionLike, now: string): number {
  const end = execution.endedAt ?? now;
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(execution.startedAt)) / 60_000) - execution.pauseMinutes);
}

/** The calendar day of an instant in a zone. */
export function localDay(instant: string, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

/**
 * The last four weeks, oldest first, each ending on today − 7k (today's own plan and timer count in the newest), per line: the minutes
 * the plan gave each day (`schedule.minutes:<day>`, summed by the order's line) against the minutes the timer recorded. The next seven
 * days' plan comes from the live schedule, so a preview can move it.
 */
export function investment(input: { today: string; zone: string; now: string; lineOrder: string[];
  plannedByDay: Record<string, Record<string, number> | null>; orderLine: Record<string, string>;
  executions: ExecutionLike[]; next7: Record<string, number>; stated: Record<string, number> | null }): Investment {
  const weeks: InvestmentWeek[] = [3, 2, 1, 0].map((back) => {
    const end = addDays(input.today, -7 * back), start = addDays(end, -6);
    const planned: Record<string, number> = {}, actual: Record<string, number> = {};
    let recordedDays = 0;
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const record = input.plannedByDay[day];
      if (!record) continue;
      recordedDays += 1;
      for (const [order, minutes] of Object.entries(record)) {
        const line = input.orderLine[order];
        if (line) planned[line] = (planned[line] ?? 0) + minutes;
      }
    }
    for (const execution of input.executions) {
      const day = localDay(execution.startedAt, input.zone);
      const line = input.orderLine[execution.workOrderId];
      if (!line || day < start || day > end) continue;
      actual[line] = (actual[line] ?? 0) + workedMinutes(execution, input.now);
    }
    return { start, end, recordedDays, planned, actual };
  });
  const sum = (field: "planned" | "actual", line: string) => weeks.reduce((total, week) => total + (week[field][line] ?? 0), 0);
  const present = new Set([...input.lineOrder, ...weeks.flatMap((week) => [...Object.keys(week.planned), ...Object.keys(week.actual)]), ...Object.keys(input.next7)]);
  const rank = (line: string) => { const index = input.lineOrder.indexOf(line); return index < 0 ? input.lineOrder.length : index; };
  // Only the person's own lines: an order filed under something else (a real one sat under 「\」 before the analysis refused unknown lines)
  // used to appear as a line of its own.
  const known = new Set(input.lineOrder);
  const lineIds = [...present].filter((line) => !known.size || known.has(line)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const totalActual = lineIds.reduce((total, line) => total + sum("actual", line), 0);
  const totalPlanned = lineIds.reduce((total, line) => total + sum("planned", line), 0);
  const share = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 100) : null;
  return {
    weeks, next7: input.next7,
    lines: lineIds.map((line) => ({ line, stated: input.stated ? input.stated[line] ?? 0 : null,
      actualShare: share(sum("actual", line), totalActual), plannedShare: share(sum("planned", line), totalPlanned) })),
    hasActual: totalActual > 0, hasPlanned: weeks.some((week) => week.recordedDays > 0)
  };
}

/**
 * The share of their time the person said each line gets: the interview's portrait (`share`, percent) when it gave one, otherwise each
 * line's own stated weekly hours. Normalised to 100; null when neither exists.
 */
export function statedShares(portrait: Array<{ lineId: string; share?: number | undefined }> | null,
  facts: Array<{ identityId: string; slot: string; status: string; value: string }>, hoursFromText: (text: string) => number | null): Record<string, number> | null {
  const fromPortrait = (portrait ?? []).filter((item) => typeof item.share === "number" && item.share > 0);
  const raw = new Map<string, number>();
  if (fromPortrait.length) for (const item of fromPortrait) raw.set(item.lineId, (raw.get(item.lineId) ?? 0) + item.share!);
  else for (const fact of facts) {
    // A total over everything (「所有事情合计每周约 72 小时」) is not one line's share.
    if (fact.slot !== "weekly_hours" || fact.status !== "confirmed" || /合计|所有|总共|一共/.test(fact.value)) continue;
    const hours = hoursFromText(fact.value);
    if (hours && hours > 0 && hours <= 112) raw.set(fact.identityId, Math.max(raw.get(fact.identityId) ?? 0, hours));
  }
  const total = [...raw.values()].reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  return Object.fromEntries([...raw].map(([line, value]) => [line, Math.round((value / total) * 100)]));
}

/* ── estimate accuracy ── */

export type EstimatePoint = { id: string; line: string; estimate: number; p85: number; actual: number; covered: boolean };
export function estimatePoints(observations: Array<{ id: string; identityId: string; observedMinutes: number; censored: boolean;
  llmP50Minutes: number | null; llmP85Minutes: number | null; baselineP50Minutes: number; baselineP85Minutes: number }>): { points: EstimatePoint[]; covered: number; coverage: number | null } {
  const points = observations.filter((row) => !row.censored && row.observedMinutes > 0).flatMap((row) => {
    const estimate = row.llmP50Minutes ?? row.baselineP50Minutes, p85 = row.llmP85Minutes ?? row.baselineP85Minutes;
    if (!(estimate > 0)) return [];
    return [{ id: row.id, line: row.identityId, estimate, p85: Math.max(p85, estimate), actual: row.observedMinutes, covered: row.observedMinutes <= Math.max(p85, estimate) }];
  });
  const covered = points.filter((point) => point.covered).length;
  return { points, covered, coverage: points.length ? Math.round((covered / points.length) * 100) / 100 : null };
}

/* ── rhythm ── */

/**
 * Minutes worked per weekday (0 = Sunday) × hour, every pause cut out: `workedRhythm` in core, which the worker's weekly energy advice
 * reads too, so the page and the advice see the same rhythm.
 */
export const rhythmGrid = (executions: ExecutionLike[], zone: string, now: string): number[][] => workedRhythm(executions, zone, now);

/** The availability pattern on the same weekday × hour grid: the share of each hour the person marked available (0–1). */
export function availabilityGrid(windows: AvailabilityWindow[]): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const minutes = (clock: string) => { const [h, m] = clock.split(":").map(Number); return h! * 60 + m!; };
  for (const window of windows) {
    const from = minutes(window.start), to = minutes(window.end);
    for (const day of window.days) for (let hour = 0; hour < 24; hour++) {
      const covered = Math.max(0, Math.min(to, hour * 60 + 60) - Math.max(from, hour * 60));
      if (covered > 0 && grid[day]) grid[day]![hour] = Math.min(1, grid[day]![hour]! + covered / 60);
    }
  }
  return grid;
}

/* ── the plan page's head (2026-10-28 redesign) ── */

/** What `planRanking` says of one task, as far as the page's head needs it (`RankedTask` in lib/crossline.ts, server-only). */
export type RankedLike = { id: string; title: string; line: string; deadline: string | null; notBefore: string | null; firstDay: string | null;
  blocker: string | null; libraryUntil: string | null; p50Minutes: number };
/** A task the schedule did not place in full: wholly (`partial` false) or some of its steps (`partial` true), with the planner's reason. */
export type UnplacedItem = { id: string; title: string; line: string; deadline: string | null; notBefore: string | null; minutes: number;
  partial: boolean; reason: string | null };

/**
 * 「排不下的原因」 (Motion's 「Could not fit」, Todoist's Plan list): every task outside the task library that has no block at all, and
 * every one the planner reported a step of as unplaced (`blocked`, from `unplacedTaskIds`), soonest deadline first.
 */
export function unplacedItems(ranking: RankedLike[], blocked: ReadonlySet<string>): UnplacedItem[] {
  return ranking.filter((task) => !task.libraryUntil && (!task.firstDay || blocked.has(task.id)))
    .map((task) => ({ id: task.id, title: task.title, line: task.line, deadline: task.deadline, notBefore: task.notBefore, minutes: task.p50Minutes,
      partial: Boolean(task.firstDay), reason: task.blocker }))
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.title.localeCompare(b.title));
}

/** The four figures over the plan page: this week's usable and scheduled minutes, what could not be placed, and the estimate bias. */
export type PlanKpis = { usableMinutes: number; scheduledMinutes: number;
  unplaced: { count: number; minutes: number; earliest: string | null };
  /** The median of actual ÷ estimate, less one, in percent; null with no timed observation. */
  bias: { percent: number; samples: number } | null };

export function planKpis(input: { capacity: CapacityWeek[]; unplaced: UnplacedItem[]; estimates: EstimatePoint[] }): PlanKpis {
  const week = input.capacity[0];
  const ratios = input.estimates.map((point) => point.actual / point.estimate).sort((a, b) => a - b);
  const half = Math.floor(ratios.length / 2);
  const middle = !ratios.length ? null : ratios.length % 2 ? ratios[half]! : (ratios[half - 1]! + ratios[half]!) / 2;
  const deadlines = input.unplaced.flatMap((item) => item.deadline ? [item.deadline] : []).sort();
  return {
    usableMinutes: week?.usableMinutes ?? 0,
    scheduledMinutes: week?.lines.reduce((sum, line) => sum + line.scheduled, 0) ?? 0,
    unplaced: { count: input.unplaced.length, minutes: input.unplaced.reduce((sum, item) => sum + item.minutes, 0), earliest: deadlines[0] ?? null },
    bias: middle === null ? null : { percent: Math.round((middle - 1) * 100), samples: ratios.length }
  };
}

/** One line in 「各线排程 vs 份额」: its share of the coming weeks' usable hours against the work planned for it, minutes a week. */
export type LineShareRow = { line: string; share: number; shareMinutes: number; plannedMinutes: number; scheduledMinutes: number;
  /** The planned minutes before a previewed change; null without a preview. */ beforeMinutes: number | null };

/**
 * The coming weeks only (decided 2026-10-28: looking back is the weekly review's): for each line with a share or with work, its share of
 * the average usable minutes over the first `weeks` weeks, beside the minutes a week planned for it — scheduled plus still to place,
 * usual estimate — so a line short of its share shows as a short bar under a long light one.
 */
export function lineShareRows(input: { capacity: CapacityWeek[]; shares: Record<string, number>; lineOrder: string[]; weeks?: number;
  before?: CapacityWeek[] | null }): LineShareRow[] {
  const span = input.capacity.slice(0, input.weeks ?? 4);
  const count = Math.max(1, span.length);
  const usable = span.reduce((sum, week) => sum + week.usableMinutes, 0) / count;
  const sum = (weeks: CapacityWeek[], line: string, part: (item: LineLoad) => number) => weeks.slice(0, count)
    .reduce((total, week) => total + week.lines.filter((item) => item.line === line).reduce((inner, item) => inner + part(item), 0), 0) / count;
  const planned = (item: LineLoad) => item.scheduled + item.pending;
  const lines = [...new Set([...input.lineOrder, ...span.flatMap((week) => week.lines.map((item) => item.line))])]
    .filter((line) => line !== "none" && ((input.shares[line] ?? 0) > 0 || sum(span, line, planned) > 0));
  return lines.map((line) => ({ line, share: input.shares[line] ?? 0, shareMinutes: Math.round((input.shares[line] ?? 0) / 100 * usable),
    plannedMinutes: Math.round(sum(span, line, planned)), scheduledMinutes: Math.round(sum(span, line, (item) => item.scheduled)),
    beforeMinutes: input.before ? Math.round(sum(input.before, line, planned)) : null }));
}

/** The plan page's one line about milestones (the timeline itself is on 主线): how many fall in the horizon and which are in trouble. */
export function milestoneSummary(rows: GoalRow[], today: string, horizonDays: number, done: ReadonlySet<string>): { shown: number; outside: number;
  risk: MilestoneMark[]; unprepared: number; library: number } {
  const { shown, outside } = timelineMarks(milestoneMarks(rows, today), today, horizonDays, done);
  return { shown: shown.length, outside, risk: shown.filter((mark) => mark.states.includes("risk")),
    unprepared: shown.filter((mark) => mark.states.includes("unprepared")).length, library: shown.filter((mark) => mark.states.includes("library")).length };
}

/* ── what a preview changes ── */

/** The part of the page a previewed change moves: drawn as it would be, with the current values as ghosts. */
export type ForecastCharts = { capacity: CapacityWeek[]; goals: GoalRow[]; next7: Record<string, number>; windows: AvailabilityWindow[] };

/**
 * The forecast's bottleneck (`forecastGoals` in packages/planner, written in Chinese) in the page's language. Its few fixed shapes are
 * read back and said again; anything else is shown as it came.
 */
export function bottleneckText(raw: string, t: Translate): string {
  /* i18n-ignore-start: the planner's own wording, matched to be said again */
  const horizon = /^(八周|(\d+) 周)内容量或步骤依赖不足$/.exec(raw);
  if (horizon) return t("{{count}} 周内容量或步骤依赖不足", { count: horizon[2] ? Number(horizon[2]) : 8 });
  const margin = /^p85 情景只比截止早 (-?\d+) 天，没有留出 (\d+) 天的余量$/.exec(raw);
  /* i18n-ignore-end */
  if (margin) return t("p85 情景只比截止早 {{count}} 天，没有留出 {{margin}} 天的余量", { count: Number(margin[1]), margin: Number(margin[2]) });
  return t(raw);
}
