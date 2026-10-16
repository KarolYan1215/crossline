import { postponeTask, type PostponeReason } from "../../../../../lib/task-ops";
import { tOf } from "../../../../../lib/locale";
import { titleOf, withUndo } from "../../../../../lib/undo";
import { rejectUnsafeRequest } from "../guard";

const REASONS = new Set<PostponeReason>(["waiting", "energy", "conflict", "time", "other"]);

/** `{reason, date, who, what, text}`: 推迟 with why; the reason decides what else changes (see `postponeTask`). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = String(body.reason ?? "") as PostponeReason;
  if (!REASONS.has(reason)) return Response.json({ ok: false, code: "POSTPONE_REASON_INVALID" }, { status: 400 });
  const result = await withUndo(guard.ctx, tOf(guard.ctx)("推迟：{{title}}", { title: titleOf(guard.ctx, id) }), () => postponeTask(guard.ctx, id, { reason, date: String(body.date ?? ""),
    who: String(body.who ?? "").slice(0, 60), what: String(body.what ?? "").slice(0, 200), text: String(body.text ?? "").slice(0, 500) }));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
