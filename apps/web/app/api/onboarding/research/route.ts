import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { readResearchThreads } from "../../../../lib/interview-research";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { tOf } from "../../../../lib/locale";

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return NextResponse.json({ ok: false, code: "ONBOARDING_TURN_INVALID" }, { status: 400 });
  return NextResponse.json({ ok: true, research: readResearchThreads(access.ctx.workspaceId, sessionId) });
}

/** The person's answer to a thread's question, or their own follow-up in it: goes to that thread, never through the main conversation. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { sessionId?: unknown; threadId?: unknown; text?: unknown } | null;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  const threadId = typeof body?.threadId === "string" ? body.threadId : "";
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(threadId)) return NextResponse.json({ ok: false, code: "ONBOARDING_TURN_INVALID" }, { status: 400 });
  if (!text) return NextResponse.json({ ok: false, code: "RESEARCH_MESSAGE_EMPTY", message: tOf(access.ctx)("请先写点什么。") }, { status: 400 });
  if (text.length > 12_000) return NextResponse.json({ ok: false, code: "ONBOARDING_REPLY_TOO_LONG", message: tOf(access.ctx)("这段话太长了，分几次说。") }, { status: 400 });
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/onboarding/research", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, threadId, text }), signal: AbortSignal.timeout(60_000) });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    return NextResponse.json({ ok: false, code: "RESEARCH_FAILED", message: tOf(access.ctx)("没有送到，可以重试。") }, { status: 503 });
  }
}
