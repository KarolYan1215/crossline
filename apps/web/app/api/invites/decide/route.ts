import { decideFromLink } from "../../../../lib/invites";
import { tFor } from "../../../../lib/i18n";
import { getLocale } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export const runtime = "nodejs";

const MESSAGES: Record<string, string> = {
  INVITE_LINK_INVALID: "链接无效或已过期。",
  INVITE_NOT_FOUND: "这份申请已不存在（申请人可能删除了账号）。",
  INVITE_ALREADY_DECIDED: "这份申请已经处理过。"
};

/**
 * `{token, decision}` from the decision page. The signed token is the authority (the owner may decide from a phone without signing in);
 * the same-origin check still applies, so only the page itself can post it.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { token?: unknown; decision?: unknown };
  if (typeof body.token !== "string" || body.token.length > 400 || (body.decision !== "approve" && body.decision !== "reject"))
    return Response.json({ ok: false, code: "INVITE_DECISION_INVALID" }, { status: 400 });
  const result = await decideFromLink(body.token, body.decision);
  if (!result.ok) return Response.json({ ok: false, code: result.code, message: MESSAGES[result.code] ? tFor(await getLocale())(MESSAGES[result.code]!) : undefined }, { status: result.code === "INVITE_ALREADY_DECIDED" ? 409 : 400 });
  return Response.json(result);
}
