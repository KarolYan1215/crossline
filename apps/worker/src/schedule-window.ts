import { AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, goalSettingKey, resolveAvailability, weeklyAvailableHours } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";

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

/** Committed work with no recorded block whose latest start, worked back from its due day, falls on or before `to`. */
function estimatedStarts(store: CrosslineStore, workspaceId: string, now: Date, recorded: string[], to: number): string[] {
  const skip = new Set(recorded);
  const orders = store.listWorkOrders(workspaceId).filter((order) => COMMITTED.has(order.state) && !skip.has(order.id));
  if (!orders.length) return [];
  const today = now.toISOString().slice(0, 10);
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const { windows } = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(workspaceId) });
  const dailyMinutes = Math.max(60, weeklyAvailableHours(windows) * 60 / 7);
  return orders.filter((order) => {
    // The same due day the step planner uses: the task's own, else the milestone's confirmed deadline, else its anchor.
    let goal: string | undefined;
    try { goal = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(order.milestoneId)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* none */ }
    const due = [(order.payload as { dueDate?: string } | undefined)?.dueDate, goal, anchors.get(order.milestoneId)]
      .find((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)));
    if (!due || due < today) return false;
    const open = store.getStepPlan(workspaceId, order.id)?.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
    const minutes = open?.length ? open.reduce((sum, step) => sum + step.estimate.p85Minutes, 0) : order.estimate.p85Minutes;
    const start = Date.parse(`${due}T00:00:00Z`) - Math.ceil(minutes / dailyMinutes) * DAY_MS;
    return start <= to;
  }).map((order) => order.id);
}
