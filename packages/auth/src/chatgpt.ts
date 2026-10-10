import { createHash, createPublicKey, randomBytes, randomUUID, verify, type webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import type { BetterAuthPlugin } from "better-auth";

/**
 * Sign in with ChatGPT for a copy of Crossline someone downloaded and runs on their own machine (decided 2026-10-10). OpenAI's flow for
 * open-source and local apps registers the app on first sign-in (`client_id=dynamic_agent_client`, the issued `oaiapp_…` id comes back on
 * the callback) and accepts only a `127.0.0.1` loopback callback, so this works when the page is opened at 127.0.0.1 and nowhere else; a
 * hosted site needs a partner client id instead. Only identity scopes are asked for: the models keep running through the person's own
 * Codex login, which keeps every Codex ability. The ID token is checked against OpenAI's published keys (issuer, audience = the issued
 * id, expiry, nonce) and `sub` is the account; Better Auth's own `handleOAuthUserInfo` then links or creates the user under the same
 * rules as Google (no implicit linking to an existing password account).
 */
export const CHATGPT_ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const COOKIE = "crossline_chatgpt";
const CALLBACK_PATH = "/auth/callback";

type Install = { hostId: string; clientId?: string };
const b64url = (buffer: Buffer) => buffer.toString("base64url");

function readInstall(file: string): Install {
  try { const saved = JSON.parse(readFileSync(file, "utf8")) as Install; if (saved.hostId) return saved; } catch { /* first use */ }
  const fresh = { hostId: `urn:uuid:${randomUUID()}` };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 });
  return fresh;
}

/** The loopback callback for this app's own port; undefined when the app is not served on loopback (a hosted site cannot use this flow). */
export function loopbackRedirect(baseURL: string): string | undefined {
  const url = new URL(baseURL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) return undefined;
  return `http://127.0.0.1:${url.port || "80"}${CALLBACK_PATH}`;
}

/** Verifies an RS256 ID token against the issuer's JWKS with node's own crypto; returns its claims or throws a code. */
export async function verifyIdToken(token: string, expect: { audience: string; nonce: string; now?: number }, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) throw new Error("CHATGPT_ID_TOKEN_MALFORMED");
  const header = JSON.parse(Buffer.from(head, "base64url").toString()) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("CHATGPT_ID_TOKEN_ALG");
  const discovery = await (await fetcher(`${CHATGPT_ISSUER}/.well-known/openid-configuration`)).json() as { jwks_uri?: string };
  const jwks = await (await fetcher(discovery.jwks_uri ?? `${CHATGPT_ISSUER}/.well-known/jwks.json`)).json() as { keys?: Array<webcrypto.JsonWebKey & { kid?: string }> };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid) ?? (jwks.keys?.length === 1 ? jwks.keys[0] : undefined);
  if (!jwk) throw new Error("CHATGPT_ID_TOKEN_KEY_UNKNOWN");
  if (!verify("RSA-SHA256", Buffer.from(`${head}.${body}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url")))
    throw new Error("CHATGPT_ID_TOKEN_SIGNATURE");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== CHATGPT_ISSUER) throw new Error("CHATGPT_ID_TOKEN_ISSUER");
  if (!audience.includes(expect.audience)) throw new Error("CHATGPT_ID_TOKEN_AUDIENCE");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= (expect.now ?? Date.now())) throw new Error("CHATGPT_ID_TOKEN_EXPIRED");
  if (claims.nonce !== expect.nonce) throw new Error("CHATGPT_ID_TOKEN_NONCE");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("CHATGPT_ID_TOKEN_SUBJECT");
  return claims;
}

export function chatgptSignIn(options: { installFile: string; fetch?: typeof fetch }): BetterAuthPlugin {
  const fetcher = options.fetch ?? fetch;
  return {
    id: "crossline-chatgpt",
    endpoints: {
      chatgptStart: createAuthEndpoint("/chatgpt/start", { method: "GET" }, async (ctx) => {
        const redirectUri = loopbackRedirect(ctx.context.baseURL);
        if (!redirectUri) throw ctx.redirect("/login?error=CHATGPT_SIGNIN_LOCAL_ONLY");
        const install = readInstall(options.installFile);
        const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16)), nonce = b64url(randomBytes(16));
        await ctx.setSignedCookie(COOKIE, JSON.stringify({ verifier, state, nonce }), ctx.context.secret,
          { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
        const query = new URLSearchParams({
          client_id: install.clientId ?? "dynamic_agent_client", ...(install.clientId ? {} : { agent_name_hint: "Crossline", ext_agent_host_id: install.hostId }),
          response_type: "code", redirect_uri: redirectUri, scope: "openid profile email", state, nonce,
          code_challenge_method: "S256", code_challenge: b64url(createHash("sha256").update(verifier).digest())
        });
        throw ctx.redirect(`${AUTHORIZE}?${query}`);
      }),
      chatgptCallback: createAuthEndpoint("/chatgpt/callback", { method: "GET" }, async (ctx) => {
        const fail = (code: string) => ctx.redirect(`/login?error=${code}`);
        const saved = await ctx.getSignedCookie(COOKIE, ctx.context.secret);
        const query = ctx.query as Record<string, string | undefined> | undefined;
        if (!saved) throw fail("CHATGPT_STATE_MISSING");
        const { verifier, state, nonce } = JSON.parse(saved) as { verifier: string; state: string; nonce: string };
        if (!query?.code || query.state !== state) throw fail("CHATGPT_STATE_MISMATCH");
        const redirectUri = loopbackRedirect(ctx.context.baseURL)!;
        const install = readInstall(options.installFile);
        // A first sign-in registers this install: OpenAI returns the id it issued, which every later sign-in uses.
        const clientId = install.clientId ?? query.client_id;
        if (!clientId) throw fail("CHATGPT_REGISTRATION_INCOMPLETE");
        if (!install.clientId) writeFileSync(options.installFile, JSON.stringify({ ...install, clientId }), { mode: 0o600 });
        const response = await fetcher(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }) });
        const tokens = await response.json().catch(() => ({})) as { id_token?: string; error?: string };
        if (!response.ok || !tokens.id_token) throw fail(tokens.error === "invalid_client" ? "CHATGPT_CLIENT_INVALID" : "CHATGPT_TOKEN_FAILED");
        let claims: Record<string, unknown>;
        try { claims = await verifyIdToken(tokens.id_token, { audience: clientId, nonce }, fetcher); }
        catch (error) { throw fail(error instanceof Error && /^CHATGPT_/.test(error.message) ? error.message : "CHATGPT_ID_TOKEN_INVALID"); }
        if (typeof claims.email !== "string" || !claims.email) throw fail("CHATGPT_EMAIL_MISSING");
        const result = await handleOAuthUserInfo(ctx, {
          userInfo: { id: claims.sub as string, email: claims.email, name: typeof claims.name === "string" ? claims.name : "",
            emailVerified: claims.email_verified !== false, image: typeof claims.picture === "string" ? claims.picture : null },
          account: { providerId: "chatgpt", accountId: claims.sub as string }, callbackURL: "/",
          source: { method: "oauth", oauth: { providerId: "chatgpt", profile: claims } }
        });
        if (result.error || !result.data) throw fail(String(result.error ?? "CHATGPT_SIGNIN_FAILED").split(" ").join("_"));
        ctx.setCookie(COOKIE, "", { path: "/", maxAge: 0 });
        await setSessionCookie(ctx, { session: result.data.session, user: result.data.user });
        throw ctx.redirect("/");
      })
    }
  };
}
