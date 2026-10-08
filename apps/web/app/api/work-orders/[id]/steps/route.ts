import { loadStepPlan, recordStepProgress, requestStepReplan } from "../../../../../lib/steps";
import { rejectUnsafeRequest } from "../guard";
import { resolveAccessContext } from "../../../../../lib/access-guard";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, plan: loadStepPlan(access.ctx, id) ?? null });
}

/** `{action: "replan", feedback}` or `{action: "progress", stepId, progressQuarter? , status?}`. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const body = (await request.json().catch(() => ({}))) as { action?: string; feedback?: unknown; stepId?: unknown; progressQuarter?: unknown; status?: unknown };
  if (body.action === "replan") {
    const result = requestStepReplan(guard.ctx, id, String(body.feedback ?? ""));
    return Response.json(result, { status: result.ok ? 200 : 404 });
  }
  if (body.action === "progress" && typeof body.stepId === "string") {
    const status = ["planned", "done", "skipped"].includes(String(body.status)) ? body.status as "planned" | "done" | "skipped" : undefined;
    const quarter = typeof body.progressQuarter === "number" ? body.progressQuarter : undefined;
    const result = recordStepProgress(guard.ctx, id, body.stepId, { ...(status ? { status } : {}), ...(quarter !== undefined ? { progressQuarter: quarter } : {}) });
    return Response.json(result, { status: result.ok ? 200 : result.code === "STEP_NOT_FOUND" ? 404 : 400 });
  }
  return Response.json({ ok: false, code: "STEP_ACTION_INVALID" }, { status: 400 });
}
