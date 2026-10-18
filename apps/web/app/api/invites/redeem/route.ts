import { resolveAccessContext } from "../../../../lib/access-guard";
import { invitesAvailable, inviteState, redeemCode } from "../../../../lib/invites";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const MESSAGES: Record<string, string> = {
  INVITES_UNAVAILABLE: "这里暂时不能使用邀请码。",
  INVITE_CODE_INVALID: "邀请码不对，请核对邮件里的邀请码。",
  INVITE_CODE_USED: "这个邀请码已经被另一个账号使用。"
};

/** `{code}`: puts this account on the developer's model. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (!invitesAvailable()) return Response.json({ ok: false, code: "INVITES_UNAVAILABLE", message: MESSAGES.INVITES_UNAVAILABLE }, { status: 409 });
  const body = await request.json().catch(() => ({})) as { code?: unknown };
  const result = redeemCode(access.ctx, typeof body.code === "string" ? body.code.slice(0, 40) : "");
  if (!result.ok) return Response.json({ ok: false, code: result.code, message: MESSAGES[result.code] }, { status: 400 });
  return Response.json({ ok: true, state: inviteState(access.ctx) });
}
