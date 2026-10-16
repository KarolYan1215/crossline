import { approveWorkOrderProposal } from "../../../../../lib/crossline";
import { tOf } from "../../../../../lib/locale";
import { rejectUnsafeRequest } from "../guard";
import { titleOf, withUndo } from "../../../../../lib/undo";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  // Optional `acceptanceStandard: string[]`: the standard as edited on the card; the task is judged by it afterwards.
  // Optional `completionMode`: how finishing it is taken, as chosen on the card (overrides the model's judgement).
  const body = (await request.json().catch(() => ({}))) as { acceptanceStandard?: unknown; completionMode?: unknown };
  const acceptanceStandard = Array.isArray(body.acceptanceStandard) ? body.acceptanceStandard.filter((line): line is string => typeof line === "string") : undefined;
  const completionMode = body.completionMode === "self_evident" || body.completionMode === "needs_assessment" ? body.completionMode : undefined;
  const result = await withUndo(guard.ctx, tOf(guard.ctx)("批准：{{title}}", { title: titleOf(guard.ctx, id) }), () => approveWorkOrderProposal(guard.ctx, id,
    { ...(acceptanceStandard ? { acceptanceStandard } : {}), ...(completionMode ? { completionMode } : {}) }));
  return result.ok ? Response.json(result) : Response.json(result, { status: result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409 });
}
