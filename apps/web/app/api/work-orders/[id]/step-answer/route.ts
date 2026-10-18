import { changeStepAnswer } from "../../../../../lib/steps";
import { rejectUnsafeRequest } from "../guard";
import { titleOf, withUndo } from "../../../../../lib/undo";

/** `{question, answer}`: the person answers, or changes the app's assumption for, one of the task's plan questions. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as { question?: unknown; answer?: unknown };
  if (typeof body.question !== "string" || typeof body.answer !== "string" || body.question.length > 500 || body.answer.length > 300)
    return Response.json({ ok: false, code: "STEP_ANSWER_INVALID" }, { status: 400 });
  const { question, answer } = body;
  const result = await withUndo(guard.ctx, `改步骤问题的回答：${titleOf(guard.ctx, id)}`, () => changeStepAnswer(guard.ctx, id, question, answer));
  return result.ok ? Response.json(result) : Response.json(result, { status: result.code === "WORK_ORDER_NOT_FOUND" ? 404 : 409 });
}
