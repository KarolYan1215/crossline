import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";

/**
 * Whether Google / Outlook calendar is connected in this account's Codex (ChatGPT connectors), and where to connect each.
 * A read through the worker, which owns the runtime; it runs no model turn.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const result = await requestCodexSupervisor<{ apps: unknown[] }>(access.ctx, "/v1/apps/calendar", {
      method: "GET", signal: AbortSignal.timeout(30_000)
    });
    return Response.json({ ok: true, apps: result.apps });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return Response.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status });
    }
    return Response.json({ ok: false, code: "APPS_UNAVAILABLE" }, { status: 503 });
  }
}
