import "server-only";
import { capacityLine, type CapacityLine } from "./measured-capacity";
import { ENERGY_ADVICE_DISMISSED, ENERGY_ADVICE_SETTING, onPersonsBoard, readEnergyAdvice, statedWeeklyHours, weeklyAvailableHours, type AccessContext, type AvailabilitySource,
  type AvailabilityWindow, type EnergyAdvice } from "@crossline/core";
import { DEADLINE_MARGIN_DAYS, PARAMS_ASAP, PARAMS_BUFFERED, type ForecastResult, type ScheduleParams } from "@crossline/planner";
import { effectiveParams, effectiveSchedulePreferences, effectiveWeight, getStore, IMPORTANT_WEIGHT, loadGoalForecast, planRanking, planToday,
  LINE_SHARES_SETTING, readAvailability, readGoalSettings, readLineShares, resolvedAvailability, type PersistedPlan, type RankedTask } from "./crossline";
import { suggestedAvailabilityFor } from "./timeline";
import { identityLines, lineLabels } from "./lines";
import { unplacedTaskIds } from "./unplaced";
import type { ForecastSummary } from "./forecast-diff";
import { addDays, availabilityGrid, capacityWeeks, estimatePoints, goalRows, horizonFor, milestoneMarks, planKpis, rhythmGrid, unplacedItems,
  type ForecastCharts, type GoalRow, type Horizon, type EstimatePoint, type MilestoneState, type PlanKpis, type UnplacedItem } from "./plan-stats";

/**
 * The plan page, read once (decided 2026-10-10: the calendar left this page; it is long-range statistics over the chosen horizon and the
 * schedule's settings): capacity against demand per week, each milestone's finish range, planned against timed hours per line, estimate
 * accuracy and rhythm, then the scheduler's own ordering and the three things the person sets, with the system's suggestion beside each.
 */
export type PlanBoard = {
  today: string; timeZone: string; labels: Record<string, string>; lineOrder: string[];
  horizon: Horizon;
  capacity: { statedWeekly: number | null; configuredWeekly: number; usingDefault: boolean; source: AvailabilitySource; basis: CapacityLine };
  /** Each line's share of the week the scheduler keeps (percent), and whether the person set it or it is what they said. */
  shares: { effective: Record<string, number>; custom: boolean };
  /** What a previewed change moves (drawn with the current values as ghosts while a preview is open). */
  charts: ForecastCharts;
  inferredRegularBlocks: number;
  /** The forecast's dates and weekly net minutes, for 「与上次查看时相比」. */
  forecastSummary: ForecastSummary;
  estimates: { points: EstimatePoint[]; covered: number; coverage: number | null };
  /** What the schedule could not place in full, with the planner's reason (「排不下的原因」), and the four figures over the page. */
  unplaced: UnplacedItem[];
  kpis: PlanKpis;
  /** Minutes worked per weekday × hour over the last eight weeks, and the availability pattern on the same grid. */
  rhythm: { worked: number[][]; available: number[][]; since: string };
  /** The scheduler's own ordering, read-only (decided 2026-10-15: importance is the agent's, set on each milestone's card; due days on task cards). */
  ranking: RankedTask[];
  params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams };
  /** What the ordering rests on, as the page shows it: each line's long-term goal. */
  goals: Array<{ line: string; label: string; goal: string | null }>;
  /** This week's energy advice (worker, weekly), and whether the person set exactly this one aside. */
  advice: { value: EnergyAdvice | null; dismissed: boolean };
  /** Milestones whose work is all accepted: left off the timeline. */
  doneMilestones: string[];
  week: { windows: AvailabilityWindow[]; suggested: AvailabilityWindow[];
    /** Hours the interview proposed from a hard-constraint line's rules (or the person's working hours), with why; null when none. */
    proposed: { windows: AvailabilityWindow[]; why: string } | null;
    /** Calendar commitments over the next two weeks, per weekday (0 = Sunday) and half hour: how many of those fall in it. */
    busy: number[][] };
};

const minutesOf = (clock: string) => { const [h, m] = clock.split(":").map(Number); return h! * 60 + m!; };
const blockMinutes = (block: { start: string; end: string }) => Math.max(0, minutesOf(block.end) - minutesOf(block.start));

/** Approved milestones' deadlines: the person's confirmed one, else the milestone's own. */
function approvedDeadlines(ctx: AccessContext): Array<string | null> {
  const store = getStore();
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  return store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved")
    .map((item) => readGoalSettings(ctx, item.id)?.confirmedDeadline ?? anchors.get(item.id) ?? null);
}

/** The horizon for a `?horizon=` value: 4, 8 (default) or `far` (the farthest approved deadline, at most six months). */
export function planHorizon(ctx: AccessContext, requested: string | undefined): Horizon {
  return horizonFor(requested, planToday(ctx), approvedDeadlines(ctx));
}

/**
 * The charts a change can move, for this plan and horizon: capacity and demand per week, the milestone rows, the next seven days' planned
 * minutes per line and the availability pattern. `lib/impact.ts` calls it inside `withPreview` for the after-state.
 */
export function loadForecastCharts(ctx: AccessContext, plan: PersistedPlan, horizonDays: number, ranking = planRanking(ctx, plan)):
  ForecastCharts & { inferredRegularBlocks: number; summary: ForecastSummary } {
  const store = getStore();
  const today = planToday(ctx);
  const forecast = loadGoalForecast(ctx, horizonDays);
  const milestones = store.listMilestones(ctx.workspaceId);
  const lineOf = Object.fromEntries(milestones.map((item) => [item.id, item.identityId]));
  const titleOf = Object.fromEntries(milestones.map((item) => [item.id, item.title]));
  const orders = store.listWorkOrders(ctx.workspaceId);
  const orderLine = Object.fromEntries(orders.map((order) => [order.id, order.identityId]));
  const lineOrder = identityLines(ctx).map((line) => line.id);
  const scheduled = plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today)
    .map((block) => ({ day: block.day!, line: orderLine[block.id.split(":")[1]!] ?? "none", minutes: blockMinutes(block) }));
  const tomorrow = addDays(today, 1), weekOut = addDays(today, 7);
  const next7: Record<string, number> = {};
  for (const block of scheduled) if (block.day >= tomorrow && block.day <= weekOut) next7[block.line] = (next7[block.line] ?? 0) + block.minutes;
  return {
    capacity: capacityWeeks({ today, weeks: forecast.weeks, lineOf, titleOf, scheduled, lineOrder }),
    goals: goalRowsFor(ctx, forecast, ranking),
    next7, windows: readAvailability(ctx), inferredRegularBlocks: forecast.inferredRegularBlocks,
    summary: { goals: forecast.goals, weeks: forecast.weeks.map((week) => ({ week: week.week, netMinutes: week.netMinutes })) }
  };
}

/** Each approved milestone's finish range and what is in its way, from one forecast run and the scheduler's own ordering. */
export function goalRowsFor(ctx: AccessContext, forecast: ForecastResult, ranking: RankedTask[]): GoalRow[] {
  const store = getStore();
  const lineOf = Object.fromEntries(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item.identityId]));
  const proposals: Record<string, number> = {};
  for (const order of store.listWorkOrders(ctx.workspaceId)) if (order.state === "awaiting_plan_approval" && order.milestoneId && onPersonsBoard(order))
    proposals[order.milestoneId] = (proposals[order.milestoneId] ?? 0) + 1;
  const unforecast = new Set(forecast.goals.filter((goal) => !goal.confirmedDeadline && effectiveWeight(ctx, goal.milestoneId) < IMPORTANT_WEIGHT)
    .map((goal) => goal.milestoneId));
  return goalRows({ goals: forecast.goals, lineOf, lineOrder: identityLines(ctx).map((line) => line.id), marginDays: DEADLINE_MARGIN_DAYS, unforecast,
    library: ranking, proposals });
}

/**
 * What the schedule says of each approved milestone (decided 2026-10-28: the plan page's milestone axis left for 主线, its state colours
 * with it): at risk, nothing ready to work on, or waiting in the task library; none means on track. `forecast` should reach every
 * approved deadline (`riskHorizonDays`), or a milestone past its end would read as one that does not finish.
 */
export function milestonePlanStates(ctx: AccessContext, plan: PersistedPlan, forecast: ForecastResult): Map<string, MilestoneState[]> {
  return new Map(milestoneMarks(goalRowsFor(ctx, forecast, planRanking(ctx, plan)), planToday(ctx)).map((mark) => [mark.id, mark.states]));
}

export async function loadPlanBoard(ctx: AccessContext, plan: PersistedPlan, requestedHorizon?: string): Promise<PlanBoard> {
  const store = getStore();
  const today = planToday(ctx);
  const timeZone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const labels = lineLabels(ctx);
  const lineOrder = identityLines(ctx).map((line) => line.id);
  const twoWeeks = addDays(today, 14);
  const ranking = planRanking(ctx, plan);
  const horizon = planHorizon(ctx, requestedHorizon);
  const { inferredRegularBlocks, summary, ...charts } = loadForecastCharts(ctx, plan, horizon.days, ranking);

  const busy = Array.from({ length: 7 }, () => Array.from({ length: 48 }, () => 0));
  for (const block of plan.blocks) {
    if (!block.day || block.day < today || block.day >= twoWeeks || !(block.id.startsWith("graph_calendar:") || block.id.startsWith("import:"))) continue;
    const weekday = new Date(`${block.day}T12:00:00Z`).getUTCDay();
    for (let cell = Math.floor(minutesOf(block.start) / 30); cell < Math.ceil(minutesOf(block.end) / 30) && cell < 48; cell += 1) busy[weekday]![cell]! += 1;
  }

  // Looking back (planned against timed, per line) is the weekly review's (2026-10-28); the page keeps the timed rhythm for the grid.
  const orders = store.listWorkOrders(ctx.workspaceId);
  const now = (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString();
  // A session with no end counts to now only while its order is actually running: one left open by an order discarded before
  // sessions ended with it would otherwise read as weeks of work.
  const running = new Set(orders.filter((order) => order.state === "active").map((order) => order.id));
  const executions = store.listExecutions(ctx.workspaceId).filter((item) => item.endedAt || running.has(item.workOrderId));
  const facts = store.listProfileFacts(ctx.workspaceId);
  const since = addDays(today, -55);
  const estimates = estimatePoints(store.listAllDurationObservations(ctx.workspaceId));
  const unplaced = unplacedItems(ranking, unplacedTaskIds(plan.schedule?.blockers ?? []));

  const advice = readEnergyAdvice(store.getSetting(ctx.workspaceId, ENERGY_ADVICE_SETTING));
  return {
    today, timeZone, labels, lineOrder, horizon, charts, inferredRegularBlocks, forecastSummary: summary,
    capacity: {
      statedWeekly: statedWeeklyHours(facts) ?? null,
      configuredWeekly: weeklyAvailableHours(readAvailability(ctx)),
      usingDefault: plan.usingDefaultPreferences,
      source: resolvedAvailability(ctx).source,
      basis: capacityLine(ctx, statedWeeklyHours(facts) ?? null)
    },
    shares: { effective: readLineShares(ctx) ?? {}, custom: Boolean(getStore().getSetting(ctx.workspaceId, LINE_SHARES_SETTING)) },
    estimates, unplaced, kpis: planKpis({ capacity: charts.capacity, unplaced, estimates: estimates.points }),
    rhythm: { worked: rhythmGrid(executions.filter((item) => item.startedAt.slice(0, 10) >= since), timeZone, now),
      available: availabilityGrid(readAvailability(ctx)), since },
    ranking,
    params: effectiveParams(ctx), presets: { buffered: PARAMS_BUFFERED, asap: PARAMS_ASAP },
    goals: identityLines(ctx).map((line) => ({ line: line.id, label: line.label, goal: line.goals?.[0] ?? line.goal ?? null })),
    doneMilestones: doneMilestones(orders),
    advice: { value: advice, dismissed: Boolean(advice && "id" in advice && store.getSetting(ctx.workspaceId, ENERGY_ADVICE_DISMISSED) === advice.id) },
    week: { windows: readAvailability(ctx), suggested: suggestedAvailabilityFor(ctx), busy, proposed: interviewAvailability(ctx) }
  };
}

/** A milestone with work, all of it accepted (or discarded) and at least one accepted. */
function doneMilestones(orders: Array<{ milestoneId: string; state: string }>): string[] {
  const byMilestone = new Map<string, string[]>();
  for (const order of orders) if (order.milestoneId) byMilestone.set(order.milestoneId, [...(byMilestone.get(order.milestoneId) ?? []), order.state]);
  return [...byMilestone].filter(([, states]) => states.includes("accepted") && states.every((state) => state === "accepted" || state === "archived")).map(([id]) => id);
}

/** The weekly hours the interview proposed (`schedule.availability.proposed`), valid windows only. */
function interviewAvailability(ctx: AccessContext): { windows: AvailabilityWindow[]; why: string } | null {
  try {
    const raw = JSON.parse(getStore().getSetting(ctx.workspaceId, "schedule.availability.proposed") ?? "null") as { windows?: AvailabilityWindow[]; why?: string } | null;
    const windows = (raw?.windows ?? []).filter((window) => Array.isArray(window.days) && /^\d{2}:\d{2}$/.test(window.start) && /^\d{2}:\d{2}$/.test(window.end) && window.start < window.end);
    return windows.length ? { windows, why: raw?.why ?? "" } : null;
  } catch { return null; }
}
