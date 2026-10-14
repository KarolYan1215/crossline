import "server-only";
import { hoursFromText, statedWeeklyHours, weeklyAvailableHours, type AccessContext, type AvailabilitySource, type AvailabilityWindow, type ImportancePreset, type PortraitReport } from "@crossline/core";
import { DEADLINE_MARGIN_DAYS, PARAMS_ASAP, PARAMS_BUFFERED, type ScheduleParams } from "@crossline/planner";
import { effectiveParams, effectiveSchedulePreferences, effectiveWeight, getStore, IMPORTANT_WEIGHT, importancePresets, loadGoalForecast, planRanking, planToday,
  LINE_SHARES_SETTING, readAvailability, readGoalSettings, readLineShares, readSchedulePreferences, resolvedAvailability, type PersistedPlan, type RankedTask } from "./crossline";
import { suggestedAvailabilityFor } from "./timeline";
import { identityLines, lineLabels } from "./lines";
import { readScheduledMinutes } from "./schedule-memory";
import type { ForecastSummary } from "./forecast-diff";
import { addDays, availabilityGrid, capacityWeeks, estimatePoints, goalRows, horizonFor, investment, rhythmGrid, statedShares,
  type ForecastCharts, type Horizon, type Investment, type EstimatePoint } from "./plan-stats";

/**
 * The plan page, read once (decided 2026-10-10: the calendar left this page; it is long-range statistics over the chosen horizon and the
 * schedule's settings): capacity against demand per week, each milestone's finish range, planned against timed hours per line, estimate
 * accuracy and rhythm, then the scheduler's own ordering and the three things the person sets, with the system's suggestion beside each.
 */
export type PlanBoard = {
  today: string; timeZone: string; labels: Record<string, string>; lineOrder: string[];
  horizon: Horizon;
  capacity: { statedWeekly: number | null; configuredWeekly: number; usingDefault: boolean; source: AvailabilitySource };
  /** Each line's share of the week the scheduler keeps (percent), and whether the person set it or it is what they said. */
  shares: { effective: Record<string, number>; custom: boolean };
  /** What a previewed change moves (drawn with the current values as ghosts while a preview is open). */
  charts: ForecastCharts;
  inferredRegularBlocks: number;
  /** The forecast's dates and weekly net minutes, for 「与上次查看时相比」. */
  forecastSummary: ForecastSummary;
  investment: Investment;
  estimates: { points: EstimatePoint[]; covered: number; coverage: number | null };
  /** Minutes worked per weekday × hour over the last eight weeks, and the availability pattern on the same grid. */
  rhythm: { worked: number[][]; available: number[][]; since: string };
  ranking: RankedTask[];
  params: ScheduleParams; presets: { buffered: ScheduleParams; asap: ScheduleParams };
  importance: Array<{ id: string; title: string; line: string; weight: number; custom: boolean; preset: ImportancePreset }>;
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
  const proposals: Record<string, number> = {};
  for (const order of orders) if (order.state === "awaiting_plan_approval" && order.milestoneId) proposals[order.milestoneId] = (proposals[order.milestoneId] ?? 0) + 1;
  const lineOrder = identityLines(ctx).map((line) => line.id);
  const scheduled = plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today)
    .map((block) => ({ day: block.day!, line: orderLine[block.id.split(":")[1]!] ?? "none", minutes: blockMinutes(block) }));
  const tomorrow = addDays(today, 1), weekOut = addDays(today, 7);
  const next7: Record<string, number> = {};
  for (const block of scheduled) if (block.day >= tomorrow && block.day <= weekOut) next7[block.line] = (next7[block.line] ?? 0) + block.minutes;
  const unforecast = new Set(forecast.goals.filter((goal) => !goal.confirmedDeadline && effectiveWeight(ctx, goal.milestoneId) < IMPORTANT_WEIGHT)
    .map((goal) => goal.milestoneId));
  return {
    capacity: capacityWeeks({ today, weeks: forecast.weeks, lineOf, titleOf, scheduled, lineOrder }),
    goals: goalRows({ goals: forecast.goals, lineOf, lineOrder, marginDays: DEADLINE_MARGIN_DAYS, unforecast, library: ranking, proposals }),
    next7, windows: readAvailability(ctx), inferredRegularBlocks: forecast.inferredRegularBlocks,
    summary: { goals: forecast.goals, weeks: forecast.weeks.map((week) => ({ week: week.week, netMinutes: week.netMinutes })) }
  };
}

export async function loadPlanBoard(ctx: AccessContext, plan: PersistedPlan, requestedHorizon?: string): Promise<PlanBoard> {
  const store = getStore();
  const today = planToday(ctx);
  const timeZone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const labels = lineLabels(ctx);
  const lineOrder = identityLines(ctx).map((line) => line.id);
  const milestones = store.listMilestones(ctx.workspaceId);
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

  // Planned against timed: the recorded day lengths of the last four weeks; today's also from the live plan, in case the timer has not run.
  const orders = store.listWorkOrders(ctx.workspaceId);
  const orderLine = Object.fromEntries(orders.map((order) => [order.id, order.identityId]));
  const plannedByDay: Record<string, Record<string, number> | null> = {};
  for (let back = 27; back >= 0; back -= 1) { const day = addDays(today, -back); plannedByDay[day] = readScheduledMinutes(ctx, day); }
  const live: Record<string, number> = {};
  for (const block of plan.blocks) if (block.id.startsWith("scheduled:") && block.day === today) {
    const order = block.id.split(":")[1]!;
    live[order] = (live[order] ?? 0) + blockMinutes(block);
  }
  if (Object.keys(live).length || plannedByDay[today]) {
    const merged = { ...(plannedByDay[today] ?? {}) };
    for (const [order, minutes] of Object.entries(live)) merged[order] = Math.max(merged[order] ?? 0, minutes);
    plannedByDay[today] = merged;
  }
  const now = (process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()).toISOString();
  // A session with no end counts to now only while its order is actually running: one left open by an order discarded before
  // sessions ended with it would otherwise read as weeks of work.
  const running = new Set(orders.filter((order) => order.state === "active").map((order) => order.id));
  const executions = store.listExecutions(ctx.workspaceId).filter((item) => item.endedAt || running.has(item.workOrderId));
  let portrait: PortraitReport | undefined;
  try { portrait = (JSON.parse(store.getSetting(ctx.workspaceId, "portrait.report") ?? "{}") as { report?: PortraitReport }).report; } catch { /* none yet */ }
  const facts = store.listProfileFacts(ctx.workspaceId);
  const since = addDays(today, -55);

  const presets = importancePresets(ctx);
  const approved = milestones.filter((item) => item.status === "approved");
  const preferences = readSchedulePreferences(ctx);
  return {
    today, timeZone, labels, lineOrder, horizon, charts, inferredRegularBlocks, forecastSummary: summary,
    capacity: {
      statedWeekly: statedWeeklyHours(facts) ?? null,
      configuredWeekly: weeklyAvailableHours(readAvailability(ctx)),
      usingDefault: plan.usingDefaultPreferences,
      source: resolvedAvailability(ctx).source
    },
    shares: { effective: readLineShares(ctx) ?? {}, custom: Boolean(getStore().getSetting(ctx.workspaceId, LINE_SHARES_SETTING)) },
    investment: investment({ today, zone: timeZone, now, lineOrder, plannedByDay, orderLine, executions, next7: charts.next7,
      stated: statedShares(portrait?.lines?.items ?? null, facts, hoursFromText) }),
    estimates: estimatePoints(store.listAllDurationObservations(ctx.workspaceId)),
    rhythm: { worked: rhythmGrid(executions.filter((item) => item.startedAt.slice(0, 10) >= since), timeZone, now),
      available: availabilityGrid(readAvailability(ctx)), since },
    ranking,
    params: effectiveParams(ctx), presets: { buffered: PARAMS_BUFFERED, asap: PARAMS_ASAP },
    importance: approved.flatMap((item) => {
      const preset = presets.get(item.id);
      if (!preset) return [];
      const goal = readGoalSettings(ctx, item.id);
      const custom = typeof goal?.weight === "number" || Boolean(goal?.importance ?? preferences?.importance[item.id]);
      return [{ id: item.id, title: item.title, line: item.identityId, weight: effectiveWeight(ctx, item.id), custom, preset }];
    }),
    week: { windows: readAvailability(ctx), suggested: suggestedAvailabilityFor(ctx), busy, proposed: interviewAvailability(ctx) }
  };
}

/** The weekly hours the interview proposed (`schedule.availability.proposed`), valid windows only. */
function interviewAvailability(ctx: AccessContext): { windows: AvailabilityWindow[]; why: string } | null {
  try {
    const raw = JSON.parse(getStore().getSetting(ctx.workspaceId, "schedule.availability.proposed") ?? "null") as { windows?: AvailabilityWindow[]; why?: string } | null;
    const windows = (raw?.windows ?? []).filter((window) => Array.isArray(window.days) && /^\d{2}:\d{2}$/.test(window.start) && /^\d{2}:\d{2}$/.test(window.end) && window.start < window.end);
    return windows.length ? { windows, why: raw?.why ?? "" } : null;
  } catch { return null; }
}
