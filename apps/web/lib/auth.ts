import "server-only";
import path from "node:path";
import { mkdirSync } from "node:fs";
import {
  createCrosslineAuth, createMailSender, type CrosslineAuth, type CrosslineAuthOptions, type GoogleConfig, type SmtpConfig
} from "@crossline/auth";
import { accountLocale, type CrosslineStore } from "@crossline/db";
import { isLocalInstall, readLocalCodexAccount } from "./local-install";

declare global {
  // eslint-disable-next-line no-var
  var crosslineAuth: CrosslineAuth | undefined;
}

function smtpFromEnv(): SmtpConfig | undefined {
  // An installed copy signs in only through its own Codex: no mail, whatever the environment carries.
  if (isLocalInstall()) return undefined;
  const { CROSSLINE_SMTP_HOST, CROSSLINE_SMTP_PORT, CROSSLINE_SMTP_USER, CROSSLINE_SMTP_PASSWORD, CROSSLINE_SMTP_FROM } = process.env;
  if (!CROSSLINE_SMTP_HOST || !CROSSLINE_SMTP_PORT || !CROSSLINE_SMTP_USER || !CROSSLINE_SMTP_PASSWORD || !CROSSLINE_SMTP_FROM) return undefined;
  return { host: CROSSLINE_SMTP_HOST, port: Number(CROSSLINE_SMTP_PORT), user: CROSSLINE_SMTP_USER, password: CROSSLINE_SMTP_PASSWORD, from: CROSSLINE_SMTP_FROM };
}

function googleFromEnv(): GoogleConfig | undefined {
  if (isLocalInstall()) return undefined;
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

/** Sign in with ChatGPT is opted into on this install (`CROSSLINE_CHATGPT_SIGNIN=1`, for a copy run on the person's own machine). */
export function isChatgptSignInConfigured(): boolean {
  return process.env.CROSSLINE_CHATGPT_SIGNIN === "1" && !isLocalInstall();
}

/** Mail that is not about signing in (the beta invite flow), through the same account and the same e2e mailbox; undefined without mail. */
export function appMailSender() {
  const testMailboxDir = isLocalInstall() ? undefined : process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR?.trim();
  const smtp = smtpFromEnv();
  return createMailSender({ ...(testMailboxDir ? { testMailboxDir } : smtp ? { smtp } : {}) });
}

/** Mail can be sent (SMTP, or the e2e mailbox): only then do email sign-up, the email code and password reset exist at all. */
export function isEmailAuthConfigured(): boolean {
  return Boolean(smtpFromEnv() || (!isLocalInstall() && process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR?.trim()));
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
  const testMailboxDir = isLocalInstall() ? undefined : process.env.CROSSLINE_AUTH_TEST_MAILBOX_DIR?.trim();
  return {
    authDbPath: path.join(dataDir, "auth.db"),
    secret, baseURL, trustedOrigins,
    // `exactOptionalPropertyTypes` refuses `smtp: undefined` — the key must be absent, not present with
    // an undefined value, which is also the distinction `createCrosslineAuth` uses to decide whether
    // email/password sign-up exists as a capability at all.
    // The e2e build's test mailbox wins over a real provider in `.env`: Next loads `.env` into the e2e server too (an empty override
    // counts as unset), and with Resend configured the sign-up mail went to the provider and global setup never saw it.
    ...(smtp && !testMailboxDir ? { smtp } : {}), ...(google ? { google } : {}),
    // The install's ChatGPT registration (host id, issued client id) lives beside the data, never in the ledger or an export.
    ...(isChatgptSignInConfigured() ? { chatgpt: { installFile: path.join(dataDir, "chatgpt-signin.json") } } : {}),
    // An installed copy: the session is the account the machine's Codex is signed in to (docs/local-installer.md, 登录).
    ...(isLocalInstall() ? { localCodex: { readAccount: readLocalCodexAccount } } : {}),
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
  // Mail to an existing account is written in the language it chose (docs/i18n.md); the ledger is read through the store the app
  // already opened (`getStore` in ./crossline), without importing it here.
  globalThis.crosslineAuth = createCrosslineAuth({ ...options, accountLocale: (userId) => {
    const store = (globalThis as { crosslineStore?: CrosslineStore }).crosslineStore;
    return store ? accountLocale(store, userId) : undefined;
  } });
  return globalThis.crosslineAuth;
}
