import type { AvailabilityWindow } from "@crossline/core";
import type { ForecastWeek, GoalForecast } from "@crossline/planner";

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
  libraryDay: string | null; status: GoalRowStatus; bottleneck: string | null };

export function goalRows(input: { goals: GoalForecast[]; lineOf: Record<string, string>; lineOrder: string[]; marginDays: number;
  /** Milestones the forecast does not follow (ordinary importance, no deadline). */ unforecast: Set<string>;
  library: Array<{ milestoneId: string; libraryUntil: string | null }> }): GoalRow[] {
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
      bottleneck: goal.bottleneck };
  }).sort((a, b) => rank(a.line) - rank(b.line) || a.line.localeCompare(b.line) || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
    || a.title.localeCompare(b.title));
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
  const lineIds = [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
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

/** Weekday (0 = Sunday) and hour of an instant in a zone. */
function localSlot(zone: string) {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
  const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (time: number) => {
    const parts = format.formatToParts(new Date(time));
    return { weekday: WEEKDAY[parts.find((part) => part.type === "weekday")!.value] ?? 0, hour: Number(parts.find((part) => part.type === "hour")!.value) % 24 };
  };
}

/**
 * Minutes worked per weekday (0 = Sunday) × hour, from the timer's own start and end in the person's zone, with every pause cut out.
 * Each stretch is walked in quarter hours, which every zone's offset divides, so a minute is never filed under the wrong hour.
 */
export function rhythmGrid(executions: ExecutionLike[], zone: string, now: string): number[][] {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const slot = localSlot(zone);
  const QUARTER = 15 * 60_000;
  for (const execution of executions) {
    const start = Date.parse(execution.startedAt), end = Date.parse(execution.endedAt ?? now);
    if (!(end > start)) continue;
    const pauses = (execution.interruptions ?? []).map((item) => [Date.parse(item.pausedAt), Date.parse(item.resumedAt ?? execution.endedAt ?? now)] as const)
      .filter(([from, to]) => to > from);
    for (let from = start; from < end;) {
      const to = Math.min(end, (Math.floor(from / QUARTER) + 1) * QUARTER);
      const paused = pauses.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
      const minutes = (to - from - paused) / 60_000;
      if (minutes > 0) { const { weekday, hour } = slot(from); grid[weekday]![hour]! += minutes; }
      from = to;
    }
  }
  return grid.map((row) => row.map((value) => Math.round(value)));
}

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

/* ── what a preview changes ── */

/** The part of the page a previewed change moves: drawn as it would be, with the current values as ghosts. */
export type ForecastCharts = { capacity: CapacityWeek[]; goals: GoalRow[]; next7: Record<string, number>; windows: AvailabilityWindow[] };
