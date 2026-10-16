import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins/email-otp";
import { chatgptSignIn } from "./chatgpt";
import { codexLocalSignIn, type ReadLocalCodexAccount } from "./codex-local";
export { chatgptAccountOf, isDirectLoopbackRequest, type LocalCodexAccount, type ReadLocalCodexAccount } from "./codex-local";
import { getMigrations } from "better-auth/db/migration";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
  /**
   * Sign in with ChatGPT for a copy run on the person's own machine (`chatgpt.ts`): the file that keeps this install's host id and the
   * client id OpenAI issued on first sign-in. Absent, the flow does not exist.
   */
  chatgpt?: { installFile: string; fetch?: typeof fetch };
  /**
   * An installed copy (`CROSSLINE_INSTALL_MODE=local`, docs/local-installer.md): the session comes from the machine's own Codex
   * ChatGPT login (`codex-local.ts`), and nothing else signs in.
   */
  localCodex?: { readAccount: ReadLocalCodexAccount };
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
  // Better Auth sends through `runInBackgroundOrAwait`, which catches every error and only logs it, so a message that did not go out
  // still answered the sign-up with success and the page said 「已发送验证邮件」 (a provider in test mode refuses every address but its
  // owner's). A failure is noted here, by address, and turned into an honest error by the `after` hook below, in the same request.
  const undelivered = new Map<string, string>();
  const deliver = async (to: string, subject: string, url: string) => {
    try { await sendMail(to, subject, url); undelivered.delete(to.toLowerCase()); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      undelivered.set(to.toLowerCase(), reason);
      // Typed for the routes that await the sender directly (resend): they answer with this code instead of a bare 500.
      throw new APIError("BAD_GATEWAY", { code: "VERIFICATION_EMAIL_FAILED", message: `email not delivered: ${reason.slice(0, 160)}` });
    }
  };
  const SENDING_PATHS = new Set(["/sign-up/email", "/send-verification-email", "/request-password-reset", "/email-otp/send-verification-otp"]);

  // Widened to the plain `BetterAuthOptions` return type: `betterAuth<Options>` returns `Auth<Options>`,
  // and letting `Options` infer as this specific literal object type makes the returned `Auth<...>`
  // embed non-portable types (`better-sqlite3`'s `Database`) that `tsc` cannot name when emitting this
  // package's declarations (`declaration: true` in tsconfig.base.json).
  const database = new Database(options.authDbPath);
  return {
    database,
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,
    // Revalidated from the database on every request, never trusted from a signed cookie payload — a
    // revoked session or a demoted role must take effect immediately, not after a cache window.
    // A 90-day sliding session (refreshed at most once a day while used): this runs on the person's own machines, and signing in
    // again every week on a device that is already theirs was friction with no protection behind it. Revocation is unchanged — the
    // row is re-read on every request, and signing out or revoking a device ends it at once.
    session: { cookieCache: { enabled: false }, expiresIn: 60 * 60 * 24 * 90, updateAge: 60 * 60 * 24 },
    advanced: {
      // 127.0.0.1/localhost is a browser-trustworthy secure context even over plain HTTP, so `secure`
      // does not need to be relaxed for local dev — only the Tailscale hostname (real HTTPS, stage six)
      // and loopback dev both satisfy it as written.
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
      // Cookies are not kept apart by port: an installed copy at 127.0.0.1:<its port> and a checkout's resident app at 127.0.0.1:3210 on
      // the same machine would overwrite each other's session in one browser. The installed copy's cookies get their own names.
      ...(options.localCodex ? { cookiePrefix: "crossline-local" } : {})
    },
    // The hosted beta (docs/beta-launch.md §10.6): who may create an account, by any path — email code, password or Google. Existing
    // accounts sign in as before. Listed addresses always may; with `CROSSLINE_SIGNUP_CAP` anyone else may while the accounts number
    // fewer than the cap (people come by the public test or straight to the interview, and neither path should need an invitation);
    // past it the address goes on the waiting list. A list with no cap admits only the list.
    ...(signupAllowlist() || signupCap() ? { databaseHooks: { user: { create: { before: async (user: { email: string }) => {
      const email = user.email.trim().toLowerCase();
      if (signupAllowlist()?.has(email)) return { data: user };
      const cap = signupCap();
      if (cap !== undefined) {
        const { n } = database.prepare("SELECT count(*) AS n FROM \"user\"").get() as { n: number };
        if (n < cap) return { data: user };
        noteWaiting(email);
        throw new APIError("FORBIDDEN", { code: "SIGNUP_FULL", message: "内测名额已满，已记下这个邮箱，有名额时会通知你。" });
      }
      throw new APIError("FORBIDDEN", { code: "SIGNUP_NOT_INVITED", message: "这个邮箱不在内测名单里。" });
    } } } } } : {}),
    account: {
      // Same email, same account (the person's decision, 2026-10-13; it replaced explicit-only linking, which refused a Google or
      // ChatGPT sign-in for the owner's own address and offered no way to link). Better Auth links only when both sides vouch for the
      // address: the provider says it verified it (Google's `email_verified`; ChatGPT's, see chatgpt.ts) — no provider is listed as
      // trusted, so an unverified claim never links — and the local account's own email is verified (`requireLocalEmailVerified`, on
      // by default), so an unverified password sign-up cannot squat an address and inherit the real owner's sign-in.
      accountLinking: { enabled: true }
    },
    ...(emailCapable ? {
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => { await deliver(user.email, "重置 Crossline 密码", url); }
      },
      emailVerification: {
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => { await deliver(user.email, "验证你的 Crossline 邮箱", url); }
      },
      hooks: {
        after: createAuthMiddleware(async (ctx) => {
          if (!SENDING_PATHS.has(ctx.path)) return;
          const email = String((ctx.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase();
          const reason = undelivered.get(email);
          if (reason === undefined) return;
          undelivered.delete(email);
          throw new APIError("BAD_GATEWAY", { code: "VERIFICATION_EMAIL_FAILED", message: `email not delivered: ${reason.slice(0, 160)}` });
        })
      }
    } : {}),
    ...(options.google ? {
      socialProviders: { google: { clientId: options.google.clientId, clientSecret: options.google.clientSecret } }
    } : {}),
    // A six-digit code by email signs in without a password and creates the account on first use: one step fewer than sign-up →
    // verification link → sign-in, and only offered where mail can actually be delivered. `nextCookies` stays last, as Better Auth asks.
    plugins: [...(emailCapable ? [emailOTP({ sendVerificationOTP: async ({ email, otp }) => { await deliver(email, "Crossline 登录验证码", `验证码：${otp}（10 分钟内有效）`); },
      expiresIn: 600 })] : []), ...(options.chatgpt ? [chatgptSignIn(options.chatgpt)] : []),
      ...(options.localCodex ? [codexLocalSignIn(options.localCodex)] : []), nextCookies()]
  };
}

/**
 * The invited addresses, lower-cased; undefined when sign-up is open. Two sources, read on each use: `CROSSLINE_SIGNUP_ALLOWLIST`
 * (comma-separated) and the file `CROSSLINE_SIGNUP_ALLOWLIST_FILE` (one address per line, `#` comments), which the server refreshes
 * from the public test's 「申请内测」 requests — so an invitation takes effect without a restart. Naming a file closes sign-up even while
 * it is empty or missing: an unreadable list must never mean an open door.
 */
export function signupAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | undefined {
  const file = env.CROSSLINE_SIGNUP_ALLOWLIST_FILE?.trim();
  let fromFile: string[] = [];
  if (file && existsSync(file)) { try { fromFile = readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.replace(/#.*/, "")); } catch { fromFile = []; } }
  const list = [...(env.CROSSLINE_SIGNUP_ALLOWLIST ?? "").split(","), ...fromFile].map((item) => item.trim().toLowerCase()).filter(Boolean);
  return list.length || file ? new Set(list) : undefined;
}

/** At most this many accounts may be created outside the list (`CROSSLINE_SIGNUP_CAP`); undefined = no cap. */
export function signupCap(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const cap = Number(env.CROSSLINE_SIGNUP_CAP?.trim());
  return Number.isInteger(cap) && cap >= 0 && env.CROSSLINE_SIGNUP_CAP?.trim() ? cap : undefined;
}

/** Past the cap: the address and the time, one line each, in `CROSSLINE_SIGNUP_WAITLIST_FILE` (or nowhere when unset). */
function noteWaiting(email: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = env.CROSSLINE_SIGNUP_WAITLIST_FILE?.trim();
  if (!file) return;
  try {
    const known = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (known.split(/\r?\n/).some((line) => line.split("\t")[0] === email)) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${known}${email}\t${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { /* the refusal still stands; losing a waiting-list line is not worth failing the request over */ }
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
  auth: CrosslineAuth, store: CrosslineStore, request: Request, localAccount?: ReadLocalCodexAccount
): Promise<ResolvedAccessContext> {
  // Untouchable: this must stay a live, uncached call on every single request — `cookieCache.enabled:
  // false` is what makes a revoked session or a demoted role take effect on the very next request,
  // proven end to end by `scripts/gate-identity-check.ts`. Nothing below this line may weaken that.
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { error: "UNAUTHENTICATED" };
  // An installed copy's session stands for the account its Codex is signed in to. Codex signed out, or signed in as someone else,
  // ends every session of this user; a Codex that cannot be asked right now (starting, restarting) is not a reason to sign out.
  if (localAccount) {
    const account = await localAccount().catch(() => undefined);
    if (account === null || (account && account.email !== session.user.email.toLowerCase())) {
      await (await auth.$context).internalAdapter.deleteUserSessions(session.user.id);
      return { error: "UNAUTHENTICATED" };
    }
  }

  // One indexed query on the steady-state path instead of the 4 separate statements
  // `createPrincipalWithWorkspace` + a redundant `getWorkspaceMembership` used to cost per request — see
  // `resolvePrincipalWorkspace`'s own doc comment. Still re-derives role fresh from `workspace_members`
  // on every call, so a revoked/demoted membership is reflected exactly as immediately as before.
  const { principal, workspace, role } = store.resolvePrincipalWorkspace(session.user.id, "个人 workspace");

  // `identity.provider` has no real consumer today (nothing in this codebase reads it) — the
  // `auth.api.listUserAccounts` call this used to make was a 5th per-request round trip, against a
  // second SQLite file, purely to label a field nothing looks at. Defaulted here instead; real
  // provider resolution belongs at the point something actually writes an audit event
  // (`appendAuditEvent`, currently only exercised by tests), resolved lazily there, not eagerly on every
  // read this function serves.
  const provider: AccessContext["identity"]["provider"] = "credential";

  return {
    ctx: {
      principalId: principal.id,
      workspaceId: workspace.id,
      role,
      identity: { provider, issuer: "crossline", subject: session.user.id },
      authMethod: "session",
      requestId: randomUUID()
    }
  };
}
