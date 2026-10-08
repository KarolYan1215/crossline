import { approveWorkOrderProposal } from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";
import { titleOf, withUndo } from "../../../../../lib/undo";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const result = await withUndo(guard.ctx, `批准：${titleOf(guard.ctx, id)}`, () => approveWorkOrderProposal(guard.ctx, id));
  return result.ok ? Response.json(result) : Response.json(result, { status: result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409 });
}
