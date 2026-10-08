import "server-only";
import type { AccessContext } from "@crossline/core";
import { requestCodexSupervisor } from "./codex-runtime";
import { getStore } from "./crossline";

/**
 * Asks the worker to build (or rebuild) a task's tutorial: a step-by-step guide that follows the task's steps, written from its
 * materials, the person's own files and facts, and sources found on the web, with an analysis of each material. Answered at once;
 * the tutorial tab follows the build's progress from the ledger.
 */
export function requestTutorial(ctx: AccessContext, workOrderId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === workOrderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (!["approved", "preparing", "ready_for_human", "active"].includes(order.state)) return { ok: false, code: "TUTORIAL_NOT_AVAILABLE" };
  const attempt = store.listEvents(ctx.workspaceId, { type: "tutorial.requested", entityId: workOrderId }).length;
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `tutorial.requested:${workOrderId}:${attempt}`,
    type: "tutorial.requested", entityId: workOrderId, payload: {} });
  requestCodexSupervisor(ctx, `/v1/work-orders/${encodeURIComponent(workOrderId)}/tutorial`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000)
  }).catch(() => {});
  return { ok: true };
}
