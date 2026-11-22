import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_OAUTH_CODE_SECONDS, MCP_SCOPES, MCP_TOKEN_LABEL_MAX, mcpRedirectUriAllowed, mcpRedirectUriMatches, mcpScopesFrom, mcpText,
  type AccessContext, type McpScope } from "@crossline/core";
import { issueMcpGrant, refreshMcpGrant, type GrantTokens } from "./tokens";

/**
 * Crossline as its own OAuth 2.1 authorization server for the MCP endpoint (docs/mcp-server.md §4.3), for the hosts that sign in only that
 * way: claude.ai's custom connectors and ChatGPT's. What it does, and only that:
 * - discovery: Protected Resource Metadata (RFC 9728) for `/api/mcp`, Authorization Server Metadata (RFC 8414);
 * - dynamic client registration (RFC 7591), public clients only, with nothing stored: the client id is the registration itself, signed;
 * - authorization code + PKCE S256, the person's own session and an explicit 允许 on the consent page, `iss` on every answer (RFC 9207);
 * - refresh tokens, replaced on every use.
 * No Client ID Metadata Document: it would make this server fetch any URL a client names, and both hosts fall back to registration.
 * The tokens are the entries `tokens.ts` keeps for tokens made by hand, so the settings card lists and revokes both the same way.
 */

export type OAuthConfig = { issuer: string; resource: string; secret: string };

/**
 * The public address of this site, the same one Better Auth uses (`CROSSLINE_WEB_BASE_URL`, lib/auth.ts), and its secret; undefined
 * without a secret, and then there is no OAuth at all (the tokens made by hand still work).
 */
export function oauthConfig(env: Record<string, string | undefined> = process.env): OAuthConfig | undefined {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return undefined;
  const issuer = new URL(env.CROSSLINE_WEB_BASE_URL || "http://127.0.0.1:3210").origin;
  return { issuer, resource: `${issuer}/api/mcp`, secret };
}

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZE_PATH = "/mcp/authorize";
export const TOKEN_PATH = "/api/mcp/oauth/token";
export const REGISTER_PATH = "/api/mcp/oauth/register";

export const protectedResourceMetadata = (config: OAuthConfig) => ({
  resource: config.resource,
  authorization_servers: [config.issuer],
  scopes_supported: [...MCP_SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: "Crossline"
});

export const authorizationServerMetadata = (config: OAuthConfig) => ({
  issuer: config.issuer,
  authorization_endpoint: `${config.issuer}${AUTHORIZE_PATH}`,
  token_endpoint: `${config.issuer}${TOKEN_PATH}`,
  registration_endpoint: `${config.issuer}${REGISTER_PATH}`,
  scopes_supported: [...MCP_SCOPES],
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  authorization_response_iss_parameter_supported: true
});

/** The `WWW-Authenticate` of a 401 from `/api/mcp`: where to start signing in (RFC 9728 §5.1). */
export const resourceChallenge = (config: OAuthConfig, error?: "invalid_token") =>
  `Bearer resource_metadata="${config.issuer}${PROTECTED_RESOURCE_PATH}"${error ? `, error="${error}"` : ""}`;

// ---- Registration: the client id carries what was registered, signed with the site's secret.

export type RegisteredClient = { name: string; redirectUris: string[] };
type OAuthError = { error: string; error_description: string };
const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(`crossline-mcp-client:${payload}`).digest("base64url");

/** RFC 7591 registration of a public client: up to five redirect URIs, each https or this machine's loopback. */
export function registerClient(config: OAuthConfig, body: unknown, now = new Date()): { ok: true; response: Record<string, unknown> } | { ok: false; error: OAuthError } {
  const input = (body && typeof body === "object" ? body : {}) as { redirect_uris?: unknown; client_name?: unknown };
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(mcpRedirectUriAllowed))
    return { ok: false, error: { error: "invalid_redirect_uri", error_description: "redirect_uris: one to five https URLs, or http on localhost" } };
  const name = mcpText(typeof input.client_name === "string" ? input.client_name : "", MCP_TOKEN_LABEL_MAX);
  const payload = Buffer.from(JSON.stringify({ n: name, r: uris, t: Math.floor(now.getTime() / 1000) })).toString("base64url");
  const clientId = `${payload}.${sign(config.secret, payload)}`;
  return { ok: true, response: { client_id: clientId, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name, redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" } };
}

/** The registration a client id stands for, if this site signed it. */
export function readClient(config: OAuthConfig, clientId: string | null | undefined): RegisteredClient | undefined {
  const [payload, signature, extra] = (clientId ?? "").split(".");
  if (!payload || !signature || extra !== undefined || clientId!.length > 4096) return undefined;
  const expected = Buffer.from(sign(config.secret, payload)), given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { n?: unknown; r?: unknown };
    if (typeof parsed.n !== "string" || !Array.isArray(parsed.r) || !parsed.r.every(mcpRedirectUriAllowed)) return undefined;
    return { name: parsed.n, redirectUris: parsed.r };
  } catch { return undefined; }
}

// ---- Authorization: checked on the consent page and again when the person answers it.

export type AuthorizeRequest = {
  clientId: string; client: RegisteredClient; redirectUri: string; state?: string; codeChallenge: string; scopes: McpScope[];
  /** The host the code goes back to: what the consent page names, since a client's own name is only what it says it is. */
  host: string;
};
/**
 * `error`: the request is wrong, and `url` is the OAuth error for the client. It is never followed by itself: registration is open, so any
 * https address can be a registered redirect URI, and sending the browser there unasked would make this site an open redirect (RFC 9700
 * §4.11.2). The page says what is wrong and names `host`; the person goes back only by pressing the link.
 */
export type AuthorizeCheck = { kind: "ok"; request: AuthorizeRequest } | { kind: "error"; url: string; host: string; error: string }
  | { kind: "fatal"; code: "OAUTH_CLIENT_UNKNOWN" | "OAUTH_REDIRECT_UNKNOWN" };

/** The answer to a client: on its redirect URI, with its state and this server's `iss` (RFC 9207), errors included. */
function answer(config: OAuthConfig, redirectUri: string, state: string | undefined, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", config.issuer);
  return url.toString();
}

const BASE64URL_43_128 = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * An authorization request as the client sent it. A client or redirect URI this site does not know is only named on the page; every other
 * mistake becomes an OAuth error for the client, which the person may carry back with a press.
 */
export function checkAuthorize(config: OAuthConfig, params: URLSearchParams): AuthorizeCheck {
  const clientId = params.get("client_id") ?? "";
  const client = readClient(config, clientId);
  if (!client) return { kind: "fatal", code: "OAUTH_CLIENT_UNKNOWN" };
  const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!mcpRedirectUriAllowed(redirectUri) || !mcpRedirectUriMatches(redirectUri, client.redirectUris)) return { kind: "fatal", code: "OAUTH_REDIRECT_UNKNOWN" };
  const state = params.get("state") ?? undefined;
  const fail = (error: string, description: string): AuthorizeCheck => ({ kind: "error", error, host: new URL(redirectUri).host,
    url: answer(config, redirectUri, state, { error, error_description: description }) });
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !BASE64URL_43_128.test(codeChallenge)) return fail("invalid_request", "PKCE with S256 is required");
  const resource = params.get("resource");
  if (resource !== null && resource !== config.resource) return fail("invalid_target", `the only resource here is ${config.resource}`);
  return { kind: "ok", request: { clientId, client, redirectUri, ...(state !== undefined ? { state } : {}), codeChallenge,
    scopes: mcpScopesFrom(params.get("scope")), host: new URL(redirectUri).host } };
}

type PendingCode = { ctx: AccessContext; clientId: string; redirectUri: string; codeChallenge: string; scopes: McpScope[]; label: string; host: string; expiresAt: number };
declare global {
  // eslint-disable-next-line no-var
  var crosslineMcpCodes: Map<string, PendingCode> | undefined;
}
// On globalThis: the consent route and the token route are bundled apart, and must see the same codes. A restart loses them, which only
// costs a code that lives a minute.
const codes = () => globalThis.crosslineMcpCodes ??= new Map<string, PendingCode>();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The name a connection will carry: the one typed on the consent page, else the client's own, else its host. */
export const connectionLabel = (request: AuthorizeRequest, typed?: string) =>
  mcpText(typed, MCP_TOKEN_LABEL_MAX) || mcpText(request.client.name, MCP_TOKEN_LABEL_MAX) || request.host;

/**
 * The person's answer on the consent page: allowed, with the scope they chose (never more than asked) and the name the connection will
 * carry in 最近操作; or refused. Either way, where to send the browser next.
 */
export function decideAuthorize(config: OAuthConfig, ctx: AccessContext, request: AuthorizeRequest,
  decision: { allow: boolean; scope?: McpScope; label?: string }, now = new Date()): string {
  if (!decision.allow) return answer(config, request.redirectUri, request.state, { error: "access_denied", error_description: "the person declined" });
  const scopes: McpScope[] = decision.scope === "write" && request.scopes.includes("write") ? ["read", "write"] : ["read"];
  const label = connectionLabel(request, decision.label);
  const code = randomBytes(32).toString("base64url");
  const pending = codes();
  for (const [key, value] of pending) if (value.expiresAt <= now.getTime()) pending.delete(key);
  pending.set(sha256(code), { ctx, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, scopes, label,
    host: request.host, expiresAt: now.getTime() + MCP_OAUTH_CODE_SECONDS * 1000 });
  return answer(config, request.redirectUri, request.state, { code });
}

// ---- Token endpoint.

export type TokenAnswer = { status: number; body: Record<string, unknown> };
const tokenBody = (tokens: GrantTokens): TokenAnswer => ({ status: 200, body: { access_token: tokens.accessToken, token_type: "Bearer",
  expires_in: tokens.expiresIn, refresh_token: tokens.refreshToken, scope: tokens.scopes.join(" ") } });
const tokenError = (error: string, description: string, status = 400): TokenAnswer => ({ status, body: { error, error_description: description } });

/** `POST /api/mcp/oauth/token` with a form body: a code for the first tokens, a refresh token for the next ones. */
export function exchangeToken(config: OAuthConfig, form: URLSearchParams, now = new Date()): TokenAnswer {
  const clientId = form.get("client_id") ?? "";
  if (!readClient(config, clientId)) return tokenError("invalid_client", "unknown client_id", 401);
  const resource = form.get("resource");
  if (resource !== null && resource !== config.resource) return tokenError("invalid_target", `the only resource here is ${config.resource}`);
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const key = sha256(code);
    const pending = codes().get(key);
    // Used once, whatever happens next.
    codes().delete(key);
    if (!pending || pending.expiresAt <= now.getTime()) return tokenError("invalid_grant", "the code is unknown, used or expired");
    if (pending.clientId !== clientId || pending.redirectUri !== (form.get("redirect_uri") ?? "")) return tokenError("invalid_grant", "the code was issued to another client or redirect_uri");
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== pending.codeChallenge)
      return tokenError("invalid_grant", "code_verifier does not match");
    const issued = issueMcpGrant(pending.ctx, { label: pending.label, scopes: pending.scopes, client: pending.host, clientId }, now);
    return issued.ok ? tokenBody(issued.tokens) : tokenError("invalid_grant", "this account already has the most connections it keeps; revoke one in Crossline's Settings");
  }
  if (grant === "refresh_token") {
    const scope = form.get("scope");
    const renewed = refreshMcpGrant(form.get("refresh_token") ?? "", clientId, scope ? mcpScopesFrom(scope) : undefined, now);
    return renewed ? tokenBody(renewed) : tokenError("invalid_grant", "the refresh token is unknown, revoked or expired");
  }
  return tokenError("unsupported_grant_type", "authorization_code or refresh_token");
}
