import { baseUrl } from "../../../../../server/config";
import { drawnImagePath } from "../../../../../server/avatar";
import { renderPairCard } from "../../../../../server/poster";
import { pngResponse, posterLocale, posterNotFound } from "../../../../../server/poster/http";
import { getPairByToken, getResultById, recordedScores } from "../../../../../server/store";
import { pairRelation } from "../../../../../lib/public-type";
import { typeOf } from "../../../../../server/views";

/**
 * GET /api/poster/pair/<pairToken>.png (the `.png` optional) — the two people's card as a PNG. Its QR code is the inviter's invitation, so the card keeps
 * spreading the way the poster does. Gone when either result is gone. In the reader's language, like the poster.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ pairToken: string }> }): Promise<Response> {
  const pairToken = (await context.params).pairToken.replace(/\.png$/, "");
  const pair = getPairByToken(pairToken);
  const inviter = pair ? getResultById(pair.inviterId) : undefined;
  const invitee = pair ? getResultById(pair.inviteeId) : undefined;
  const now = Date.now();
  if (!inviter || !invitee || Date.parse(inviter.expiresAt) <= now || Date.parse(invitee.expiresAt) <= now) return posterNotFound();
  const recorded = recordedScores();
  const locale = posterLocale(request);
  const a = typeOf(inviter, recorded, locale);
  const b = typeOf(invitee, recorded, locale);
  const png = await renderPairCard({
    a: { type: a, nickname: inviter.nickname, avatarPath: drawnImagePath(inviter) ?? "" },
    b: { type: b, nickname: invitee.nickname, avatarPath: drawnImagePath(invitee) ?? "" },
    ...pairRelation(a.code, b.code, a.lines, b.lines, locale),
    inviteUrl: `${baseUrl()}/t/${inviter.inviteToken}`,
    cacheTag: pairToken,
    locale
  });
  return pngResponse(png);
}
