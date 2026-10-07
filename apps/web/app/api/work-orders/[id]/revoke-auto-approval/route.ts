import { revokeAutoApproval } from "../../../../../lib/approvals";
import { rejectUnsafeRequest } from "../guard";

/** Undo for something that took effect without a click: back to 待确认, and never auto-approved again. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const result = revokeAutoApproval(guard.ctx, id);
  return result.ok ? Response.json(result) : Response.json(result, { status: 409 });
}
