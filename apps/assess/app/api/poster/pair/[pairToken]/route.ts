import { baseUrl } from "../../../../../server/config";
import { avatarImagePath } from "../../../../../server/avatar";
import { renderPairCard } from "../../../../../server/poster";
import { pngResponse, posterNotFound } from "../../../../../server/poster/http";
import { getPairByToken, getResultById, recordedScores } from "../../../../../server/store";
import { pairRelation, publicType } from "../../../../../lib/public-type";

/**
 * GET /api/poster/pair/<pairToken> — the two people's card as a PNG. Its QR code is the inviter's invitation, so the card keeps
 * spreading the way the poster does. Gone when either result is gone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ pairToken: string }> }): Promise<Response> {
  const { pairToken } = await context.params;
  const pair = getPairByToken(pairToken);
  const inviter = pair ? getResultById(pair.inviterId) : undefined;
  const invitee = pair ? getResultById(pair.inviteeId) : undefined;
  const now = Date.now();
  if (!inviter || !invitee || Date.parse(inviter.expiresAt) <= now || Date.parse(invitee.expiresAt) <= now) return posterNotFound();
  const recorded = recordedScores();
  const a = publicType(inviter.scores, recorded);
  const b = publicType(invitee.scores, recorded);
  const png = await renderPairCard({
    a: { type: a, nickname: inviter.nickname, avatarPath: avatarImagePath(inviter) },
    b: { type: b, nickname: invitee.nickname, avatarPath: avatarImagePath(invitee) },
    ...pairRelation(a.code, b.code),
    inviteUrl: `${baseUrl()}/t/${inviter.inviteToken}`
  });
  return pngResponse(png);
}
