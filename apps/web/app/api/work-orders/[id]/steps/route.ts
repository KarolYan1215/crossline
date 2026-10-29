import { chooseOwnerOfStep, confirmCriterion, editSteps, loadStepPlan, noteResumePoint, recordStepProgress, reportProgress, requestStepReplan, settleProvideStep } from "../../../../../lib/steps";
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
 * - `{action: "confirm_criterion", criterionId}`: a standard met with nothing to hand in;
 * - `{action: "owner", stepId, owner: "person" | "assistant"}`: who does the step, kept for that kind of step on the line;
 * - `{action: "provide_none", stepId}`: the material a provide step asks for does not exist (files go to `steps/provide`);
 * - `{action: "resume_note", stepId, text}`: where to pick the step up again, which becomes its first action.
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
    case "owner": return typeof body.stepId === "string" && (body.owner === "person" || body.owner === "assistant")
      ? respond(chooseOwnerOfStep(guard.ctx, id, body.stepId, body.owner)) : respond({ ok: false, code: "STEP_INVALID" });
    case "provide_none": return typeof body.stepId === "string" ? respond(settleProvideStep(guard.ctx, id, body.stepId, "none")) : respond({ ok: false, code: "STEP_INVALID" });
    case "resume_note": return typeof body.stepId === "string" ? respond(noteResumePoint(guard.ctx, id, body.stepId, String(body.text ?? ""))) : respond({ ok: false, code: "STEP_INVALID" });
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
