import { isAPIError } from "better-auth/api";
import { getAuth } from "../../../../lib/auth";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { authErrorMessage } from "../../../auth-errors";

/**
 * Whether the signed-in account has a password, and setting one when it has none (2026-10-16). An account made by an email code has no
 * password, and nothing used to offer one, so the password way in stayed closed to it for good. Better Auth's `setPassword` runs only on
 * the server and only on a fresh session (signed in within its freshness window), which is right after the code sign-in this follows.
 * Changing an existing password stays with the client's own `changePassword`, which asks for the current one.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const accounts = await getAuth().api.listUserAccounts({ headers: request.headers }).catch(() => []);
  return Response.json({ hasPassword: accounts.some((account) => account.providerId === "credential") });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { newPassword?: unknown };
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (newPassword.length < 8 || newPassword.length > 128) {
    return Response.json({ ok: false, code: "PASSWORD_LENGTH", message: "密码需要 8 到 128 个字符。" }, { status: 400 });
  }
  try {
    await getAuth().api.setPassword({ body: { newPassword }, headers: request.headers });
    return Response.json({ ok: true });
  } catch (error) {
    // A stale session (signed in long ago) is refused by Better Auth's freshness check: the page says to sign in again.
    const code = isAPIError(error) ? String((error.body as { code?: unknown } | undefined)?.code ?? error.status) : "PASSWORD_NOT_SET";
    return Response.json({ ok: false, code, message: authErrorMessage({ code }, "密码没有设置成功：请重新登录后再试，或在登录页用「忘记密码」设置。") },
      { status: isAPIError(error) && typeof error.statusCode === "number" ? error.statusCode : 400 });
  }
}
