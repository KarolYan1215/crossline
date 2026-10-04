import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The one route for every turn of the site-wide floating assistant, first or follow-up — see
 * `apps/worker/src/assistant-runner.ts`'s own doc comment for why this isn't split into onboarding's
 * two-route open/continue shape (a stable, client-generated `threadId` has to exist before the first
 * message, so attachments can be uploaded ahead of it).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: unknown = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const input = (body ?? {}) as {
    threadId?: unknown; message?: unknown;
    history?: unknown; attachments?: unknown; workOrderId?: unknown;
  };
  const threadId = typeof input.threadId === "string" ? input.threadId : "";
  const message = typeof input.message === "string" ? input.message.slice(0, 4000) : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId) || !message.trim()) {
    return NextResponse.json({ ok: false, blocker: { code: "ASSISTANT_TURN_INVALID", message: "缺少 threadId 或消息内容" } }, { status: 400 });
  }
  const history = Array.isArray(input.history) ? input.history
    .filter((item): item is { from: unknown; text: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({ from: item.from === "assistant" ? "assistant" as const : "user" as const, text: String(item.text ?? "").slice(0, 4000) }))
    .slice(-20) : [];
  const attachments = Array.isArray(input.attachments) ? input.attachments
    .filter((item): item is { id: unknown; fileName: unknown; mediaType: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({ id: String(item.id ?? ""), fileName: String(item.fileName ?? "").slice(0, 200), mediaType: String(item.mediaType ?? "") })) : [];
  const workOrderId = typeof input.workOrderId === "string" ? input.workOrderId : null;
  try {
    const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/assistant/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId, message, history, attachments, workOrderId }),
      signal: AbortSignal.timeout(3 * 60 * 60_000)
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
    }
    return NextResponse.json({ ok: false, blocker: { code: "ASSISTANT_TURN_FAILED", message: "对话未完成。" } }, { status: 503 });
  }
}
