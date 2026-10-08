import { usableTaskOps } from "@crossline/core";
import { applyTaskOp } from "../../../../../lib/task-ops";
import { getStore } from "../../../../../lib/crossline";
import { titleOf, withUndo } from "../../../../../lib/undo";
import { rejectUnsafeRequest } from "../guard";

/**
 * `{ops}`: the changes the task's assistant read out of what the person said, applied together on 应用 and undone together. Each is
 * checked again against the task as it is now (a step that no longer exists is dropped); what could not be applied is named back.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as { ops?: unknown };
  const store = getStore();
  const order = store.listWorkOrders(guard.ctx.workspaceId).find((item) => item.id === id);
  if (!order) return Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  const steps = (store.getStepPlan(guard.ctx.workspaceId, id)?.steps ?? []).map((step) => ({ id: step.id, title: step.title, status: step.status, schedulable: step.schedulable, minutes: step.estimate.p50Minutes }));
  const ops = usableTaskOps(body.ops, { id, title: order.intent, state: order.state, dueDate: "", notBefore: "", usualMinutes: order.estimate.p50Minutes, steps });
  if (!ops.length) return Response.json({ ok: false, code: "TASK_OPS_EMPTY" }, { status: 400 });
  const failed: string[] = [];
  const result = await withUndo(guard.ctx, `${titleOf(guard.ctx, id)}：${ops.map((op) => op.summary).join("；")}`.slice(0, 160), async () => {
    for (const op of ops) { const outcome = await applyTaskOp(guard.ctx, id, op); if (!outcome.ok) failed.push(op.summary); }
    return { ok: failed.length < ops.length };
  });
  return Response.json({ ...result, failed }, { status: result.ok ? 200 : 409 });
}
