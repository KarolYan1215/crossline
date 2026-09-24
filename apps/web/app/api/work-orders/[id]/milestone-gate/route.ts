import { getStore } from "../../../../../lib/crossline";
import { requestCodexSupervisor } from "../../../../../lib/codex-runtime";
import { rejectUnsafeRequest } from "../guard";

/**
 * Asks for the milestone gate to judge this work order now.
 *
 * The gate runs on the worker's tick, which is fifteen minutes wide, and the approvals page could only
 * say 「等待里程碑闸门」 while it waited — with no way to tell a slow tick from a gate that had already
 * failed and stopped. The retry event stands on its own, so a worker that is down does not lose the
 * request: the next tick honours it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const { ctx } = guard;

  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === id);
  if (!order) return Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  if (order.state !== "evidence_review") return Response.json({ ok: false, code: "EVIDENCE_REVIEW_NOT_READY" }, { status: 409 });
  if (!order.milestoneId) return Response.json({ ok: false, code: "WORK_ORDER_HAS_NO_MILESTONE" }, { status: 409 });

  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `milestone-gate:retry:${id}:${Date.now()}`,
    type: "milestone_gate.retry_requested", entityId: id, payload: { requestedBy: ctx.principalId }
  });
  await requestCodexSupervisor(`/v1/work-orders/${id}/milestone-gate`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined);
  return Response.json({ ok: true });
}
