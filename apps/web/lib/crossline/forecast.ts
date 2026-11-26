import "server-only";
import { availableSlots, type AccessContext, travelBlocks } from "@crossline/core";
import { dayCapacityOf, measuredView } from "../measured-capacity";
import { forecastGoals, type ForecastResult } from "@crossline/planner";
import { isCancelledEvent } from "@crossline/core";
import { onPersonsBoard } from "@crossline/core";
import { localeFor } from "../locale";
import { planDays, planToday, toZonedInstant } from "./clock";
import { getStore } from "./store";
import { IMPORTANT_WEIGHT, effectiveWeight, libraryUntil, milestoneDeadline, readGoalSettings } from "./goals";
import { ensureSeeded } from "./seed";
import { effectiveSchedulePreferences, readAvailability } from "./schedule-settings";
import { type PersistedScheduleBlock, calendarMarks, personEventBlocks, plannerItemsFor, travelStateOf } from "./schedule";
import { type ActionableOrder, ACTIONABLE } from "./planner-tasks";

/**
 * How far a forecast that judges risk must run: past the furthest deadline of an approved milestone (a week beyond it), never under
 * the usual eight weeks nor over 26. An eight-week run called work due in 100 days 「八周内无法排完」 and asked about it as at risk —
 * not finishing inside the run says nothing about a deadline that lies beyond it (2026-10-21, the owner's account).
 */
export function riskHorizonDays(ctx: AccessContext): number {
  const today = planToday(ctx);
  const furthest = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved")
    .map((milestone) => milestoneDeadline(ctx, milestone.id) ?? "").filter((day) => day > today).sort().at(-1);
  if (!furthest) return 56;
  const days = Math.round((Date.parse(`${furthest}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 8;
  return Math.min(182, Math.max(56, days));
}

/** `horizonDays`: how far the simulation runs — eight weeks unless the plan page asks for four weeks or up to six months. */
export function loadGoalForecast(ctx: AccessContext, horizonDays = 56): ForecastResult & { inferredRegularBlocks: number } {
  ensureSeeded(ctx);
  const store = getStore();
  const { capacity: stated, inferred } = netCapacity(ctx, horizonDays);
  // Forecast at the measured pace (docs/plans/closed-loop-1030.md §1): a day's usable minutes are at most its measured cap, so work the
  // person will not get to shows as a risk before its deadline instead of after it. The forecast keeps 85% of a day usable, hence the divide.
  const view = measuredView(ctx);
  const capacity = stated.map((day) => ({ ...day, netMinutes: Math.min(day.netMinutes, dayCapacityOf(ctx, day.day, day.netMinutes, view) / 0.85) }));
  // An approved milestone's own deadline is one the person confirmed by approving it; the goal setting only overrides it.
  // Without the fallback no milestone had a deadline here unless it was typed a second time, so nothing was ever at risk.
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const goals = store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved")
    .map((item) => { const weight = effectiveWeight(ctx, item.id); return { id: item.id, title: item.title, weight,
      importance: weight >= IMPORTANT_WEIGHT ? "important" as const : "ordinary" as const,
      confirmedDeadline: readGoalSettings(ctx, item.id)?.confirmedDeadline ?? anchors.get(item.id) ?? null }; });
  const orders = store.listWorkOrders(ctx.workspaceId);
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  // Step by step where a task has a plan, so the forecast counts only the work that is left.
  // A task waiting in the library starts no earlier than the day it enters the schedule, so a window that opens too late for the work
  // shows up here as a risk instead of a forecast that assumed it had already started.
  const today = planToday(ctx);
  const opens = new Map(orders.flatMap((order) => { const day = libraryUntil(ctx, order, today); return day ? [[order.id, day] as const] : []; }));
  // The person's hours: the assistant's preparation takes none of them (docs/work-split.md).
  const tasks = plannerItemsFor(ctx, orders.filter((order) => ACTIONABLE.includes(order.state) && onPersonsBoard(order)), { hold: false }).map((item) => {
    const day = opens.get(item.orderId);
    const start = day ? toZonedInstant(day, "00:00", preferences.timeZone) : undefined;
    return start && (!item.task.notBefore || item.task.notBefore < start) ? { ...item.task, notBefore: start } : item.task;
  });
  const completedIds = new Set(orders.filter((order) => order.state === "accepted").map((order) => order.id));
  return { ...forecastGoals(goals, tasks, capacity, completedIds), inferredRegularBlocks: inferred };
}

/**
 * What each of the next `horizonDays` days leaves of the person's available hours once the calendar, their own fixed events and the
 * travel to them are taken out: the forecast's capacity, and the weekly commitment's (docs/rituals.md). A regular calendar event seen on
 * two or more weeks is assumed again past the first week, where the synced calendar does not reach yet.
 */
export function netCapacity(ctx: AccessContext, horizonDays: number): { capacity: Array<{ day: string; netMinutes: number; source: "declared" | "calendar_adjusted" }>; inferred: number } {
  const store = getStore();
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  const days = planDays(planToday(ctx), horizonDays);
  const committed = ((store.listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: PersistedScheduleBlock[] } | undefined)
    ?.blocks ?? []).filter((block) => block.day && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(calendarMarks(ctx), block.title)));
  const signatures = new Map<string, Set<string>>();
  for (const block of committed.filter((item) => item.id.startsWith("graph_calendar:"))) {
    const weekday = new Date(`${block.day}T00:00:00Z`).getUTCDay();
    const key = `${weekday}|${block.start}|${block.end}|${block.title}`;
    signatures.set(key, (signatures.get(key) ?? new Set()).add(block.day!));
  }
  const regular = [...signatures].filter(([, observed]) => observed.size >= 2);
  const inferred = days.slice(7).flatMap((day) => regular.flatMap(([key]) => {
    const [weekday, start, end] = key.split("|");
    if (Number(weekday) !== new Date(`${day}T00:00:00Z`).getUTCDay()) return [];
    const real = committed.some((block) => block.day === day && block.start < end! && block.end > start!);
    return real ? [] : [{ day, start: start!, end: end! }];
  }));
  const busy = [...committed.map((block) => ({ day: block.day!, start: block.start, end: block.end })), ...inferred,
    ...((events) => [...events, ...travelBlocks(events, travelStateOf(ctx), localeFor(ctx))])(personEventBlocks(ctx, days)).map((block) => ({ day: block.day!, start: block.start, end: block.end }))];
  const slots = availableSlots(readAvailability(ctx), days, busy);
  const capacity = days.map((day) => ({ day, netMinutes: slots.filter((slot) => slot.day === day).reduce((sum, slot) => {
    try { return sum + (Date.parse(toZonedInstant(day, slot.end, preferences.timeZone))
      - Date.parse(toZonedInstant(day, slot.start, preferences.timeZone))) / 60_000; }
    catch { return sum; }
  }, 0), source: busy.some((block) => block.day === day) ? "calendar_adjusted" as const : "declared" as const }));
  return { capacity, inferred: inferred.length };
}

/** The person's minutes left on each order (its open steps' usual estimates, else the whole task's), the way the forecast counts them. */
export function remainingMinutesOf(ctx: AccessContext, orders: ActionableOrder[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of plannerItemsFor(ctx, orders, { hold: false })) out.set(item.orderId, (out.get(item.orderId) ?? 0) + item.task.estimate.p50Minutes);
  return out;
}
