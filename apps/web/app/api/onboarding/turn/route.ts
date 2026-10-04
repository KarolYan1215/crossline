import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * One turn of the profile interview. The conversation lives in the ledger (keyed by `sessionId`), so the
 * browser sends only the session id and what the person just said; reloading the page loses nothing.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const input = (body ?? {}) as { sessionId?: unknown; text?: unknown; reread?: unknown };
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const text = typeof input.text === "string" ? input.text.slice(0, 4000) : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return NextResponse.json({ ok: false, blocker: { code: "ONBOARDING_TURN_INVALID", message: "缺少会话 id" } }, { status: 400 });
  }
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/onboarding/turn", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, text, reread: input.reread === true }),
      signal: AbortSignal.timeout(3 * 60 * 60_000)
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return NextResponse.json({ ok: false, blocker: { code: "ONBOARDING_FAILED", message: "这一轮没有完成，可以重试。" } }, { status: 503 });
  }
}
