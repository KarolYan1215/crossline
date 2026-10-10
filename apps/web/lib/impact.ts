import "server-only";
import { EDIT_MINUTES, type AccessContext, type AvailabilityWindow } from "@crossline/core";
import { DEADLINE_MARGIN_DAYS, type ScheduleParams } from "@crossline/planner";
import { effectiveSchedulePreferences, getStore, loadCurrentPlan, loadGoalForecast, planToday, resolvedEstimate, saveAvailability, saveGoalSettings,
  saveLineShares, saveScheduleParams, SCHEDULE_KEEP, withPreview, type PreviewOverrides } from "./crossline";
import { lineLabels } from "./lines";
import { loadForecastCharts } from "./plan-board";
import type { ForecastCharts } from "./plan-stats";

/**
 * What a change does across the lines before it is made (decided 2026-10-07: every change is previewed, then applied). The schedule and
 * the eight-week forecast are recomputed with the change in effect (`withPreview`, nothing written) and compared with the real ones:
 * which milestones finish earlier or later, how each line's hours this week move, and where the task's own next block goes.
 */
export type Change =
  | { kind: "estimate"; workOrderId: string; stepId?: string; p50Minutes: number }
  /** A block on the day view dragged longer or shorter: the step's (or task's) usual minutes move by the same amount. */
  | { kind: "estimate_delta"; workOrderId: string; stepId?: string; deltaMinutes: number }
  | { kind: "due"; workOrderId: string; date: string }
  /** Not before a day: the work moves later (「推到下周一再做」). */
  | { kind: "defer"; workOrderId: string; date: string }
  /** The plan page's controls: the week repainted on the heatmap, the four packing numbers, one milestone's importance slider. */
  | { kind: "availability"; windows: AvailabilityWindow[]; timeZone?: string }
  | { kind: "params"; params: ScheduleParams }
  | { kind: "weight"; milestoneId: string; weight: number }
  | { kind: "shares"; shares: Record<string, number> };

type TaskChange = Extract<Change, { workOrderId: string }>;
const isTaskChange = (change: Change): change is TaskChange => "workOrderId" in change;

/** A relative change made absolute against what is stored now. */
function resolveChange(ctx: AccessContext, change: Change): Exclude<Change, { kind: "estimate_delta" }> {
  if (change.kind !== "estimate_delta") return change;
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === change.workOrderId);
  if (!order) throw new Error("WORK_ORDER_NOT_FOUND");
  const step = change.stepId ? store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.id === change.stepId) : undefined;
  const current = step?.estimate.p50Minutes ?? order.estimate.p50Minutes;
  return { kind: "estimate", workOrderId: change.workOrderId, ...(step ? { stepId: step.id } : {}), p50Minutes: Math.min(EDIT_MINUTES.max, Math.max(EDIT_MINUTES.min, current + change.deltaMinutes)) };
}

export type Impact = {
  task?: { title: string; firstBefore?: string; firstAfter?: string };
  /** The next seven days: free minutes, minutes the schedule fills, and how many tasks it could not place. */
  week: { availableBefore: number; availableAfter: number; plannedBefore: number; plannedAfter: number; unplacedBefore: number; unplacedAfter: number;
    /** Blocks in the next seven days that are new or moved (a different day, start or length). */
    blocksChanged: number };
  milestones: Array<{ id: string; title: string; line: string; deadline: string | null; before: string | null; after: string | null;
    shiftDays: number; atRiskBefore: boolean; atRiskAfter: boolean }>;
  lines: Array<{ line: string; label: string; beforeMinutes: number; afterMinutes: number }>;
  /** The plan page's charts before and after, over the horizon it shows; only when asked for (`chartsHorizonDays`). */
  charts?: { before: ForecastCharts; after: ForecastCharts };
};

const day = 86_400_000;
const daysBetween = (a: string | null, b: string | null) => a && b ? Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / day) : 0;

export function overridesFor(change: Exclude<Change, { kind: "estimate_delta" }>): PreviewOverrides {
  if (change.kind === "availability") return { availability: change.windows };
  if (change.kind === "params") return { params: change.params };
  if (change.kind === "weight") return { weights: { [change.milestoneId]: change.weight } };
  if (change.kind === "shares") return { lineShares: change.shares };
  return change.kind === "estimate"
    ? { estimates: { [change.stepId ? `${change.workOrderId}#${change.stepId}` : change.workOrderId]: change.p50Minutes } }
    : change.kind === "due" ? { dueDates: { [change.workOrderId]: change.date } } : { notBefore: { [change.workOrderId]: change.date } };
}

async function snapshot(ctx: AccessContext, workOrderId?: string, chartsHorizonDays?: number) {
  const [plan, forecast] = [await loadCurrentPlan(ctx), loadGoalForecast(ctx)];
  const charts = chartsHorizonDays ? (({ inferredRegularBlocks: _, summary: __, ...rest }) => rest)(loadForecastCharts(ctx, plan, chartsHorizonDays)) : undefined;
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
  const first = workOrderId ? plan.blocks.filter((block) => block.id.startsWith(`scheduled:${workOrderId}`) && block.day)
    .map((block) => `${block.day} ${block.start}`).sort()[0] : undefined;
  return { goals: forecast.goals, minutesByLine, ...(first ? { first } : {}), ...(charts ? { charts } : {}), available: forecast.weeks[0]?.netMinutes ?? 0,
    planned: [...minutesByLine.values()].reduce((sum, minutes) => sum + minutes, 0),
    unplaced: plan.schedule.blockers.filter((blocker) => !blocker.code.startsWith("Q4_")).length,
    blocks: new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today && block.day < weekEnd)
      .map((block) => `${block.id.split(":").slice(0, 3).join(":")}|${block.day}|${block.start}|${block.end}`)) };
}

/** `chartsHorizonDays`: also return the plan page's charts before and after, over that horizon (the page's charts show both while it waits). */
export async function previewChange(ctx: AccessContext, requested: Change, options: { chartsHorizonDays?: number } = {}): Promise<Impact> {
  const change = resolveChange(ctx, requested);
  const order = isTaskChange(change) ? getStore().listWorkOrders(ctx.workspaceId).find((item) => item.id === change.workOrderId) : undefined;
  if (isTaskChange(change) && !order) throw new Error("WORK_ORDER_NOT_FOUND");
  const before = await snapshot(ctx, order?.id, options.chartsHorizonDays);
  const after = await withPreview(overridesFor(change), () => snapshot(ctx, order?.id, options.chartsHorizonDays));
  const milestones = getStore().listMilestones(ctx.workspaceId);
  const labels = new Map(Object.entries(lineLabels(ctx)));
  const risk = (goal: { slackDays: number | null }) => goal.slackDays !== null && goal.slackDays < DEADLINE_MARGIN_DAYS;
  return {
    ...(order ? { task: { title: order.intent, ...(before.first ? { firstBefore: before.first } : {}), ...(after.first ? { firstAfter: after.first } : {}) } } : {}),
    week: { availableBefore: before.available, availableAfter: after.available, plannedBefore: before.planned, plannedAfter: after.planned,
      unplacedBefore: before.unplaced, unplacedAfter: after.unplaced,
      blocksChanged: [...after.blocks].filter((block) => !before.blocks.has(block)).length },
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
      .filter((item) => item.beforeMinutes !== item.afterMinutes),
    ...(before.charts && after.charts ? { charts: { before: before.charts, after: after.charts } } : {})
  };
}

/** Makes the change real, and records it as a preference sample for later estimates (decided 2026-10-07). */
export function applyChange(ctx: AccessContext, requested: Change): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  let change: Exclude<Change, { kind: "estimate_delta" }>;
  try { change = resolveChange(ctx, requested); } catch { return { ok: false, code: "WORK_ORDER_NOT_FOUND" }; }
  // A change to the person's hours, the packing numbers or what matters re-plans everything: blocks kept by a local re-plan are let go.
  if (change.kind === "availability" || change.kind === "params" || change.kind === "weight" || change.kind === "shares") store.deleteSetting(ctx.workspaceId, SCHEDULE_KEEP);
  if (change.kind === "shares") return saveLineShares(ctx, change.shares);
  if (change.kind === "availability") {
    const saved = saveAvailability(ctx, change.windows);
    if (!saved.ok) return saved;
    // The first saved week also fixes the zone it is in (the browser's), as the old setup form did.
    if (effectiveSchedulePreferences(ctx).isDefault && change.timeZone) {
      try { new Intl.DateTimeFormat("en", { timeZone: change.timeZone }); } catch { return { ok: true }; }
      store.setSetting(ctx.workspaceId, "schedule.preferences", JSON.stringify({ ...effectiveSchedulePreferences(ctx).preferences, timeZone: change.timeZone }));
    }
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `availability.saved:${Date.now()}`,
      type: "availability.saved", entityId: ctx.workspaceId, payload: { windows: change.windows.length } });
    return { ok: true };
  }
  if (change.kind === "params") return saveScheduleParams(ctx, change.params);
  if (change.kind === "weight") {
    const saved = saveGoalSettings(ctx, change.milestoneId, { weight: change.weight });
    const milestone = store.listMilestones(ctx.workspaceId).filter((item) => item.id === change.milestoneId).at(-1);
    if (saved.ok && milestone) store.addPreference({ workspaceId: ctx.workspaceId, source: "importance", scope: milestone.identityId, weight: 0.5,
      refId: milestone.id, text: `里程碑「${milestone.title}」重要性由本人设为 ${change.weight}` });
    return saved;
  }
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === change.workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (change.kind === "defer") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date)) return { ok: false, code: "DUE_DATE_INVALID" };
    const payload = (order.payload ?? {}) as Record<string, unknown>;
    store.saveWorkOrder({ ...order, payload: { ...payload, notBefore: change.date } });
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.deferred:${order.id}:${change.date}:${Date.now()}`,
      type: "work_order.deferred", entityId: order.id, payload: { before: (payload.notBefore as string | undefined) ?? null, after: change.date } });
    return { ok: true };
  }
  if (change.kind === "due") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date)) return { ok: false, code: "DUE_DATE_INVALID" };
    const payload = (order.payload ?? {}) as Record<string, unknown>;
    store.saveWorkOrder({ ...order, payload: { ...payload, dueDate: change.date } });
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.due_changed:${order.id}:${change.date}:${Date.now()}`,
      type: "work_order.due_changed", entityId: order.id, payload: { before: (payload.dueDate as string | undefined) ?? null, after: change.date } });
    return { ok: true };
  }
  const minutes = Math.round(change.p50Minutes);
  const bounds = EDIT_MINUTES;
  if (!Number.isFinite(minutes) || minutes < bounds.min || minutes > bounds.max) return { ok: false, code: "ESTIMATE_INVALID" };
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
  // A manual edit is a weak signal next to measured time (which calibration learns from), so it is recorded with a low weight.
  const step = change.stepId ? store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((item) => item.id === change.stepId) : undefined;
  store.addPreference({ workspaceId: ctx.workspaceId, source: "estimate", scope: order.identityId, weight: 0.3, refId: `${order.id}:${change.stepId ?? ""}`,
    text: `任务「${order.intent}」${step ? `的步骤「${step.title}」` : ""}估时由本人改为 ${minutes} 分钟` });
  return { ok: true };
}
