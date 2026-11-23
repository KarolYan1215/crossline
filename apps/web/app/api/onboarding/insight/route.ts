import { NextResponse } from "next/server";
import { markInsightNovel, rateInsight } from "@crossline/db";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { getStore } from "../../../../lib/crossline";

/**
 * The person's 准 / 不准 on an observation of the deep stages (2026-10-19). Kept per round; the next round and the extraction are told,
 * and 「准」 in each deep stage confirms the portrait piece by piece. Rating it again replaces the earlier rating; `clear` (the receipt's 撤销,
 * 2026-11-10) takes it back, so the card asks again.
 *
 * Under the points rules (2026-11-12) a card is one hypothesis of the log: 「准」 makes it a point the person confirmed, 「不准」 refutes
 * it, and 「部分对」 (`partial`, with `correction` in their words) keeps it open and records the correction as a point (`rateInsight`).
 *
 * A body with `novel` instead of `verdict` (2026-11-22) answers the card's second question, whether the person had thought of it
 * before: `new`, `known`, or null to take it back (`markInsightNovel`). It needs the card rated first.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: { sessionId?: unknown; seq?: unknown; index?: unknown; verdict?: unknown; correction?: unknown; novel?: unknown } = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const seq = typeof body.seq === "number" && Number.isInteger(body.seq) ? body.seq : -1;
  // Which of the round's cards (2026-11-14): 0 the first, 1 and 2 the ones shown after it.
  const index = body.index === undefined ? 0 : typeof body.index === "number" && Number.isInteger(body.index) && body.index >= 0 && body.index < 3 ? body.index : -1;
  if ("novel" in body && body.verdict === undefined) {
    const novel = body.novel === "new" || body.novel === "known" ? body.novel : body.novel === null ? null : undefined;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || seq < 0 || index < 0 || novel === undefined) return NextResponse.json({ ok: false, code: "INSIGHT_RATING_INVALID" }, { status: 400 });
    const marked = markInsightNovel(getStore(), access.ctx.workspaceId, { sessionId, seq, index, novel });
    return marked.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, code: marked.code }, { status: 409 });
  }
  const verdict = body.verdict === "fits" || body.verdict === "off" || body.verdict === "partial" || body.verdict === "clear" ? body.verdict : undefined;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || seq < 0 || index < 0 || !verdict) return NextResponse.json({ ok: false, code: "INSIGHT_RATING_INVALID" }, { status: 400 });
  const store = getStore();
  const { workspaceId } = access.ctx;
  const result = rateInsight(store, workspaceId, { sessionId, seq, index, verdict, ...(typeof body.correction === "string" ? { correction: body.correction } : {}) });
  if (!result.ok) return NextResponse.json({ ok: false, code: result.code }, { status: result.code === "INSIGHT_NOT_FOUND" ? 404 : 400 });
  const stage = String((store.listOnboardingMessages(workspaceId, sessionId).find((message) => message.seq === seq)?.content as { stage?: string } | undefined)?.stage ?? "");
  store.appendEvent({ ownerId: access.ctx.principalId, workspaceId, idempotencyKey: `onboarding:insight:${sessionId}:${seq}:${verdict}:${Date.now()}`,
    type: "onboarding.insight_rated", entityId: sessionId, payload: { seq, ...(index ? { index } : {}), verdict, stage, ...(result.hypothesisId ? { hypothesisId: result.hypothesisId } : {}) } });
  return NextResponse.json({ ok: true });
}
