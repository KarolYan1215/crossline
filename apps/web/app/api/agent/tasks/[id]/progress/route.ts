import { resolveAccessContext } from "../../../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../../../lib/codex-runtime";
import { validId } from "../../../guard";

/** A running assistant task's progress so far (docs/review-2026-10-13.md §6.4): the page polls it while the run goes on. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  try {
    const result = await requestCodexSupervisor<{ progress: unknown }>(access.ctx, `/v1/agent/tasks/${id}/progress`, { method: "GET", signal: AbortSignal.timeout(10_000) });
    return Response.json({ ok: true, progress: result.progress });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ ok: false, code: error.blocker.code }, { status: error.status });
    return Response.json({ ok: false, code: "AGENT_PROGRESS_UNAVAILABLE" }, { status: 503 });
  }
}
