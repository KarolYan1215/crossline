import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { startReadiness } from "../../../../lib/start-gate";
import { tOf } from "../../../../lib/locale";

/**
 * The person's 「结束并出报告」 (the owner's decision of 2026-11-12): the only way the main interview ends. Refused below the lower bound —
 * the start standard — with what it still lacks; above it the worker ends the interview and writes the report in the background.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { sessionId?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return NextResponse.json({ ok: false, code: "ONBOARDING_TURN_INVALID" }, { status: 400 });
  const readiness = startReadiness(access.ctx);
  if (!readiness.standard) return NextResponse.json({ ok: false, code: "INTERVIEW_BELOW_LOWER_BOUND",
    message: tOf(access.ctx)("开始使用所需的几项还没齐，先答完再结束。"), missing: readiness.missing.map((item) => item.label) }, { status: 409 });
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/onboarding/finish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }), signal: AbortSignal.timeout(60_000) });
    return NextResponse.json({ ok: (result as { state?: string }).state === "finished", ...(result as object) });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return NextResponse.json({ ok: false, code: "ONBOARDING_FINISH_FAILED", message: tOf(access.ctx)("没能结束访谈，可以重试。") }, { status: 503 });
  }
}
