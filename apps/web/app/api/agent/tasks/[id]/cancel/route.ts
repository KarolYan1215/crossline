import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../../../lib/codex-runtime";
import { validId, writeGuard } from "../../../guard";

/** 「中止」: stops a running assistant task; it is recorded as stopped by the person and not started again by itself. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  try {
    const result = await requestCodexSupervisor<{ ok: boolean; code?: string }>(guard.ctx, `/v1/agent/tasks/${id}/cancel`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
    return Response.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ ok: false, code: error.blocker.code }, { status: error.status });
    return Response.json({ ok: false, code: "AGENT_CANCEL_UNAVAILABLE" }, { status: 503 });
  }
}
