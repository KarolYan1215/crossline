import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

/**
 * Pulls the calendar now instead of at the next tick.
 *
 * It is a read — `GraphReadSource` structurally cannot write — but it goes through the worker, because
 * the worker owns the token and the sync cursor. Fifteen minutes is the tick; that is too long to sit
 * in front of the plan wondering whether the change landed, and far too long to test the conflict path.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const result = await requestCodexSupervisor<Record<string, unknown>>(access.ctx, "/v1/calendar/sync", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(60_000)
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return Response.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status });
    }
    return Response.json({ ok: false, code: "CALENDAR_SYNC_UNAVAILABLE" }, { status: 503 });
  }
}
