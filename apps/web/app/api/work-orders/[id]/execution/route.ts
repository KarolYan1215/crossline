import {
  archiveWorkOrder, completeWorkOrderExecution, markMaterialsReady, pauseWorkOrderExecution,
  resumeWorkOrderExecution, retryMaterialPreparation, startWorkOrderExecution,
  type ExecutionResult
} from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";
import { tOf } from "../../../../../lib/locale";
import { requestCodexSupervisor } from "../../../../../lib/codex-runtime";
import { titleOf, withUndo } from "../../../../../lib/undo";
import { readChecklistAnswers, readEvidence, readReport } from "../../../../../lib/execution-input";
import { readCompletionOutcome } from "@crossline/core";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const { ctx } = guard;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = String(body.reason ?? "");
  let result: ExecutionResult;
  try {
    if (body.action === "start") result = startWorkOrderExecution(ctx, id);
    else if (body.action === "materials_ready") result = markMaterialsReady(ctx, id, "human");
    else if (body.action === "materials_retry") {
      result = retryMaterialPreparation(ctx, id);
      // The event alone would only be honoured at the next 15-minute tick. Asking the worker to start
      // now is what makes the button feel like a button; if the worker is down the event still stands
      // and the tick picks it up, so a failure here is not a failure of the retry.
      if (result.ok) {
        await requestCodexSupervisor(ctx, `/v1/work-orders/${id}/prepare-materials`, {
          method: "POST", headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(10_000)
        }).catch(() => undefined);
      }
    }
    else if (body.action === "archive") result = await withUndo(ctx, tOf(ctx)("归档：{{title}}", { title: titleOf(ctx, id) }), () => archiveWorkOrder(ctx, id, reason));
    else if (body.action === "pause") result = pauseWorkOrderExecution(ctx, id, reason);
    else if (body.action === "resume") result = resumeWorkOrderExecution(ctx, id);
    else if (body.action === "complete") {
      const evidence = readEvidence(body.evidence);
      if (!evidence) return Response.json({ ok: false, code: "INVALID_EVIDENCE_CLAIM" }, { status: 400 });
      const checklistAnswers = readChecklistAnswers(body.checklistAnswers);
      if (!checklistAnswers) return Response.json({ ok: false, code: "INVALID_CHECKLIST_ANSWER" }, { status: 400 });
      // `outcome: {level: "smooth"|"barely"|"gaps", note}` is the optional 「完成情况」; completing is accepting (completion.ts).
      result = completeWorkOrderExecution(ctx, id, evidence, checklistAnswers, undefined, readReport(body), readCompletionOutcome(body.outcome));
    } else return Response.json({ ok: false, code: "EXECUTION_ACTION_NOT_ALLOWED" }, { status: 400 });
  } catch (error) {
    // A store-level guard is still a known failure, so it stays a typed blocker rather than a 500.
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "EXECUTION_FAILED";
    return Response.json({ ok: false, code }, { status: 409 });
  }

  if (result.ok) return Response.json(result);
  const status = result.code === "WORK_ORDER_NOT_FOUND" ? 404
    : result.code === "INTERRUPTION_REASON_REQUIRED" ? 400 : 409;
  return Response.json(result, { status });
}
