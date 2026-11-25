/**
 * Website logins kept for registration forms (docs/plans/harness-1125.md §5; the owner's decision of 2026-11-25). The person saves a
 * host, a username and a password on the 报名资料卡; both go to the worker's secret store only (`login-<host>`), and the ledger keeps
 * only that the host has one and since when (`apply.logins`). The form engine itself fills them on that host's own login page — https,
 * the top-level page, the exact host or a known alias — and never through a model. Payment, captchas, two-factor and one-time codes
 * stay the person's.
 */
export const LOGIN_VAULT_SETTING = "apply.logins";
export type LoginVaultEntry = { host: string; savedAt: string };
export type LoginSecret = { username: string; password: string };
export const loginSecretName = (host: string) => `login-${host}`;

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** A host as the vault keys it: from a bare host or a pasted address, lower case, without `www.`; undefined when it is not one. */
export function loginHostOf(input: string): string | undefined {
  const text = input.trim().toLowerCase();
  if (!text) return undefined;
  let host = text;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) { try { host = new URL(text).hostname; } catch { return undefined; } }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  return HOST_NAME.test(host) ? host : undefined;
}

export function readLoginVault(raw: string | undefined): LoginVaultEntry[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LoginVaultEntry => Boolean(item) && typeof item.host === "string" && Boolean(loginHostOf(item.host)) && typeof item.savedAt === "string")
      .map((item) => ({ host: item.host, savedAt: item.savedAt }));
  } catch { return []; }
}

/** Why a login cannot be saved, or undefined when it can (codes, translated where shown). */
export function loginProblem(input: { host: string; username: string; password: string }): string | undefined {
  if (!loginHostOf(input.host)) return "LOGIN_HOST_INVALID";
  if (!input.username.trim() || input.username.length > 320) return "LOGIN_USERNAME_INVALID";
  if (!input.password || input.password.length > 500) return "LOGIN_PASSWORD_INVALID";
  return undefined;
}

/**
 * The saved login a page may use: only over https, only when the page's own host is the entry's host or one of its known aliases
 * (`aliases` is the form browser's `runHosts`). A subdomain does not count: `accounts.example.com` is not `example.com`.
 */
export function loginFor(entries: readonly LoginVaultEntry[], pageUrl: string, aliases: (host: string) => string[]): LoginVaultEntry | undefined {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return undefined; }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return entries.find((entry) => entry.host === host || aliases(entry.host).includes(host));
}

/** A field that asks for a second factor or a code sent elsewhere: such a login is the person's, whatever is saved. */
// i18n-ignore: a pattern matched against what a site shows
export const SECOND_FACTOR = /one-time|verification code|security code|authentication code|authenticator|\botp\b|2fa|two-factor|two-step|passcode|magic link|sms code|验证码|动态码|校验码|安全码|二次验证|两步验证/i;

/**
 * Replaces a saved login's username and password with placeholders in any text a model or the ledger may see (a snapshot of the login
 * page just filled, an error that quotes it). Values under three characters are left: they would blank ordinary words.
 */
export function redactLogin(text: string, login: LoginSecret | undefined): string {
  if (!login) return text;
  let out = text;
  for (const [value, placeholder] of [[login.password, "{{login.password}}"], [login.username.trim(), "{{login.username}}"]] as const) {
    if (value.length < 3) continue;
    out = out.split(value).join(placeholder);
  }
  return out;
}
