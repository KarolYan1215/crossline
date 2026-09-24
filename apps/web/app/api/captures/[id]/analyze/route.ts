import { getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

type Context = { params: Promise<{ id: string }> };
async function forward(request: Request, context: Context, method: "POST" | "DELETE") {
  const { id } = await context.params;
  if (isCrossSiteWrite(request)) return Response.json({ blocker: { code: "ANALYSIS_REQUEST_FORBIDDEN" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !getStore().listCaptures(ctx.workspaceId).some((item) => item.id === id && item.ownerId === ctx.principalId)) {
    return Response.json({ blocker: { code: "CAPTURE_NOT_FOUND" } }, { status: 404 });
  }
  try {
    const result = await requestCodexSupervisor<{ state?: unknown; canceled?: unknown }>(ctx, `/v1/captures/${id}/analyze`, {
      method, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(40_000)
    });
    if (method === "DELETE" && typeof result.canceled === "boolean") return Response.json({ canceled: result.canceled });
    if (typeof result.state !== "string" || !["captured", "analyzing", "awaiting_plan_approval", "blocked"].includes(result.state)) {
      return Response.json({ blocker: { code: "ANALYSIS_PROTOCOL_INVALID" } }, { status: 502 });
    }
    // The UI reloads validated database facts; model/RPC payloads never pass through.
    return Response.json({ state: result.state });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ blocker: error.blocker }, { status: error.status });
    return Response.json({ blocker: { code: "ANALYSIS_RUNTIME_FAILED" } }, { status: 503 });
  }
}
export const POST = (request: Request, context: Context) => forward(request, context, "POST");
export const DELETE = (request: Request, context: Context) => forward(request, context, "DELETE");
