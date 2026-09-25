import { backfillWorkOrderFamily } from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const { ctx } = guard;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = backfillWorkOrderFamily(ctx, id, body.family);
  if (result.ok) return Response.json(result);
  const status = result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 400;
  return Response.json(result, { status });
}
