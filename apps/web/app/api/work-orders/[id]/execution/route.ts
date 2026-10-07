import type { EvidenceClaimInput } from "@crossline/db";
import type { ChecklistAnswer } from "@crossline/core";
import {
  archiveWorkOrder, completeWorkOrderExecution, markMaterialsReady, pauseWorkOrderExecution,
  resumeWorkOrderExecution, retryMaterialPreparation, startWorkOrderExecution,
  type ExecutionResult
} from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";
import { requestCodexSupervisor } from "../../../../../lib/codex-runtime";

const EVIDENCE_KINDS = ["file", "link", "record", "telemetry"];

/** Shape-checks the pre-generated checklist answers submitted alongside evidence — see 工作块 E. Unlike
 * `evidence`, these are optional and have no kind to validate, just an id (matched against the order's
 * own `evidenceChecklist` later, at gate time) and a bounded answer string. */
function readChecklistAnswers(value: unknown): ChecklistAnswer[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const answers: ChecklistAnswer[] = [];
  for (const entry of value) {
    const answer = entry as Record<string, unknown>;
    const questionId = String(answer?.questionId ?? "").trim();
    const text = String(answer?.answer ?? "").trim();
    if (!questionId || questionId.length > 200 || !text || text.length > 2000) return null;
    answers.push({ questionId, answer: text });
  }
  return answers;
}

function readEvidence(value: unknown): EvidenceClaimInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  const claims: EvidenceClaimInput[] = [];
  for (const entry of value) {
    const claim = entry as Record<string, unknown>;
    const uri = String(claim?.uri ?? "").trim();
    const description = String(claim?.description ?? "").trim();
    if (!EVIDENCE_KINDS.includes(String(claim?.kind)) || !uri || uri.length > 500 || !description || description.length > 500) return null;
    claims.push({ kind: claim.kind as EvidenceClaimInput["kind"], uri, description });
  }
  return claims;
}

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
    else if (body.action === "archive") result = archiveWorkOrder(ctx, id, reason);
    else if (body.action === "pause") result = pauseWorkOrderExecution(ctx, id, reason);
    else if (body.action === "resume") result = resumeWorkOrderExecution(ctx, id);
    else if (body.action === "complete") {
      const evidence = readEvidence(body.evidence);
      if (!evidence) return Response.json({ ok: false, code: "INVALID_EVIDENCE_CLAIM" }, { status: 400 });
      const checklistAnswers = readChecklistAnswers(body.checklistAnswers);
      if (!checklistAnswers) return Response.json({ ok: false, code: "INVALID_CHECKLIST_ANSWER" }, { status: 400 });
      const minutes = Number(body.reportedMinutes);
      const report = Number.isInteger(minutes) && minutes > 0 && minutes <= 1440
        ? { minutes, source: body.reportedSource === "activity" ? "activity" as const : "one_tap" as const } : undefined;
      result = completeWorkOrderExecution(ctx, id, evidence, checklistAnswers, undefined, report);
    } else return Response.json({ ok: false, code: "EXECUTION_ACTION_NOT_ALLOWED" }, { status: 400 });
  } catch (error) {
    // A store-level guard is still a known failure, so it stays a typed blocker rather than a 500.
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "EXECUTION_FAILED";
    return Response.json({ ok: false, code }, { status: 409 });
  }

  if (result.ok) return Response.json(result);
  const status = result.code === "WORK_ORDER_NOT_FOUND" ? 404
    : result.code === "INTERRUPTION_REASON_REQUIRED" || result.code === "ARCHIVE_REASON_REQUIRED" ? 400 : 409;
  return Response.json(result, { status });
}
