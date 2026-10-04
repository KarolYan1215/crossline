import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/**
 * A follow-up turn on a thread `POST /api/milestones/propose` already opened — the conversational path,
 * not a fresh proposal. Held open the same way the first call is: the Skill takes real time, and the
 * person is actively watching this one (they just sent a message), so there is no async fire-and-poll
 * shape to fall back to here.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const input = (body ?? {}) as { threadId?: unknown; message?: unknown };
  const threadId = typeof input.threadId === "string" ? input.threadId : "";
  const message = typeof input.message === "string" ? input.message.slice(0, 2000) : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId) || !message.trim()) {
    return NextResponse.json({ ok: false, blocker: { code: "PROPOSAL_CONVERSATION_INVALID", message: "缺少 threadId 或消息内容" } }, { status: 400 });
  }
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/milestones/propose/continue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, message }),
      signal: AbortSignal.timeout(6 * 60 * 60_000)
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    }
    return NextResponse.json({ ok: false, blocker: { code: "PROPOSAL_FAILED", message: "对话未完成。" } }, { status: 503 });
  }
}
