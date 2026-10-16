import { setCompletionMode } from "../../../../../lib/crossline";
import { tOf } from "../../../../../lib/locale";
import { rejectUnsafeRequest } from "../guard";
import { titleOf, withUndo } from "../../../../../lib/undo";

/** `{mode: "self_evident" | "needs_assessment"}`: the person's choice of how finishing this task is taken (overrides the model's). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
  if (body.mode !== "self_evident" && body.mode !== "needs_assessment") return Response.json({ ok: false, code: "COMPLETION_MODE_INVALID" }, { status: 400 });
  const mode = body.mode;
  const result = await withUndo(guard.ctx, tOf(guard.ctx)("完成方式：{{title}}", { title: titleOf(guard.ctx, id) }), () => setCompletionMode(guard.ctx, id, mode));
  return result.ok ? Response.json(result) : Response.json(result, { status: result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409 });
}
