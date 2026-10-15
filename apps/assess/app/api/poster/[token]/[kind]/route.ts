import { baseUrl } from "../../../../../server/config";
import { avatarImagePath } from "../../../../../server/avatar";
import { renderLongImage, renderTypePoster } from "../../../../../server/poster";
import { pngResponse, posterNotFound } from "../../../../../server/poster/http";
import { getResultByInvite, recordedScores } from "../../../../../server/store";
import { publicType } from "../../../../../lib/public-type";

/**
 * GET /api/poster/<inviteToken>/type.png | long.png — a result's poster, drawn on the server so it can be shown as an <img> a long
 * press saves in WeChat. Keyed by the invitation token, which the poster already prints as its QR code; never the result token.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = { "type.png": renderTypePoster, "long.png": renderLongImage } as const;

export async function GET(_request: Request, context: { params: Promise<{ token: string; kind: string }> }): Promise<Response> {
  const { token, kind } = await context.params;
  const render = Object.hasOwn(KINDS, kind) ? KINDS[kind as keyof typeof KINDS] : undefined;
  const result = render ? getResultByInvite(token) : undefined;
  if (!render || !result || Date.parse(result.expiresAt) <= Date.now()) return posterNotFound();
  const png = await render({
    type: publicType(result.scores, recordedScores(), result.id),
    nickname: result.nickname,
    avatarPath: avatarImagePath(result),
    inviteUrl: `${baseUrl()}/t/${result.inviteToken}`,
    cacheTag: result.inviteToken
  });
  return pngResponse(png);
}
