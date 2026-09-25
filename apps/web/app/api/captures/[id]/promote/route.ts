import { getStore, promoteCaptureManually } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "PROMOTE_REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !getStore().listCaptures(ctx.workspaceId).some((item) => item.id === id && item.ownerId === ctx.principalId)) {
    return Response.json({ ok: false, code: "CAPTURE_NOT_FOUND" }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = promoteCaptureManually(ctx, id, {
    identityId: body.identityId, intent: body.intent, milestoneId: body.milestoneId,
    family: body.family, estimate: body.estimate, evidenceContract: body.evidenceContract
  });
  if (result.ok) return Response.json(result);
  const status = result.code === "CAPTURE_NOT_FOUND" ? 404 : 400;
  return Response.json(result, { status });
}
