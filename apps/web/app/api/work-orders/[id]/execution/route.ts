import type { EvidenceClaimInput } from "@crossline/db";
import {
  archiveWorkOrder, completeWorkOrderExecution, markMaterialsReady, pauseWorkOrderExecution,
  resumeWorkOrderExecution, retryMaterialPreparation, startWorkOrderExecution,
  type ExecutionResult
} from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";
import { requestCodexSupervisor } from "../../../../../lib/codex-runtime";

const EVIDENCE_KINDS = ["file", "link", "record", "telemetry"];

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
      result = completeWorkOrderExecution(ctx, id, evidence);
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
