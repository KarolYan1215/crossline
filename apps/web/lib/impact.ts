import "server-only";
import type { AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { DEADLINE_MARGIN_DAYS } from "@crossline/planner";
import { getStore, loadCurrentPlan, loadGoalForecast, planToday, resolvedEstimate, withPreview, type PreviewOverrides } from "./crossline";

/**
 * What a change does across the lines before it is made (decided 2026-10-07: every change is previewed, then applied). The schedule and
 * the eight-week forecast are recomputed with the change in effect (`withPreview`, nothing written) and compared with the real ones:
 * which milestones finish earlier or later, how each line's hours this week move, and where the task's own next block goes.
 */
export type Change =
  | { kind: "estimate"; workOrderId: string; stepId?: string; p50Minutes: number }
  /** A block on the day view dragged longer or shorter: the step's (or task's) usual minutes move by the same amount. */
  | { kind: "estimate_delta"; workOrderId: string; stepId?: string; deltaMinutes: number }
  | { kind: "due"; workOrderId: string; date: string };

/** A relative change made absolute against what is stored now. */
function resolveChange(ctx: AccessContext, change: Change): Exclude<Change, { kind: "estimate_delta" }> {
  if (change.kind !== "estimate_delta") return change;
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === change.workOrderId);
  if (!order) throw new Error("WORK_ORDER_NOT_FOUND");
  const step = change.stepId ? store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.id === change.stepId) : undefined;
  const current = step?.estimate.p50Minutes ?? order.estimate.p50Minutes;
  return { kind: "estimate", workOrderId: change.workOrderId, ...(step ? { stepId: step.id } : {}), p50Minutes: Math.max(5, current + change.deltaMinutes) };
}

export type Impact = {
  task: { title: string; firstBefore?: string; firstAfter?: string };
  milestones: Array<{ id: string; title: string; line: string; deadline: string | null; before: string | null; after: string | null;
    shiftDays: number; atRiskBefore: boolean; atRiskAfter: boolean }>;
  lines: Array<{ line: string; label: string; beforeMinutes: number; afterMinutes: number }>;
};

const day = 86_400_000;
const daysBetween = (a: string | null, b: string | null) => a && b ? Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / day) : 0;

export function overridesFor(change: Exclude<Change, { kind: "estimate_delta" }>): PreviewOverrides {
  return change.kind === "estimate"
    ? { estimates: { [change.stepId ? `${change.workOrderId}#${change.stepId}` : change.workOrderId]: change.p50Minutes } }
    : { dueDates: { [change.workOrderId]: change.date } };
}

async function snapshot(ctx: AccessContext, workOrderId: string) {
  const [plan, forecast] = [await loadCurrentPlan(ctx), loadGoalForecast(ctx)];
  const today = planToday(ctx);
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * day).toISOString().slice(0, 10);
  const lineOf = new Map(getStore().listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.identityId]));
  const minutesByLine = new Map<string, number>();
  for (const block of plan.blocks) {
    if (!block.id.startsWith("scheduled:") || !block.day || block.day < today || block.day >= weekEnd) continue;
    const line = lineOf.get(block.id.split(":")[1]!) ?? "none";
    const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
    minutesByLine.set(line, (minutesByLine.get(line) ?? 0) + (eh! * 60 + em!) - (sh! * 60 + sm!));
  }
  const first = plan.blocks.filter((block) => block.id.startsWith(`scheduled:${workOrderId}`) && block.day)
    .map((block) => `${block.day} ${block.start}`).sort()[0];
  return { goals: forecast.goals, minutesByLine, ...(first ? { first } : {}) };
}

export async function previewChange(ctx: AccessContext, requested: Change): Promise<Impact> {
  const change = resolveChange(ctx, requested);
  const order = getStore().listWorkOrders(ctx.workspaceId).find((item) => item.id === change.workOrderId);
  if (!order) throw new Error("WORK_ORDER_NOT_FOUND");
  const before = await snapshot(ctx, change.workOrderId);
  const after = await withPreview(overridesFor(change), () => snapshot(ctx, change.workOrderId));
  const milestones = getStore().listMilestones(ctx.workspaceId);
  const labels = new Map(defaultIdentityPacks().map((pack) => [pack.id, pack.label]));
  const risk = (goal: { slackDays: number | null }) => goal.slackDays !== null && goal.slackDays < DEADLINE_MARGIN_DAYS;
  return {
    task: { title: order.intent, ...(before.first ? { firstBefore: before.first } : {}), ...(after.first ? { firstAfter: after.first } : {}) },
    milestones: before.goals.flatMap((goal) => {
      const next = after.goals.find((item) => item.milestoneId === goal.milestoneId);
      if (!next) return [];
      const shiftDays = daysBetween(goal.p85Day, next.p85Day);
      const atRiskBefore = risk(goal), atRiskAfter = risk(next);
      if (!shiftDays && atRiskBefore === atRiskAfter) return [];
      return [{ id: goal.milestoneId, title: goal.title, line: milestones.find((item) => item.id === goal.milestoneId)?.identityId ?? "none",
        deadline: goal.confirmedDeadline, before: goal.p85Day, after: next.p85Day, shiftDays, atRiskBefore, atRiskAfter }];
    }),
    lines: [...new Set([...before.minutesByLine.keys(), ...after.minutesByLine.keys()])]
      .map((line) => ({ line, label: labels.get(line) ?? line, beforeMinutes: before.minutesByLine.get(line) ?? 0, afterMinutes: after.minutesByLine.get(line) ?? 0 }))
      .filter((item) => item.beforeMinutes !== item.afterMinutes)
  };
}

/** Makes the change real, and records it as a preference sample for later estimates (decided 2026-10-07). */
export function applyChange(ctx: AccessContext, requested: Change): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  let change: Exclude<Change, { kind: "estimate_delta" }>;
  try { change = resolveChange(ctx, requested); } catch { return { ok: false, code: "WORK_ORDER_NOT_FOUND" }; }
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === change.workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (change.kind === "due") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date)) return { ok: false, code: "DUE_DATE_INVALID" };
    const payload = (order.payload ?? {}) as Record<string, unknown>;
    store.saveWorkOrder({ ...order, payload: { ...payload, dueDate: change.date } });
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.due_changed:${order.id}:${change.date}:${Date.now()}`,
      type: "work_order.due_changed", entityId: order.id, payload: { before: (payload.dueDate as string | undefined) ?? null, after: change.date } });
    return { ok: true };
  }
  const minutes = Math.round(change.p50Minutes);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10_080) return { ok: false, code: "ESTIMATE_INVALID" };
  if (change.stepId) {
    const step = store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.id === change.stepId);
    if (!step) return { ok: false, code: "STEP_NOT_FOUND" };
    const ratio = minutes / Math.max(1, step.estimate.p50Minutes);
    store.updateStepEstimate(ctx.workspaceId, order.id, step.id, { p25Minutes: Math.max(1, Math.round(step.estimate.p25Minutes * ratio)), p50Minutes: minutes,
      p85Minutes: Math.max(minutes, Math.round(step.estimate.p85Minutes * ratio)) }, ctx.principalId);
  } else {
    const ratio = minutes / Math.max(1, order.estimate.p50Minutes);
    store.saveWorkOrder({ ...order, estimate: { ...order.estimate, p50Minutes: minutes, p25Minutes: Math.max(1, Math.round(order.estimate.p25Minutes * ratio)),
      p85Minutes: Math.max(minutes, Math.round(order.estimate.p85Minutes * ratio)) } });
  }
  const before = change.stepId ? undefined : resolvedEstimate(ctx, order).p50Minutes;
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `estimate.adjusted:${order.id}:${change.stepId ?? ""}:${Date.now()}`,
    type: "estimate.adjusted", entityId: order.id, payload: { stepId: change.stepId ?? null, before: before ?? null, after: minutes,
      family: (order.payload as { family?: string } | undefined)?.family ?? null, line: order.identityId } });
  return { ok: true };
}
