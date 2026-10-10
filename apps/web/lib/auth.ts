import "server-only";
import path from "node:path";
import { mkdirSync } from "node:fs";
import {
  createCrosslineAuth, type CrosslineAuth, type CrosslineAuthOptions, type GoogleConfig, type SmtpConfig
} from "@crossline/auth";

declare global {
  // eslint-disable-next-line no-var
  var crosslineAuth: CrosslineAuth | undefined;
}

function smtpFromEnv(): SmtpConfig | undefined {
  const { CROSSLINE_SMTP_HOST, CROSSLINE_SMTP_PORT, CROSSLINE_SMTP_USER, CROSSLINE_SMTP_PASSWORD, CROSSLINE_SMTP_FROM } = process.env;
  if (!CROSSLINE_SMTP_HOST || !CROSSLINE_SMTP_PORT || !CROSSLINE_SMTP_USER || !CROSSLINE_SMTP_PASSWORD || !CROSSLINE_SMTP_FROM) return undefined;
  return { host: CROSSLINE_SMTP_HOST, port: Number(CROSSLINE_SMTP_PORT), user: CROSSLINE_SMTP_USER, password: CROSSLINE_SMTP_PASSWORD, from: CROSSLINE_SMTP_FROM };
}

function googleFromEnv(): GoogleConfig | undefined {
  const { CROSSLINE_GOOGLE_CLIENT_ID, CROSSLINE_GOOGLE_CLIENT_SECRET } = process.env;
  if (!CROSSLINE_GOOGLE_CLIENT_ID || !CROSSLINE_GOOGLE_CLIENT_SECRET) return undefined;
  return { clientId: CROSSLINE_GOOGLE_CLIENT_ID, clientSecret: CROSSLINE_GOOGLE_CLIENT_SECRET };
}

/**
 * What `.env.example` already promises ("leaving them blank simply hides the 使用 Google 登录 button")
 * but `login-form.tsx` never actually checked — the button rendered unconditionally and clicking it with
 * no provider configured on the server just failed with no useful message.
 */
export function isGoogleAuthConfigured(): boolean {
  return Boolean(googleFromEnv());
}

/**
 * Shared by `getAuth()` (the request path) and `instrumentation.ts` (the one-time schema migration at
 * server start) so the two never resolve a different `authDbPath` or plugin set from the same env.
 * Returns `undefined` rather than throwing when `BETTER_AUTH_SECRET` is unset — `next build` imports
 * route modules to analyze them without necessarily running with every runtime env var set, and a build
 * should not fail over a var that only matters once a request actually reaches an auth route.
 */
export function resolveCrosslineAuthOptions(): CrosslineAuthOptions | undefined {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) return undefined;

  const dataDir = process.env.CROSSLINE_DATA_DIR
    ? path.resolve(process.env.CROSSLINE_DATA_DIR)
    : path.resolve(process.cwd(), "../../data");
  mkdirSync(dataDir, { recursive: true });

  // `||`, not `??`: an unset var and one present-but-blank in `.env` (`CROSSLINE_WEB_BASE_URL=`, exactly
  // how `.env.example` documents it) both read as `""` from `process.env`, and `??` only falls back on
  // `null`/`undefined` — a blank line silently produced `baseURL: ""` and Better Auth's own "Base URL is
  // not set" warning, found by actually starting the server with the example file's blank lines intact.
  const baseURL = process.env.CROSSLINE_WEB_BASE_URL || "http://127.0.0.1:3210";
  const trustedOrigins = [baseURL];
  // The same loopback port under its other name: opening the app at localhost (as the review server's note recommends, to keep its
  // cookies apart from 127.0.0.1's) answered every sign-up and sign-in with Better Auth's bare 「Invalid origin」.
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.exec(baseURL);
  if (loopback) trustedOrigins.push(`http://${loopback[1] === "localhost" ? "127.0.0.1" : "localhost"}${loopback[2] ?? ""}`);
  if (process.env.CROSSLINE_TAILSCALE_HOSTNAME) trustedOrigins.push(`https://${process.env.CROSSLINE_TAILSCALE_HOSTNAME}`);

  const smtp = smtpFromEnv();
  const google = googleFromEnv();
  const testMailboxDir = process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR?.trim();
  return {
    authDbPath: path.join(dataDir, "auth.db"),
    secret, baseURL, trustedOrigins,
    // `exactOptionalPropertyTypes` refuses `smtp: undefined` — the key must be absent, not present with
    // an undefined value, which is also the distinction `createCrosslineAuth` uses to decide whether
    // email/password sign-up exists as a capability at all.
    ...(smtp ? { smtp } : {}), ...(google ? { google } : {}),
    // Set only by the e2e build (`playwright.config.ts`) — never present in a real deployment, so this
    // never competes with `smtp` there.
    ...(testMailboxDir ? { testMailboxDir } : {})
  };
}

/**
 * Lazy the same way `getStore()` is lazy — see `resolveCrosslineAuthOptions`'s comment for why a
 * missing secret throws here (at first real use) rather than at module load.
 */
export function getAuth(): CrosslineAuth {
  if (globalThis.crosslineAuth) return globalThis.crosslineAuth;
  const options = resolveCrosslineAuthOptions();
  if (!options) throw new Error("BETTER_AUTH_SECRET_MISSING");
  globalThis.crosslineAuth = createCrosslineAuth(options);
  return globalThis.crosslineAuth;
}
