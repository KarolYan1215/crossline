import { NextResponse } from "next/server";
import { addCapturedTaskWithId } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { analyzeNewCapturesInBackground, extractBackgroundFactsInBackground } from "../../../../lib/capture-followups";

/**
 * The 「收集」 button on a card the 问答 assistant offered: the person's click is what writes the capture,
 * through the same `addCapturedTaskWithId` and the same follow-ups 快速收集 uses. `cardId` is the client's
 * id for the card, so a double click captures once.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { cardId?: unknown; title?: unknown; context?: unknown } | null;
  const cardId = typeof body?.cardId === "string" ? body.cardId : "";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const context = typeof body?.context === "string" ? body.context.trim() : "";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(cardId) || !title || title.length > 240 || context.length > 500) {
    return NextResponse.json({ ok: false, code: "INVALID_TASK_INPUT" }, { status: 400 });
  }
  const id = `assistant-${cardId}`;
  addCapturedTaskWithId(access.ctx, { title, context }, id, id);
  extractBackgroundFactsInBackground(access.ctx, title, context);
  analyzeNewCapturesInBackground(access.ctx);
  return NextResponse.json({ ok: true, captureId: id });
}
