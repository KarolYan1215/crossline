import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import type { BetterAuthPlugin } from "better-auth";

/**
 * Signing in on an installed copy (docs/local-installer.md, 登录): the person signs in to Codex with ChatGPT once — the one OpenAI
 * consent page — and this turns the account Codex now holds into a Crossline session. No password, no mail, no second OAuth client.
 *
 * `readAccount` asks the machine's own Codex (`account/read`) which account it is signed in to; only a ChatGPT login with an email
 * counts. The route answers only on the loopback address the app was opened at: the server binds 127.0.0.1, and the Host check keeps
 * a page from another site (DNS rebinding) or a forwarding proxy from minting a session through it.
 */
export type LocalCodexAccount = { email: string; planType?: string };
export type ReadLocalCodexAccount = () => Promise<LocalCodexAccount | null | undefined>;

/** Reads `account/read`'s answer: a ChatGPT login with an email, else null (signed out, an API key, or no email to name the account). */
export function chatgptAccountOf(value: unknown): LocalCodexAccount | null {
  const account = (value as { account?: { type?: unknown; email?: unknown; planType?: unknown } | null } | null)?.account;
  if (!account || account.type !== "chatgpt" || typeof account.email !== "string" || !account.email.includes("@")) return null;
  return { email: account.email.trim().toLowerCase(), ...(typeof account.planType === "string" ? { planType: account.planType } : {}) };
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True when a request reached the app on its own loopback origin, directly — not through a proxy and not under another name.
 * Next.js fills in `x-forwarded-for` (the socket's peer) and `x-forwarded-host` (the Host) itself when a request has none
 * (`base-server.js`, `??=`), so their presence proves nothing: a direct request carries the loopback peer and its own Host there,
 * while a proxy in front (tailscale serve, anything forwarding) names the real client or another host, and is refused.
 */
export function isDirectLoopbackRequest(headers: Headers, baseURL: string): boolean {
  const base = new URL(baseURL);
  if (!["127.0.0.1", "localhost"].includes(base.hostname)) return false;
  if (headers.get("forwarded")) return false;
  const port = base.port || "80";
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = (headers.get("host") ?? "").toLowerCase();
  if (!allowed.has(host)) return false;
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null && !LOOPBACK_PEERS.has(forwardedFor.trim())) return false;
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost !== null && forwardedHost.toLowerCase() !== host) return false;
  const origin = headers.get("origin");
  if (origin && !allowed.has(origin.replace(/^http:\/\//, "").toLowerCase())) return false;
  return true;
}

export function codexLocalSignIn(options: { readAccount: ReadLocalCodexAccount }): BetterAuthPlugin {
  return {
    id: "crossline-codex-local",
    endpoints: {
      codexLocalSession: createAuthEndpoint("/codex-local/session", { method: "POST", requireHeaders: true }, async (ctx) => {
        if (!isDirectLoopbackRequest(ctx.headers!, ctx.context.baseURL))
          throw new APIError("FORBIDDEN", { code: "LOCAL_SIGNIN_LOOPBACK_ONLY", message: "只能在本机地址上登录" });
        let account: LocalCodexAccount | null | undefined;
        try { account = await options.readAccount(); }
        catch { throw new APIError("SERVICE_UNAVAILABLE", { code: "CODEX_UNAVAILABLE", message: "Codex 还没有启动好" }); }
        if (!account) throw new APIError("CONFLICT", { code: "CODEX_NOT_SIGNED_IN", message: "Codex 还没有用 ChatGPT 登录" });
        const result = await handleOAuthUserInfo(ctx, {
          userInfo: { id: account.email, email: account.email, name: account.email.split("@")[0] ?? account.email, emailVerified: true, image: null },
          account: { providerId: "codex", accountId: account.email },
          callbackURL: "/",
          source: { method: "oauth", oauth: { providerId: "codex", profile: { email: account.email } } }
        } as Parameters<typeof handleOAuthUserInfo>[1]);
        if (result.error || !result.data) throw new APIError("BAD_REQUEST", { code: "LOCAL_SIGNIN_FAILED", message: String(result.error ?? "登录失败") });
        await setSessionCookie(ctx, { session: result.data.session, user: result.data.user });
        return ctx.json({ ok: true, email: account.email });
      })
    }
  };
}
