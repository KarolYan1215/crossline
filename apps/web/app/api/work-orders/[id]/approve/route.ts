import { approveWorkOrderProposal } from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const unsafe = rejectUnsafeRequest(request, id);
  if (unsafe) return unsafe;
  const result = approveWorkOrderProposal(id);
  return result.ok ? Response.json(result) : Response.json(result, { status: result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409 });
}
