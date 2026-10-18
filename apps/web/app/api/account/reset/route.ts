import { getAuth } from "../../../../lib/auth";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { resetAccountData } from "../../../../lib/account-deletion";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export const runtime = "nodejs";

const MESSAGES: Record<string, string> = {
  ACCOUNT_RESET_LOCAL: "本机安装版的数据在这台电脑上，重新安装即清空。",
  EMAIL_MISMATCH: "输入的邮箱与这个账号不一致。"
};

/** 「清空数据重新开始」 (lib/account-deletion.ts): the body carries the account's email typed out, the only confirmation asked. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (access.ctx.role !== "owner") return Response.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ ok: false, code: "UNAUTHENTICATED" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { email?: unknown };
  const result = resetAccountData(access.ctx, { email: session.user.email }, typeof body.email === "string" ? body.email : "");
  if (!result.ok) return Response.json({ ok: false, code: result.code, message: MESSAGES[result.code] }, { status: result.code === "EMAIL_MISMATCH" ? 400 : 403 });
  return Response.json({ ok: true });
}
