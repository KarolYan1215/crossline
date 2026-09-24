import { acceptWorkOrderEvidence, blockWorkOrderEvidence, revokeAutoAcceptedWorkOrder } from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const { ctx } = guard;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Milestone-bound items cannot use this human shortcut; only the verified AI gate can accept them.
  const result = body.decision === "block"
    ? blockWorkOrderEvidence(ctx, id, String(body.reason ?? ""))
    // Automatic acceptance is only safe because it is reversible, so revoking is a first-class action.
    : body.decision === "revoke"
      ? revokeAutoAcceptedWorkOrder(ctx, id, String(body.reason ?? ""))
      : acceptWorkOrderEvidence(ctx, id);
  if (result.ok) return Response.json(result);
  const status = result.code === "WORK_ORDER_NOT_FOUND" ? 404
    : result.code === "BLOCK_REASON_REQUIRED" || result.code === "REVOCATION_REASON_REQUIRED" ? 400 : 409;
  return Response.json(result, { status });
}
