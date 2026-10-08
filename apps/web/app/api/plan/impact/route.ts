import { validateAvailability } from "@crossline/core";
import { normalizeParams } from "@crossline/planner";
import { applyChange, previewChange, type Change } from "../../../../lib/impact";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const parse = (value: unknown): Change | undefined => {
  const body = value as Partial<Record<string, unknown>> | undefined;
  if (body?.kind === "availability") {
    try { return { kind: "availability", windows: validateAvailability(body.windows), ...(typeof body.timeZone === "string" ? { timeZone: body.timeZone } : {}) }; }
    catch { return undefined; }
  }
  if (body?.kind === "params") return { kind: "params", params: normalizeParams(body.params) };
  if (body?.kind === "weight" && typeof body.milestoneId === "string" && typeof body.weight === "number" && Number.isFinite(body.weight))
    return { kind: "weight", milestoneId: body.milestoneId, weight: Math.max(0, Math.min(100, Math.round(body.weight))) };
  if (typeof body?.workOrderId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.workOrderId)) return undefined;
  if (body.kind === "estimate" && typeof body.p50Minutes === "number")
    return { kind: "estimate", workOrderId: body.workOrderId, p50Minutes: body.p50Minutes, ...(typeof body.stepId === "string" ? { stepId: body.stepId } : {}) };
  if (body.kind === "estimate_delta" && typeof body.deltaMinutes === "number")
    return { kind: "estimate_delta", workOrderId: body.workOrderId, deltaMinutes: body.deltaMinutes, ...(typeof body.stepId === "string" ? { stepId: body.stepId } : {}) };
  if (body.kind === "due" && typeof body.date === "string") return { kind: "due", workOrderId: body.workOrderId, date: body.date };
  if (body.kind === "defer" && typeof body.date === "string") return { kind: "defer", workOrderId: body.workOrderId, date: body.date };
  return undefined;
};

/** `{change, apply}`: without `apply`, what the change would do across the lines; with it, the change made. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { change?: unknown; apply?: unknown };
  const change = parse(body.change);
  if (!change) return Response.json({ ok: false, code: "CHANGE_INVALID" }, { status: 400 });
  if (body.apply === true) {
    const result = applyChange(access.ctx, change);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  }
  try {
    return Response.json({ ok: true, impact: await previewChange(access.ctx, change) });
  } catch (error) {
    return Response.json({ ok: false, code: error instanceof Error ? error.message : "PREVIEW_FAILED" }, { status: 404 });
  }
}
