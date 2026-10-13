import "server-only";
import { taskTitleOf, type AccessContext } from "@crossline/core";
import { listAgentTasks } from "@crossline/db";
import { archiveWorkOrder, completeWorkOrderExecution, getStore, planToday, startWorkOrderExecution } from "./crossline";
import { rejectMilestoneDrafts } from "./approvals";
import { readScheduledDay } from "./schedule-memory";
import { lineLabels } from "./lines";

/**
 * Coming back (docs/review-2026-10-13.md §6.3, the person's decision): after days away the first thing shown is what happened meanwhile
 * and the work that was due, each settled in one tap — 完成 / 做了一部分 / 没做顺延 / 不做了 — beside the input box for anything else;
 * proposals and drafts nobody touched for fourteen days are archived (recoverable). Before this, coming back meant a wall of 85 open
 * decisions, which made coming back cost more than staying away.
 */
export const RETURN_AFTER_HOURS = 48;
export const STALE_DAYS = 14;
/** The absence (its start) the person chose to skip the return page for. */
export const RETURN_DISMISSED = "return.dismissed";

const DAY = 86_400_000;
const OPEN = ["approved", "preparing", "ready_for_human", "active"];

/** When the person's absence began, if they have been away long enough for the return page and have not skipped it for this absence. */
export function returnDue(ctx: AccessContext, now: Date): { since: string } | undefined {
  const store = getStore();
  const since = store.lastPersonActivity(ctx.workspaceId);
  // Someone who never did anything yet is new, not back.
  if (!since || now.getTime() - Date.parse(since) <= RETURN_AFTER_HOURS * 3_600_000) return undefined;
  return store.getSetting(ctx.workspaceId, RETURN_DISMISSED) === since ? undefined : { since };
}

export type ReturnItem = { orderId: string; title: string; line: string; lineLabel: string; plannedDays: string[]; dueDay: string;
  p50Minutes: number; steps: Array<{ id: string; title: string; done: boolean }> };
export type ReturnView = {
  since: string; daysAway: number; items: ReturnItem[];
  happened: { assistantDone: number; proposals: number; calendarChanges: number; deadlinesSoon: Array<{ title: string; deadline: string }> };
  stale: { orders: Array<{ id: string; title: string }>; milestones: Array<{ id: string; title: string }> };
};

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Proposals and drafts untouched for fourteen days: a task proposal waiting since then, a milestone draft proposed since then and never edited. */
function staleItems(ctx: AccessContext, now: Date): ReturnView["stale"] {
  const store = getStore();
  const cutoff = new Date(now.getTime() - STALE_DAYS * DAY).toISOString();
  const lastAt = (type: string) => {
    const out = new Map<string, string>();
    for (const event of store.listEvents(ctx.workspaceId, { type })) if ((out.get(event.entityId) ?? "") < event.createdAt) out.set(event.entityId, event.createdAt);
    return out;
  };
  const transitioned = lastAt("work_order.transitioned"), proposed = lastAt("milestone.proposed"), revised = lastAt("milestone.revised");
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval"
    && (transitioned.get(order.id) ?? "") !== "" && transitioned.get(order.id)! <= cutoff)
    .map((order) => ({ id: order.id, title: taskTitleOf(order) }));
  const milestones = store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "draft" && !revised.has(milestone.id)
    && (proposed.get(milestone.id) ?? "") !== "" && proposed.get(milestone.id)! <= cutoff)
    .map((milestone) => ({ id: milestone.id, title: milestone.title }));
  return { orders, milestones };
}

export function returnView(ctx: AccessContext, since: string, now: Date): ReturnView {
  const store = getStore();
  const today = planToday(ctx, now);
  const from = planToday(ctx, new Date(since));
  // The days the person was away, as the attention timer recorded each day's planned work (the schedule itself keeps no past).
  const planned = new Map<string, string[]>();
  for (let day = from; day < today; day = addDays(day, 1))
    for (const orderId of Object.keys(readScheduledDay(ctx, day))) planned.set(orderId, [...(planned.get(orderId) ?? []), day]);
  const labels = lineLabels(ctx);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const answered = new Set(store.listEvents(ctx.workspaceId, { type: "return.answered" }).filter((event) => event.createdAt >= since).map((event) => event.entityId));
  const items = store.listWorkOrders(ctx.workspaceId).flatMap((order): ReturnItem[] => {
    if (!OPEN.includes(order.state) || order.tombstone || answered.has(order.id) || (order.payload as { seeded?: boolean }).seeded) return [];
    const dueDay = (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "";
    const plannedDays = planned.get(order.id) ?? [];
    // Work that had a time while they were away, or whose due day passed.
    if (!plannedDays.length && !(dueDay && dueDay < today)) return [];
    const steps = (store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? []).filter((step) => step.executor !== "agent" && step.status !== "skipped")
      .map((step) => ({ id: step.id, title: step.title, done: step.status === "done" }));
    return [{ orderId: order.id, title: taskTitleOf(order), line: order.identityId, lineLabel: labels[order.identityId] ?? order.identityId, plannedDays, dueDay,
      p50Minutes: order.estimate.p50Minutes, steps }];
  }).sort((a, b) => (a.dueDay || "9999").localeCompare(b.dueDay || "9999"));
  const approvedDeadlines = store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved")
    .flatMap((milestone) => { const deadline = anchors.get(milestone.id); return deadline && deadline >= today && deadline <= addDays(today, 7) ? [{ title: milestone.title, deadline }] : []; })
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  const finishedAt = (task: { requestedAt: string; durationMs: number }) => new Date(Date.parse(task.requestedAt) + task.durationMs).toISOString();
  return {
    since, daysAway: Math.max(1, Math.round((now.getTime() - Date.parse(since)) / DAY)), items,
    happened: {
      assistantDone: listAgentTasks(store, ctx.workspaceId).filter((task) => ["needs_review", "accepted"].includes(task.status) && finishedAt(task) >= since).length,
      proposals: store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval").length,
      calendarChanges: store.listEvents(ctx.workspaceId, { type: "plan.reality_changed" }).filter((event) => event.createdAt >= since).length,
      deadlinesSoon: approvedDeadlines
    },
    stale: staleItems(ctx, now)
  };
}

/** Archives what nobody touched for fourteen days (recoverable from 已丢弃 and the milestone archive); returns what it archived. */
export function cleanStale(ctx: AccessContext, now: Date): { ok: true; orders: string[]; milestones: string[] } {
  const stale = staleItems(ctx, now);
  const orders = stale.orders.filter((order) => archiveWorkOrder(ctx, order.id, `超过 ${STALE_DAYS} 天无人处理，回来时自动归档`, { bySystem: true }).ok).map((order) => order.id);
  const milestones = stale.milestones.length ? rejectMilestoneDrafts(ctx, stale.milestones.map((milestone) => milestone.id)).approved : [];
  return { ok: true, orders, milestones };
}

export type ReturnVerdict = "done" | "partial" | "rolled" | "dropped";

/** One tap on one task. 完成 finishes it (with how long it took, when said); 做了一部分 marks the ticked steps done; 没做顺延 leaves it to the scheduler; 不做了 discards it. */
export function answerReturn(ctx: AccessContext, orderId: string, verdict: ReturnVerdict, detail: { minutes?: number; stepIds?: string[] } = {}, now = new Date()):
  { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const order = store.getWorkOrder(ctx.workspaceId, orderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (verdict === "done") {
    if (!["evidence_review", "accepted"].includes(order.state)) {
      if (order.state !== "active") { const started = startWorkOrderExecution(ctx, orderId, now.toISOString()); if (!started.ok) return started; }
      const minutes = detail.minutes && detail.minutes > 0 ? Math.round(detail.minutes) : undefined;
      const done = completeWorkOrderExecution(ctx, orderId, [], [], now.toISOString(), minutes ? { minutes, source: "one_tap" } : undefined);
      if (!done.ok) return done;
    }
  } else if (verdict === "partial") {
    const steps = new Set(store.getStepPlan(ctx.workspaceId, orderId)?.steps.map((step) => step.id) ?? []);
    const ticked = (detail.stepIds ?? []).filter((id) => steps.has(id));
    if (!ticked.length) return { ok: false, code: "RETURN_STEPS_REQUIRED" };
    for (const stepId of ticked) store.updateStepProgress(ctx.workspaceId, orderId, stepId, { status: "done" }, ctx.principalId, "person");
  } else if (verdict === "dropped") {
    const archived = archiveWorkOrder(ctx, orderId, "回来时标为不做了");
    if (!archived.ok) return archived;
  }
  const attempt = store.listEvents(ctx.workspaceId, { type: "return.answered", entityId: orderId }).length;
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `return.answered:${orderId}:${attempt}`, type: "return.answered",
    entityId: orderId, payload: { verdict, ...(detail.minutes ? { minutes: detail.minutes } : {}), ...(detail.stepIds?.length ? { stepIds: detail.stepIds } : {}) } });
  return { ok: true };
}

/** 「先跳过」: the return page is not shown again for this absence. */
export function dismissReturn(ctx: AccessContext, since: string): { ok: true } {
  getStore().setSetting(ctx.workspaceId, RETURN_DISMISSED, since);
  return { ok: true };
}
