import { requestTutorial } from "../../../../../lib/tutorial";
import { rejectUnsafeRequest } from "../guard";

/** 生成教程 / 重新生成: asks the worker to build the task's tutorial now; the tab follows its progress. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const result = requestTutorial(guard.ctx, id);
  return Response.json(result, { status: result.ok ? 202 : result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409 });
}
