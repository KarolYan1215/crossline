import { getAuth } from "../../../../lib/auth";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { applyInvite, inviteState } from "../../../../lib/invites";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export const runtime = "nodejs";

const MESSAGES: Record<string, string> = {
  INVITES_UNAVAILABLE: "这里暂时不能申请邀请码。",
  INVITE_ALREADY_REDEEMED: "这个账号已经在用邀请码了。",
  INVITE_MAIL_FAILED: "申请没有送达开发者，请稍后再试。"
};

/** `{reason, plan?}`: applies for an invite code with the account's own email; the owner is mailed the first time. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user.email) return Response.json({ ok: false, code: "UNAUTHENTICATED" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { reason?: unknown; plan?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "";
  const plan = typeof body.plan === "string" && /^[a-z_]{1,24}$/.test(body.plan) ? body.plan : undefined;
  const result = await applyInvite(access.ctx, session.user.email, reason, plan ? { plan } : {});
  if (!result.ok) return Response.json({ ok: false, code: result.code, message: MESSAGES[result.code] ?? "申请没有成功。" }, { status: result.code === "INVITE_MAIL_FAILED" ? 502 : 409 });
  return Response.json({ ok: true, state: inviteState(access.ctx) });
}
