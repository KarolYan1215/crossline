import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

/**
 * Signing in the account that holds the Crossline calendar (User.Read, Calendars.ReadWrite), by device code: POST asks the worker for a
 * code, GET reads whether the person has signed in with it. The page shows the code and Microsoft's address; the person signs in there.
 */
async function forward(request: Request, method: "GET" | "POST") {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const result = await requestCodexSupervisor<Record<string, unknown>>(access.ctx, "/v1/calendar/write-login", {
      method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}), signal: AbortSignal.timeout(60_000) });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return Response.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status });
    return Response.json({ ok: false, code: "CALENDAR_LOGIN_UNAVAILABLE" }, { status: 503 });
  }
}

export async function GET(request: Request) { return forward(request, "GET"); }

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  return forward(request, "POST");
}
