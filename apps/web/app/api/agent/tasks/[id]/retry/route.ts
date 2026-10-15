import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../../../lib/codex-runtime";
import { validId, writeGuard } from "../../../guard";

/**
 * 「按我的说明重做」: runs an assistant task again. `note` is the person's own words for the next run; `only` names the checks or unfinished
 * items to redo. The worker records them and starts the run now when the assistant is free, not paused and the quota allows — otherwise
 * it says the run is queued and a later pass starts it under the same rules.
 */
/** The page probes for the route before showing 「重做」: it exists. Writes nothing. */
export function HEAD() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const { note, only } = guard.body;
  if ((note !== undefined && typeof note !== "string") || (only !== undefined && (!Array.isArray(only) || only.some((item) => typeof item !== "string"))))
    return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  if ((typeof note === "string" && note.length > 4000) || (Array.isArray(only) && (only.length > 20 || only.some((item: string) => item.length > 300))))
    return Response.json({ ok: false, code: "REQUEST_TOO_LONG" }, { status: 400 });
  try {
    const result = await requestCodexSupervisor<{ ok: boolean; code?: string; state?: string; message?: string }>(guard.ctx, `/v1/agent/tasks/${id}/retry`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}), ...(Array.isArray(only) && only.length ? { only } : {}) }),
      signal: AbortSignal.timeout(15_000) });
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ ok: false, code: error.blocker.code }, { status: error.status });
    return Response.json({ ok: false, code: "AGENT_RETRY_UNAVAILABLE" }, { status: 503 });
  }
}
