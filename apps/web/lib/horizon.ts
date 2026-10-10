import "server-only";
import { horizonEntry, latestStart, type AccessContext, type Ask } from "@crossline/core";
import { effectiveParams, effectiveWeight, getStore, planToday, readAvailability, readGoalSettings, TASK_LIBRARY_WINDOW_DAYS } from "./crossline";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A missing input usually has to be got from someone; its question comes up this many days before the work it holds up must start. */
const ACQUIRE_DAYS = 7;
const CLOSED = new Set(["accepted", "archived"]);
const toMinutes = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

type OrderLike = { id: string; milestoneId: string; state: string; payload: unknown; estimate: { p85Minutes: number } };

/**
 * Which decisions are this week's (decided 2026-10-10): the latest day the work behind a decision can start falls within seven days.
 * A task's latest start is its due day (its own, else its milestone's) less its cautious estimate at the person's daily working
 * minutes; a milestone's is its deadline less its open work, or less the task library's three weeks when nothing is split yet
 * (that is when its work would enter the schedule). A missing input's question comes a further week early, since it usually has to be
 * got from someone. Undated decisions are this week's.
 */
export function decisionHorizon(ctx: AccessContext, now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()) {
  const store = getStore();
  const today = planToday(ctx, now);
  const weekly = readAvailability(ctx).reduce((sum, window) => sum + Math.max(0, toMinutes(window.end) - toMinutes(window.start)) * window.days.length, 0);
  const daily = Math.max(60, (weekly / 7) * effectiveParams(ctx).maxDailyShare);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const orders = store.listWorkOrders(ctx.workspaceId);
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const milestoneIds = new Set(store.listMilestones(ctx.workspaceId).map((milestone) => milestone.id));
  const openMinutes = new Map<string, number>();
  for (const order of orders) if (order.milestoneId && !CLOSED.has(order.state)) openMinutes.set(order.milestoneId, (openMinutes.get(order.milestoneId) ?? 0) + order.estimate.p85Minutes);
  const deadlineOf = (milestoneId: string) => {
    const day = readGoalSettings(ctx, milestoneId)?.confirmedDeadline ?? anchors.get(milestoneId);
    return day && DAY_RE.test(day) ? day : undefined;
  };
  const milestoneEntry = (milestoneId: string, extraDays = 0): string | undefined => {
    const deadline = deadlineOf(milestoneId);
    if (!deadline) return undefined;
    const open = openMinutes.get(milestoneId);
    const lead = (open ?? TASK_LIBRARY_WINDOW_DAYS * daily) + extraDays * daily;
    return horizonEntry(latestStart(deadline, lead, daily), today);
  };
  const orderEntry = (order: OrderLike): string | undefined => {
    const own = (order.payload as { dueDate?: string } | undefined)?.dueDate;
    const due = own && DAY_RE.test(own) ? own : order.milestoneId ? deadlineOf(order.milestoneId) : undefined;
    return due ? horizonEntry(latestStart(due, order.estimate.p85Minutes, daily), today) : undefined;
  };
  const askEntry = (ask: Ask): string | undefined => {
    if (ask.urgency !== "later") return undefined;
    const order = ordersById.get(ask.entityId);
    if (order) return orderEntry(order);
    if (milestoneIds.has(ask.entityId)) return milestoneEntry(ask.entityId, ask.kind === "backplan_input" ? ACQUIRE_DAYS : 0);
    return horizonEntry(ask.dueDay, today);
  };
  const importanceOf = (ask: Ask): number | undefined => {
    const milestoneId = ordersById.get(ask.entityId)?.milestoneId || (milestoneIds.has(ask.entityId) ? ask.entityId : "");
    return milestoneId ? effectiveWeight(ctx, milestoneId) : undefined;
  };
  /** Each ask with the importance of the milestone it bears on and, when it is not this week's, the day it comes into the week. */
  const annotate = (asks: Ask[]): Ask[] => asks.map((ask) => {
    const importance = importanceOf(ask), entersOn = askEntry(ask);
    return { ...ask, ...(importance !== undefined ? { importance } : {}), ...(entersOn ? { entersOn } : {}) };
  });
  return { today, orderEntry, milestoneEntry, annotate };
}
