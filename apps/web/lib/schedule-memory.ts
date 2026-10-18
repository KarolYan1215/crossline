import "server-only";
import { addChurn, PLAN_SNAPSHOT_SETTING, planChanges, planChurnKey, STEP_STARTS_SETTING, scheduledMinutesKey, type AccessContext, type PlanChurnDay, type PlanSnapshot } from "@crossline/core";
import { effectiveSchedulePreferences, effectiveWeight, getStore, loadCurrentPlan, plannerIdOfBlock, planToday, toZonedInstant } from "./crossline";

/** The setting that remembers which work was given a time on a day: `schedule.day:<YYYY-MM-DD>` → `{ [orderId]: "HH:MM" }`. */
export const scheduledDayKey = (day: string) => `schedule.day:${day}`;
export type ScheduledDay = Record<string, string>;
/** Order ids with a scheduled block in the next seven days, rewritten on the web's timer. */
export const UPCOMING_SETTING = "schedule.upcoming";
/** `{ [milestoneId]: 0–100 }`: approved milestones' effective importance; read by the worker's step planner. */
export const MILESTONE_WEIGHTS_SETTING = "milestone.weights";
/** `{ [orderId]: ISO instant }`: each order's earliest block this week; read by the worker (`apps/worker/src/schedule-window.ts`). */
export const ORDER_STARTS_SETTING = "schedule.orderStarts";

export function readScheduledDay(ctx: AccessContext, day: string): ScheduledDay {
  try { return JSON.parse(getStore().getSetting(ctx.workspaceId, scheduledDayKey(day)) || "{}") as ScheduledDay; } catch { return {}; }
}

/**
 * How long each order was planned for on a day (`scheduledMinutesKey`), the most seen for it that day. Kept beside `schedule.day` (whose
 * shape the missed-block ask reads) so the plan page can compare planned with timed hours per line; days before this was recorded have a
 * start time and no length, and count as not recorded.
 */
export type ScheduledMinutes = Record<string, number>;

export function readScheduledMinutes(ctx: AccessContext, day: string): ScheduledMinutes | null {
  const raw = getStore().getSetting(ctx.workspaceId, scheduledMinutesKey(day));
  if (!raw) return null;
  try { return JSON.parse(raw) as ScheduledMinutes; } catch { return null; }
}

const clockMinutes = (clock: string) => { const [h, m] = clock.split(":").map(Number); return h! * 60 + m!; };

/**
 * Remembers which work the plan gave a time today. The schedule is derived on read and never stored (so it cannot drift from the
 * work orders), which also meant nothing could say tomorrow what had been meant to happen today — so nothing could ask about it.
 * Kept as a union over the day (work placed this morning and moved this afternoon still counts as placed today), earliest start kept.
 */
export async function recordScheduledToday(ctx: AccessContext, now = new Date()): Promise<ScheduledDay> {
  const today = planToday(ctx, now);
  const plan = await loadCurrentPlan(ctx);
  const seen = readScheduledDay(ctx, today);
  for (const block of plan.blocks) {
    if (!block.id.startsWith("scheduled:") || block.day !== today) continue;
    const orderId = block.id.split(":")[1]!;
    if (!seen[orderId] || block.start < seen[orderId]!) seen[orderId] = block.start;
  }
  getStore().setSetting(ctx.workspaceId, scheduledDayKey(today), JSON.stringify(seen));
  const minutesNow: ScheduledMinutes = {};
  for (const block of plan.blocks) {
    if (!block.id.startsWith("scheduled:") || block.day !== today) continue;
    const orderId = block.id.split(":")[1]!;
    minutesNow[orderId] = (minutesNow[orderId] ?? 0) + Math.max(0, clockMinutes(block.end) - clockMinutes(block.start));
  }
  const minutes = readScheduledMinutes(ctx, today) ?? {};
  for (const [orderId, value] of Object.entries(minutesNow)) minutes[orderId] = Math.max(minutes[orderId] ?? 0, value);
  getStore().setSetting(ctx.workspaceId, scheduledMinutesKey(today), JSON.stringify(minutes));
  // The work with a time in the next seven days: the worker builds tutorials for these (it cannot derive the schedule itself).
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = [...new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today && block.day < weekEnd)
    .map((block) => block.id.split(":")[1]!))];
  getStore().setSetting(ctx.workspaceId, UPCOMING_SETTING, JSON.stringify(upcoming));
  // Where each step's next block starts, as an instant, for 「自动交给 Agent」 (the worker starts a step the system can do when its block
  // comes up). Rewritten whole each time, so a step the plan moved or dropped stops being due.
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const instant = (day: string, time: string) => { try { return toZonedInstant(day, time, zone); } catch { return undefined; } };
  getStore().setSetting(ctx.workspaceId, STEP_STARTS_SETTING, JSON.stringify(stepStartsOf(plan.blocks, today, weekEnd, instant)));
  // Each order's earliest block this week, as an instant: the worker prepares tutorials and the assistant's preparation only for work
  // starting soon (a week for tutorials, two days for the assistant: `apps/worker/src/schedule-window.ts`), and it cannot derive the schedule itself.
  const orderStarts: Record<string, string> = {};
  for (const block of plan.blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day || block.day < today || block.day >= weekEnd) continue;
    const at = instant(block.day, block.start);
    const orderId = block.id.split(":")[1]!;
    if (at && (!orderStarts[orderId] || at < orderStarts[orderId]!)) orderStarts[orderId] = at;
  }
  getStore().setSetting(ctx.workspaceId, ORDER_STARTS_SETTING, JSON.stringify(orderStarts));
  recordPlanChurn(ctx, plan.blocks, now, today, instant);
  // Each approved milestone's importance as the scheduler weighs it (the slider, else the presets): the worker cannot compute the
  // presets, and the step planner asks the person only about important work (docs/review-2026-10-13.md §11).
  const weights = Object.fromEntries(getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved")
    .map((milestone) => [milestone.id, effectiveWeight(ctx, milestone.id)]));
  getStore().setSetting(ctx.workspaceId, MILESTONE_WEIGHTS_SETTING, JSON.stringify(weights));
  return seen;
}

/**
 * `scheduled:<order>:<step>[:n]` blocks from today to `until` (exclusive) → `{ "<order>#<step>": earliest start as ISO }`. A block
 * whose third segment is not a step id (`v<version>s<n>`) is a whole-task block and has no step to hand over.
 */
export function stepStartsOf(blocks: Array<{ id: string; day?: string; start: string }>, today: string, until: string,
  toInstant: (day: string, time: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of blocks) {
    const [kind, orderId, stepId] = block.id.split(":");
    if (kind !== "scheduled" || !orderId || !stepId || !/^v\d+s\d+$/.test(stepId) || !block.day || block.day < today || block.day >= until) continue;
    const at = toInstant(block.day, block.start);
    const key = `${orderId}#${stepId}`;
    if (at && (!out[key] || at < out[key]!)) out[key] = at;
  }
  return out;
}

const OPEN_STATES = new Set(["approved", "preparing", "ready_for_human", "active"]);

/**
 * Compares where each piece of work starts in the next seven days with the last reading and adds what moved or lost its time to the
 * day's record (`packages/core/src/plan-churn.ts`), which 系统体检 averages. Kept under `metrics.`, not `schedule.`, so undoing an
 * operation never rewinds the measurement.
 */
function recordPlanChurn(ctx: AccessContext, blocks: Array<{ id: string; day?: string; start: string }>, now: Date, today: string,
  instant: (day: string, time: string) => string | undefined): void {
  const store = getStore();
  const until = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const starts: Record<string, string> = {};
  for (const block of blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day || block.day < today) continue;
    const at = instant(block.day, block.start);
    const key = plannerIdOfBlock(block.id);
    if (at && at < until && (!starts[key] || at < starts[key]!)) starts[key] = at;
  }
  const next: PlanSnapshot = { at: now.toISOString(), until, starts };
  let previous: PlanSnapshot | undefined;
  try { previous = JSON.parse(store.getSetting(ctx.workspaceId, PLAN_SNAPSHOT_SETTING) || "null") ?? undefined; } catch { previous = undefined; }
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const doneSteps = new Set(store.listStepPlans(ctx.workspaceId).flatMap((plan) => plan.steps.filter((step) => step.status !== "planned")
    .map((step) => `${plan.workOrderId}#${step.id}`)));
  const alive = (key: string) => OPEN_STATES.has(orders.get(key.split("#")[0]!)?.state ?? "") && !doneSteps.has(key);
  const changes = planChanges(previous, next, alive);
  let day: PlanChurnDay | undefined;
  try { day = JSON.parse(store.getSetting(ctx.workspaceId, planChurnKey(today)) || "null") ?? undefined; } catch { day = undefined; }
  store.setSetting(ctx.workspaceId, planChurnKey(today), JSON.stringify(addChurn(day, changes)));
  store.setSetting(ctx.workspaceId, PLAN_SNAPSHOT_SETTING, JSON.stringify(next));
}
