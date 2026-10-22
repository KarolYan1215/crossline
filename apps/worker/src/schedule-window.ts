import { AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, STEP_STARTS_SETTING, goalSettingKey, resolveAvailability, weeklyAvailableHours } from "@crossline/core";
import type { CrosslineStore, StoredStepPlan, StoredTaskStep, StoredWorkOrder } from "@crossline/db";

/** Written by the web (`schedule-memory.ts`): each work order's earliest block start this week, as an instant. */
export const ORDER_STARTS_SETTING = "schedule.orderStarts";
/**
 * How far ahead of its first block approved work gets its tutorial (manualbook): three days (2026-10-21, docs/task-preparation.md). It was
 * seven days (2026-10-15), and a week of replans and new files rebuilt tutorials or left them for work that moved; before that 48 hours,
 * which left no day for the person to look at it. Steps are planned before a proposal is shown; the tutorial follows once the work is
 * three days away, and waits for the assistant's preparation steps up to a day before (`pendingTutorials`).
 */
export const TUTORIAL_LEAD_DAYS = 3;
/** How far ahead the assistant prepares (its preparation steps and whole errands): still 48 hours (docs/review-2026-10-13.md §6.1). */
export const ASSISTANT_PREP_HOURS = 48;
/** States in which work is committed and may be prepared. */
const COMMITTED = new Set(["approved", "preparing", "ready_for_human", "active"]);
const DAY_MS = 86_400_000;

/**
 * The work orders whose next block starts within `hours` (or began in the last hour): three days for tutorials by default, `ASSISTANT_PREP_HOURS`
 * for the assistant. The schedule is derived in the web process, so
 * the worker reads what the web last recorded. Committed work with no block recorded (the web records this week's only, and some work
 * gets no block at all) is judged by when it would have to start: its due day less its open work at the person's daily hours. Work with
 * neither a block nor a due day is not in the window — preparing for work nobody has a time for is what spent half a week's tokens on
 * manuals never opened.
 */
export function startingWithin(store: CrosslineStore, workspaceId: string, now: Date, hours = TUTORIAL_LEAD_DAYS * 24): Set<string> {
  let starts: Record<string, string> = {};
  try { starts = JSON.parse(store.getSetting(workspaceId, ORDER_STARTS_SETTING) ?? "{}") as Record<string, string>; } catch { return new Set(); }
  const from = now.getTime() - 3_600_000, to = now.getTime() + hours * 3_600_000;
  const within = new Set(Object.entries(starts).filter(([, at]) => { const time = Date.parse(at); return time >= from && time <= to; }).map(([orderId]) => orderId));
  for (const id of estimatedStarts(store, workspaceId, now, Object.keys(starts), to)) within.add(id);
  return within;
}

/** The person's working minutes a day as the worker can know them: the weekly pattern's hours over seven days, at least an hour. */
export function dailyAvailableMinutes(store: CrosslineStore, workspaceId: string): number {
  const { windows } = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(workspaceId) });
  return Math.max(60, weeklyAvailableHours(windows) * 60 / 7);
}

/** Committed work with no recorded block whose latest start, worked back from its due day, falls on or before `to`. */
function estimatedStarts(store: CrosslineStore, workspaceId: string, now: Date, recorded: string[], to: number): string[] {
  const skip = new Set(recorded);
  const orders = store.listWorkOrders(workspaceId).filter((order) => COMMITTED.has(order.state) && !skip.has(order.id));
  if (!orders.length) return [];
  const dueOf = dueDays(store, workspaceId, now);
  const dailyMinutes = dailyAvailableMinutes(store, workspaceId);
  return orders.filter((order) => {
    const due = dueOf(order);
    if (!due) return false;
    const open = store.getStepPlan(workspaceId, order.id)?.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
    const minutes = open?.length ? open.reduce((sum, step) => sum + step.estimate.p85Minutes, 0) : order.estimate.p85Minutes;
    const start = Date.parse(`${due}T00:00:00Z`) - Math.ceil(minutes / dailyMinutes) * DAY_MS;
    return start <= to;
  }).map((order) => order.id);
}

/**
 * Each order's due day, as the step planner reads it: the task's own, else the milestone's confirmed deadline, else its anchor. Undefined
 * for undated work and for a due day already past.
 */
function dueDays(store: CrosslineStore, workspaceId: string, now: Date): (order: StoredWorkOrder) => string | undefined {
  const today = now.toISOString().slice(0, 10);
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  return (order) => {
    let goal: string | undefined;
    try { goal = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(order.milestoneId)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* none */ }
    const due = [(order.payload as { dueDate?: string } | undefined)?.dueDate, goal, anchors.get(order.milestoneId)]
      .find((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)));
    return due && due >= today ? due : undefined;
  };
}

/** What the assistant may prepare now: whole errands (by order id) and preparation steps (`<order>#<step>`). */
export type PrepWindow = { orders: Set<string>; steps: Set<string> };

const personStep = (step: StoredTaskStep) => step.executor !== "agent" && step.status === "planned";

/**
 * The person's step an assistant step prepares for (docs/work-split.md §4): the soonest open person step that waits on it, directly or
 * through other steps; else the next open person step after it in the plan. Undefined when no person step follows it.
 */
export function servedPersonStep(plan: StoredStepPlan, step: StoredTaskStep): StoredTaskStep | undefined {
  const waiting = new Set([step.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const other of plan.steps) if (!waiting.has(other.id) && other.dependsOn.some((id) => waiting.has(id))) { waiting.add(other.id); grew = true; }
  }
  const open = plan.steps.filter(personStep).sort((a, b) => a.seq - b.seq);
  return open.find((other) => other.id !== step.id && waiting.has(other.id)) ?? open.find((other) => other.seq > step.seq);
}

/**
 * The assistant's preparation window (docs/work-split.md §4, the owner's decision of 2026-10-21): still `hours` (48) ahead, but counted
 * from the start of the person's step the preparation serves, not from the whole order's first block — an order whose first block is
 * tomorrow may not need a step's material for another week, and one whose first block is a week out may need it the day after.
 *
 * - A preparation step (`executor: "agent"`) is in the window when its served person step (`servedPersonStep`) starts by then: its next
 *   block (`schedule.stepStarts`, this week's only); with no block, its latest start worked back from the due day (the open person work
 *   from that step on at the person's daily hours); with no due day either, the order's own start (`startingWithin`). A step that serves
 *   no person step goes by the order's own start.
 * - A whole errand that prepares another order (`payload.prepares = <core order id>`, written on assistant-owned orders) goes by the core
 *   order's first open person step, the same way; with no such step, by the core order's start, then by its own.
 * - Any other order goes by its own start, as before.
 */
export function prepWindow(store: CrosslineStore, workspaceId: string, now: Date, hours = ASSISTANT_PREP_HOURS): PrepWindow {
  const ordersWithin = startingWithin(store, workspaceId, now, hours);
  const to = now.getTime() + hours * 3_600_000;
  let stepStarts: Record<string, string> = {};
  try {
    const value = JSON.parse(store.getSetting(workspaceId, STEP_STARTS_SETTING) ?? "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) stepStarts = value as Record<string, string>;
  } catch { /* unreadable: every step falls back */ }
  const scheduledOrders = new Set(Object.keys(stepStarts).map((key) => key.split("#")[0]!));
  const dueOf = dueDays(store, workspaceId, now);
  const dailyMinutes = dailyAvailableMinutes(store, workspaceId);
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && COMMITTED.has(order.state)).map((order) => [order.id, order]));

  /** Whether the person's `step` of `order` starts by `to`; undefined when nothing on record says when. */
  const personStepWithin = (order: StoredWorkOrder, plan: StoredStepPlan, step: StoredTaskStep): boolean | undefined => {
    const at = stepStarts[`${order.id}#${step.id}`];
    if (typeof at === "string" && Number.isFinite(Date.parse(at))) return Date.parse(at) <= to;
    const due = dueOf(order);
    if (due) {
      const minutes = plan.steps.filter((other) => personStep(other) && other.schedulable && other.seq >= step.seq).reduce((sum, other) => sum + other.estimate.p85Minutes, 0);
      return Date.parse(`${due}T00:00:00Z`) - Math.ceil(minutes / dailyMinutes) * DAY_MS <= to;
    }
    // Other steps of this order have blocks this week and this one has none: it is later than the week the web records.
    return scheduledOrders.has(order.id) ? false : undefined;
  };

  const steps = new Set<string>();
  for (const plan of store.listStepPlans(workspaceId)) {
    const order = orders.get(plan.workOrderId);
    if (!order) continue;
    for (const step of plan.steps) {
      if (step.executor !== "agent" || step.status !== "planned") continue;
      const served = servedPersonStep(plan, step);
      const within = served ? personStepWithin(order, plan, served) : undefined;
      if (within ?? ordersWithin.has(order.id)) steps.add(`${order.id}#${step.id}`);
    }
  }

  const errands = new Set<string>();
  for (const order of orders.values()) {
    const prepares = (order.payload as { prepares?: unknown } | undefined)?.prepares;
    const core = typeof prepares === "string" ? orders.get(prepares) : undefined;
    if (!core) { if (ordersWithin.has(order.id)) errands.add(order.id); continue; }
    const plan = store.getStepPlan(workspaceId, core.id);
    const first = plan?.steps.filter(personStep).sort((a, b) => a.seq - b.seq)[0];
    const within = plan && first ? personStepWithin(core, plan, first) : undefined;
    if (within ?? (ordersWithin.has(core.id) || ordersWithin.has(order.id))) errands.add(order.id);
  }
  return { orders: errands, steps };
}
