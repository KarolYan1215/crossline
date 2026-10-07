import { addWaitingForOrder } from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";

/** 「在等别人？」 on a task: who, what, and the day it is expected. The task stays off the schedule until then. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = await request.json().catch(() => null) as { who?: unknown; what?: unknown; expectedAt?: unknown; approximate?: unknown } | null;
  const result = addWaitingForOrder(guard.ctx, id, { who: String(body?.who ?? ""), what: String(body?.what ?? ""),
    expectedAt: String(body?.expectedAt ?? ""), approximate: body?.approximate === true });
  return Response.json(result, { status: result.ok ? 200 : result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 400 });
}
