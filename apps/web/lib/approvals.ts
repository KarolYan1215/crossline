import "server-only";
import { AUTO_APPROVAL_UNDO_MS, requiredApproval, taskTitleOf, type AccessContext } from "@crossline/core";
import { approveWorkOrderProposal, ensureSeeded, getStore, saveMilestoneEdit } from "./crossline";
import { requestCodexSupervisor } from "./codex-runtime";
import { requestTaskPass } from "./steps";
import { applyDraftWeight } from "./milestone-board";

export type BatchResult = { approved: string[]; skipped: Array<{ id: string; code: string }> };

/**
 * 「全部批准」 for work-order proposals. Each one goes through the same single approval the card button
 * uses; one that changed or is no longer approvable is reported in `skipped`, never fails the rest.
 */
export function approveWorkOrderProposals(ctx: AccessContext, ids: string[]): BatchResult {
  if (requiredApproval("approve_work_orders") !== "batch") throw new Error("APPROVAL_POLICY_CHANGED");
  ensureSeeded(ctx);
  const result: BatchResult = { approved: [], skipped: [] };
  for (const id of [...new Set(ids)].slice(0, 50)) {
    const outcome = approveWorkOrderProposal(ctx, id);
    if (outcome.ok) result.approved.push(id); else result.skipped.push({ id, code: outcome.code });
  }
  // What was just approved is split into steps now, not at the worker's next tick.
  if (result.approved.length) requestTaskPass(ctx);
  return result;
}

/**
 * Accepts a line's milestone drafts in one step (「接受这条线的 N 个草稿」): each draft is re-saved as an
 * approved version through the same `saveMilestoneEdit` the per-card button uses, so anchors, criteria and
 * the version history are exactly what a single approval leaves. Then asks the worker to work backwards
 * from the ones due soon, so the week has real steps on it without another round of clicks.
 */
export function approveMilestoneDrafts(ctx: AccessContext, ids: string[]): BatchResult {
  if (requiredApproval("approve_milestones") !== "batch") throw new Error("APPROVAL_POLICY_CHANGED");
  ensureSeeded(ctx);
  const store = getStore();
  const drafts = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").map((item) => [item.id, item]));
  const result: BatchResult = { approved: [], skipped: [] };
  for (const id of [...new Set(ids)].slice(0, 50)) {
    const draft = drafts.get(id);
    if (!draft) { result.skipped.push({ id, code: "MILESTONE_NOT_DRAFT" }); continue; }
    const saved = saveMilestoneEdit(ctx, { id, identityId: draft.identityId, projectId: draft.projectId ?? "",
      title: draft.title, status: "approved", successCriteria: draft.successCriteria ?? [],
      ...(draft.templateId ? { templateId: draft.templateId } : {}) });
    if (saved.ok) { result.approved.push(id); applyDraftWeight(ctx, id); } else result.skipped.push({ id, code: saved.code });
  }
  if (result.approved.length) requestAutoBackplan(ctx);
  return result;
}

/** Rejecting a line's drafts archives them (a new version each, so the person's decision is on record and they leave the board). */
export function rejectMilestoneDrafts(ctx: AccessContext, ids: string[]): BatchResult {
  ensureSeeded(ctx);
  const store = getStore();
  const drafts = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").map((item) => [item.id, item]));
  const result: BatchResult = { approved: [], skipped: [] };
  for (const id of [...new Set(ids)].slice(0, 50)) {
    const draft = drafts.get(id);
    if (!draft) { result.skipped.push({ id, code: "MILESTONE_NOT_DRAFT" }); continue; }
    const saved = saveMilestoneEdit(ctx, { id, identityId: draft.identityId, projectId: draft.projectId ?? "",
      title: draft.title, status: "archived", successCriteria: draft.successCriteria ?? [],
      ...(draft.templateId ? { templateId: draft.templateId } : {}) });
    if (saved.ok) result.approved.push(id); else result.skipped.push({ id, code: saved.code });
  }
  return result;
}

/** Fire-and-forget: the worker answers at once and works in the background, the same as auto-analysis. */
export function requestAutoBackplan(ctx: AccessContext): void {
  requestCodexSupervisor(ctx, "/v1/goals/auto-backplan", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000)
  }).catch(() => {});
}

export type AutoApproved = { id: string; intent: string; title: string; approvedAt: string; undoable: boolean; reason: string };

/** What took effect without a click in the last day, newest first, with whether it can still be undone. */
export function recentAutoApprovals(ctx: AccessContext, now = Date.now()): AutoApproved[] {
  const store = getStore();
  const revoked = new Set(store.listEvents(ctx.workspaceId, { type: "work_order.auto_approval_revoked" }).map((event) => event.entityId));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const started = new Set(store.listExecutions(ctx.workspaceId).map((execution) => execution.workOrderId));
  return store.listEvents(ctx.workspaceId, { type: "work_order.auto_approved" })
    .filter((event) => !revoked.has(event.entityId) && now - Date.parse(event.createdAt) < AUTO_APPROVAL_UNDO_MS)
    .flatMap((event) => {
      const order = orders.get(event.entityId);
      if (!order) return [];
      return [{ id: order.id, intent: order.intent, title: taskTitleOf(order), approvedAt: event.createdAt,
        reason: String((event.payload as { reason?: string }).reason ?? ""),
        undoable: ["approved", "preparing", "ready_for_human"].includes(order.state) && !started.has(order.id) }];
    }).reverse();
}

/** Takes back one automatic approval: the order returns to 待确认 and is never auto-approved again. */
export function revokeAutoApproval(ctx: AccessContext, workOrderId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const entry = recentAutoApprovals(ctx).find((item) => item.id === workOrderId);
  if (!entry) return { ok: false, code: "AUTO_APPROVAL_NOT_REVOCABLE" };
  if (!entry.undoable) return { ok: false, code: "WORK_ALREADY_STARTED" };
  const attempt = store.listEvents(ctx.workspaceId, { type: "work_order.auto_approval_revoked", entityId: workOrderId }).length;
  const result = store.transitionWorkOrder(ctx.workspaceId, workOrderId, { type: "approval.revoked", reason: "person_revoked_auto_approval" },
    `auto-approval-revoked:${workOrderId}:${attempt}`);
  if (!result.changed) return { ok: false, code: "AUTO_APPROVAL_NOT_REVOCABLE" };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.auto_approval_revoked:${workOrderId}:${attempt}`,
    type: "work_order.auto_approval_revoked", entityId: workOrderId, payload: {} });
  return { ok: true };
}
