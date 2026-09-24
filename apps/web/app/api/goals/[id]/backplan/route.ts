import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/goals/backplan", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ milestoneId: id }), signal: AbortSignal.timeout(10 * 60_000)
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError)
      return Response.json({ state: "blocked", blocker: error.blocker }, { status: error.status });
    return Response.json({ state: "blocked", code: "BACKPLAN_FAILED", message: "反推未完成。" }, { status: 503 });
  }
}
