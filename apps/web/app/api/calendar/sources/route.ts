import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Which calendars the reality lane is read from.
 *
 * Through the worker, like the sync itself, because the worker owns the Graph tokens. Listing is a
 * read; saving only writes one settings row in the ledger and changes what the next tick pulls.
 */
const relay = async (init: RequestInit) => {
  try {
    const result = await requestCodexSupervisor<unknown>("/v1/calendar/sources", {
      ...init, signal: AbortSignal.timeout(30_000)
    });
    return Response.json({ ok: true, accounts: result });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return Response.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status });
    }
    return Response.json({ ok: false, code: "CALENDAR_SOURCES_UNAVAILABLE" }, { status: 503 });
  }
};

export async function GET() {
  return relay({ method: "GET" });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === "string") : [];
  return relay({
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys })
  });
}
