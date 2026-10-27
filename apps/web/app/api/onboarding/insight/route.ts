import { NextResponse } from "next/server";
import { ONBOARDING_INSIGHTS, readInsightRatings } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { getStore } from "../../../../lib/crossline";

/**
 * The person's 准 / 不准 on an observation of the deep stages (2026-10-19). Kept per round; the next round and the extraction are told,
 * and 「准」 in each deep stage confirms the portrait piece by piece. Rating it again replaces the earlier rating.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: { sessionId?: unknown; seq?: unknown; verdict?: unknown } = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const seq = typeof body.seq === "number" && Number.isInteger(body.seq) ? body.seq : -1;
  const verdict = body.verdict === "fits" || body.verdict === "off" ? body.verdict : undefined;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || seq < 0 || !verdict) return NextResponse.json({ ok: false, code: "INSIGHT_RATING_INVALID" }, { status: 400 });
  const store = getStore();
  const { workspaceId } = access.ctx;
  const round = store.listOnboardingMessages(workspaceId, sessionId).find((message) => message.seq === seq && message.role === "assistant");
  const insight = (round?.content as { insight?: { text?: string }; stage?: string } | undefined);
  if (!insight?.insight?.text) return NextResponse.json({ ok: false, code: "INSIGHT_NOT_FOUND" }, { status: 404 });
  const ratings = readInsightRatings(store.getSetting(workspaceId, ONBOARDING_INSIGHTS));
  ratings[`${sessionId}#${seq}`] = { verdict, stage: insight.stage ?? "", at: new Date().toISOString(), text: insight.insight.text.slice(0, 300) };
  store.setSetting(workspaceId, ONBOARDING_INSIGHTS, JSON.stringify(ratings));
  store.appendEvent({ ownerId: access.ctx.principalId, workspaceId, idempotencyKey: `onboarding:insight:${sessionId}:${seq}:${verdict}:${Date.now()}`,
    type: "onboarding.insight_rated", entityId: sessionId, payload: { seq, verdict, stage: insight.stage ?? "" } });
  return NextResponse.json({ ok: true });
}
