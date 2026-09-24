import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { getMigrations } from "better-auth/db/migration";
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
  /**
   * When set, verification/reset emails are written as one JSON file per message into this directory
   * instead of going through `smtp` — the e2e harness reads them back to drive the real sign-up →
   * verify → sign-in flow without a real mailbox. Never set outside the e2e build.
   */
  testMailboxDir?: string;
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
 * Email/password sign-up is enabled only when the config can actually deliver a verification message —
 * `smtp` in production, `testMailboxDir` in the e2e build — the big plan requires this ("SMTP 未配置时禁用
 * 邮箱注册，不允许退化为未验证账号"), and Better Auth's own `emailAndPassword.enabled` is a required field,
 * not something that defaults to off on its own — so the whole block is omitted rather than passed with
 * an `enabled: false` that would still register the routes.
 */
/**
 * The pure config, split out from `createCrosslineAuth` so `migrateCrosslineAuth` (below) can build the
 * exact same `BetterAuthOptions` and hand it to Better Auth's own `getMigrations` — the schema Better
 * Auth expects is a function of this config (which fields the enabled plugins/options add), so a
 * migration built from a different config than the one the running app actually uses could drift from
 * it silently.
 */
function crosslineAuthConfig(options: CrosslineAuthOptions): BetterAuthOptions {
  const transport = options.smtp ? mailer(options.smtp) : undefined;
  const sendMail = (to: string, subject: string, url: string): Promise<void> => {
    // The e2e sink takes priority when both are set (it never is in production — see the `testMailboxDir`
    // doc comment) so a captured message never silently also tries a real SMTP round trip.
    if (options.testMailboxDir) {
      mkdirSync(options.testMailboxDir, { recursive: true });
      writeFileSync(path.join(options.testMailboxDir, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ to, subject, url }));
      return Promise.resolve();
    }
    if (!transport || !options.smtp) return Promise.resolve();
    return transport.sendMail({ from: options.smtp.from, to, subject, text: url }).then(() => undefined);
  };
  const emailCapable = Boolean(options.smtp || options.testMailboxDir);

  // Widened to the plain `BetterAuthOptions` return type: `betterAuth<Options>` returns `Auth<Options>`,
  // and letting `Options` infer as this specific literal object type makes the returned `Auth<...>`
  // embed non-portable types (`better-sqlite3`'s `Database`) that `tsc` cannot name when emitting this
  // package's declarations (`declaration: true` in tsconfig.base.json).
  return {
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
    ...(emailCapable ? {
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
}

export function createCrosslineAuth(options: CrosslineAuthOptions): Auth {
  return betterAuth(crosslineAuthConfig(options));
}

/**
 * Applies Better Auth's own `user`/`session`/`account`/`verification` schema to `authDbPath`. Better
 * Auth ships this as a CLI (`getMigrations`/`runMigrations` under the hood), but the published
 * `@better-auth/cli` package trails this repo's pinned `better-auth` version (1.4.21 vs 1.7.5 at the
 * time this was written) — calling the same version's own `getMigrations` directly, from
 * `better-auth/db/migration`, avoids a schema generated by a different release than the one actually
 * running. Idempotent: a database that already has the tables reports nothing left `toBeCreated`.
 */
export async function migrateCrosslineAuth(options: CrosslineAuthOptions): Promise<{ applied: string[] }> {
  const config = crosslineAuthConfig(options);
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(config);
  await runMigrations();
  return { applied: [...toBeCreated, ...toBeAdded].map((item) => item.table) };
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
