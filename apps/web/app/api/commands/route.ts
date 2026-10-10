import { validateCommandEnvelope } from "@crossline/core";
import {
  addCapturedTaskWithId, completeWorkOrderExecution, pauseWorkOrderExecution,
  resumeWorkOrderExecution, startWorkOrderExecution, type ExecutionResult
} from "../../../lib/crossline";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { analyzeNewCapturesInBackground, extractBackgroundFactsInBackground } from "../../../lib/capture-followups";
import { replayTime } from "../../../lib/replay-time";
import { readChecklistAnswers, readEvidence, readReport } from "../../../lib/execution-input";

// A queued command can be replayed long after it was written — another device, or the web UI itself,
// may have already moved the same work order on by the time this one reaches the server. Every one of
// these functions already refuses to blindly apply an action the work order's current state cannot
// support (`EXECUTION_NOT_ACTIVE`, `NO_ACTIVE_EXECUTION`, …) rather than corrupting it; the status
// mapping below is what turns that typed refusal into the same 409 the online execution route already
// uses, so the offline queue can tell "the object changed underneath this command" (→ conflicts store)
// apart from "the input itself was invalid" (→ dead letter).
const workOrderCommands: Record<string, (ctx: Parameters<typeof startWorkOrderExecution>[0], payload: Record<string, unknown>, at: string | undefined) => ExecutionResult | { ok: false; code: "INVALID_EVIDENCE_CLAIM" }> = {
  "work_order.start": (ctx, payload, at) => startWorkOrderExecution(ctx, String(payload.workOrderId ?? ""), at),
  "work_order.pause": (ctx, payload, at) => pauseWorkOrderExecution(ctx, String(payload.workOrderId ?? ""), String(payload.reason ?? ""), at),
  "work_order.resume": (ctx, payload, at) => resumeWorkOrderExecution(ctx, String(payload.workOrderId ?? ""), at),
  "work_order.complete": (ctx, payload, at) => {
    const evidence = readEvidence(payload.evidence);
    const checklistAnswers = readChecklistAnswers(payload.checklistAnswers);
    if (!evidence || !checklistAnswers) return { ok: false, code: "INVALID_EVIDENCE_CLAIM" };
    return completeWorkOrderExecution(ctx, String(payload.workOrderId ?? ""), evidence, checklistAnswers, at, readReport(payload));
  }
};

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const validation = validateCommandEnvelope(await request.json().catch(() => null));
  if (!validation.ok) return Response.json(validation.blocker, { status: 400 });
  const command = validation.command;
  // The envelope's ownerId/workspaceId is the client's own claim, replayed from its offline outbox —
  // it proves nothing by itself. The session `ctx` above is the actual authority; this check only
  // catches a stale queue replaying commands recorded under a different account than the one now signed in.
  if (command.ownerId !== ctx.principalId || command.workspaceId !== ctx.workspaceId) {
    return Response.json({ code: "COMMAND_SCOPE_MISMATCH" }, { status: 403 });
  }
  const payload = command.payload as Record<string, unknown>;
  if (command.type === "task.capture") {
    const title = String(payload.title ?? "").trim();
    const context = String(payload.context ?? "").trim();
    if (!title || title.length > 240 || context.length > 500) {
      return Response.json({ code: "INVALID_TASK_INPUT" }, { status: 400 });
    }
    addCapturedTaskWithId(ctx, { title, context }, command.clientCommandId, command.clientCommandId);
    extractBackgroundFactsInBackground(ctx, title, context);
    analyzeNewCapturesInBackground(ctx);
  } else if (command.type in workOrderCommands) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(String(payload.workOrderId ?? ""))) {
      return Response.json({ code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
    }
    const result = workOrderCommands[command.type]!(ctx, payload, replayTime(command.createdAt));
    if (!result.ok) {
      const status = result.code === "WORK_ORDER_NOT_FOUND" ? 404
        : result.code === "INTERRUPTION_REASON_REQUIRED" || result.code === "INVALID_EVIDENCE_CLAIM" ? 400 : 409;
      return Response.json({ code: result.code }, { status });
    }
  } else {
    return Response.json({ code: "COMMAND_TYPE_NOT_ALLOWED" }, { status: 400 });
  }
  return Response.json({ accepted: true, clientCommandId: command.clientCommandId });
}
