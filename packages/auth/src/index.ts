import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import nodemailer from "nodemailer";
import type { AccessContext } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";

export type SmtpConfig = { host: string; port: number; user: string; password: string; from: string };
export type GoogleConfig = { clientId: string; clientSecret: string };

export type CrosslineAuthOptions = {
  authDbPath: string;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  smtp?: SmtpConfig;
  google?: GoogleConfig;
};

export type CrosslineAuth = Auth;

function mailer(smtp: SmtpConfig) {
  return nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password }
  });
}

/**
 * A factory, not a singleton: tests build one against a temp `authDbPath`, `apps/web` builds exactly
 * one against `CROSSLINE_DATA_DIR` and caches it the same way `getStore()` caches `CrosslineStore`.
 *
 * Email/password sign-up is enabled only when `smtp` is supplied — the big plan requires this ("SMTP
 * 未配置时禁用邮箱注册，不允许退化为未验证账号"), and Better Auth's own `emailAndPassword.enabled` is a
 * required field, not something that defaults to off on its own — so the whole block is omitted rather
 * than passed with an `enabled: false` that would still register the routes.
 */
export function createCrosslineAuth(options: CrosslineAuthOptions): Auth {
  const transport = options.smtp ? mailer(options.smtp) : undefined;
  const sendMail = (to: string, subject: string, url: string) => {
    if (!transport || !options.smtp) return Promise.resolve();
    return transport.sendMail({ from: options.smtp.from, to, subject, text: url }).then(() => undefined);
  };

  // Widened to the plain `BetterAuthOptions` before the call: `betterAuth<Options>` returns
  // `Auth<Options>`, and letting `Options` infer as this specific literal object type makes the
  // returned `Auth<...>` embed non-portable types (`better-sqlite3`'s `Database`) that `tsc` cannot
  // name when emitting this package's declarations (`declaration: true` in tsconfig.base.json).
  const config: BetterAuthOptions = {
    database: new Database(options.authDbPath),
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,
    // Revalidated from the database on every request, never trusted from a signed cookie payload — a
    // revoked session or a demoted role must take effect immediately, not after a cache window.
    session: { cookieCache: { enabled: false } },
    advanced: {
      // 127.0.0.1/localhost is a browser-trustworthy secure context even over plain HTTP, so `secure`
      // does not need to be relaxed for local dev — only the Tailscale hostname (real HTTPS, stage six)
      // and loopback dev both satisfy it as written.
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" }
    },
    account: {
      // The big plan requires explicit linking: signing in with Google using an email that already has
      // a password account must not silently become the same account. `linkSocial()` while authenticated
      // is still how a user connects a second provider on purpose.
      accountLinking: { disableImplicitLinking: true }
    },
    ...(options.smtp ? {
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => { await sendMail(user.email, "重置 Crossline 密码", url); }
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => { await sendMail(user.email, "验证你的 Crossline 邮箱", url); }
      }
    } : {}),
    ...(options.google ? {
      socialProviders: { google: { clientId: options.google.clientId, clientSecret: options.google.clientSecret } }
    } : {}),
    plugins: [nextCookies()]
  };
  return betterAuth(config);
}

export type ResolvedAccessContext = { ctx: AccessContext } | { error: "UNAUTHENTICATED" | "NOT_A_MEMBER" };

/**
 * The one place a request turns into an `AccessContext`. Two checks, both required: Better Auth says
 * who is asking (a valid, unexpired, unrevoked session), and `workspace_members` says whether that
 * principal is actually allowed into the workspace it is asking for — the second check does not exist
 * anywhere else today, which is exactly the gap `isolation.test.ts`'s own doc comment names: nothing
 * previously verified the caller was allowed to use the `workspaceId` it passed.
 */
export async function requireAccessContext(
  auth: CrosslineAuth, store: CrosslineStore, request: Request
): Promise<ResolvedAccessContext> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { error: "UNAUTHENTICATED" };

  const { principal, workspace } = store.createPrincipalWithWorkspace(session.user.id, "个人 workspace");
  const membership = store.getWorkspaceMembership(principal.id, workspace.id);
  if (!membership) return { error: "NOT_A_MEMBER" };

  // Which provider authenticated this user, for the audit trail — not itself a security boundary, so a
  // best-effort read of linked accounts is enough; the membership check above is what actually gates.
  let provider: AccessContext["identity"]["provider"] = "credential";
  try {
    const accounts = await auth.api.listUserAccounts({ headers: request.headers });
    const social = accounts.find((account) => account.providerId !== "credential");
    if (social?.providerId === "google") provider = "google";
  } catch { /* best-effort only */ }

  return {
    ctx: {
      principalId: principal.id,
      workspaceId: workspace.id,
      role: membership.role,
      identity: { provider, issuer: "crossline", subject: session.user.id },
      authMethod: "session",
      requestId: randomUUID()
    }
  };
}
