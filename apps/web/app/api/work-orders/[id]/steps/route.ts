import { confirmCriterion, editSteps, loadStepPlan, recordStepProgress, reportProgress, requestStepReplan } from "../../../../../lib/steps";
import { rejectUnsafeRequest } from "../guard";
import { resolveAccessContext } from "../../../../../lib/access-guard";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, plan: loadStepPlan(access.ctx, id) ?? null });
}

/**
 * One endpoint for everything the task dialog does to the steps:
 * - `{action: "replan", feedback}`: plan again with what to change, in the person's words;
 * - `{action: "edit", steps: [{id?, title}]}`: the person's own reorder/add/remove;
 * - `{action: "progress", stepId, progressQuarter?, status?}`: one step's reading;
 * - `{action: "report", text}`: a progress report for the judge;
 * - `{action: "confirm_criterion", criterionId}`: a standard met with nothing to hand in.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const respond = (result: { ok: boolean; code?: string }) => Response.json(result, { status: result.ok ? 200 : result.code?.endsWith("NOT_FOUND") ? 404 : 400 });
  switch (body.action) {
    case "replan": return respond(requestStepReplan(guard.ctx, id, String(body.feedback ?? "")));
    case "report": return respond(reportProgress(guard.ctx, id, String(body.text ?? "")));
    case "confirm_criterion": return typeof body.criterionId === "string" ? respond(confirmCriterion(guard.ctx, id, body.criterionId)) : respond({ ok: false, code: "CRITERION_INVALID" });
    case "edit": {
      const steps = Array.isArray(body.steps) ? (body.steps as Array<{ id?: unknown; title?: unknown }>).map((item) => ({
        ...(typeof item.id === "string" ? { id: item.id } : {}), title: String(item.title ?? "") })) : [];
      return respond(editSteps(guard.ctx, id, steps));
    }
    case "progress": {
      if (typeof body.stepId !== "string") return respond({ ok: false, code: "STEP_INVALID" });
      const status = ["planned", "done", "skipped"].includes(String(body.status)) ? body.status as "planned" | "done" | "skipped" : undefined;
      const quarter = typeof body.progressQuarter === "number" ? body.progressQuarter : undefined;
      return respond(recordStepProgress(guard.ctx, id, body.stepId, { ...(status ? { status } : {}), ...(quarter !== undefined ? { progressQuarter: quarter } : {}) }));
    }
    default: return respond({ ok: false, code: "STEP_ACTION_INVALID" });
  }
}
