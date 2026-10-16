import { baseUrl } from "../../../../../server/config";
import { drawnImagePath } from "../../../../../server/avatar";
import { renderLongImage, renderTypePoster } from "../../../../../server/poster";
import { pngResponse, posterLocale, posterNotFound } from "../../../../../server/poster/http";
import { getResultByInvite, recordedScores } from "../../../../../server/store";
import { typeOf } from "../../../../../server/views";

/**
 * GET /api/poster/<inviteToken>/type.png | long.png — a result's poster, drawn on the server so it can be shown as an <img> a long
 * press saves in WeChat. Keyed by the invitation token, which the poster already prints as its QR code; never the result token. Drawn in
 * the reader's language (`?l=`, else their cookie), each language cached apart.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = { "type.png": renderTypePoster, "long.png": renderLongImage } as const;

export async function GET(request: Request, context: { params: Promise<{ token: string; kind: string }> }): Promise<Response> {
  const { token, kind } = await context.params;
  const render = Object.hasOwn(KINDS, kind) ? KINDS[kind as keyof typeof KINDS] : undefined;
  const result = render ? getResultByInvite(token) : undefined;
  if (!render || !result || Date.parse(result.expiresAt) <= Date.now()) return posterNotFound();
  const locale = posterLocale(request);
  const png = await render({
    type: typeOf(result, recordedScores(), locale),
    nickname: result.nickname,
    avatarPath: drawnImagePath(result) ?? "",
    inviteUrl: `${baseUrl()}/t/${result.inviteToken}`,
    cacheTag: result.inviteToken,
    locale
  });
  return pngResponse(png);
}
