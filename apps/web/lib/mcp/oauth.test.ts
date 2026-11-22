import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MCP_TOKENS_MAX } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { authorizationServerMetadata, checkAuthorize, decideAuthorize, exchangeToken, oauthConfig, protectedResourceMetadata, readClient, registerClient,
  resourceChallenge, type AuthorizeRequest, type OAuthConfig } from "./oauth";
import { issueMcpToken, listMcpTokens, mcpCallerFor, mcpTokensFull, revokeMcpToken } from "./tokens";
import { TEST_CTX } from "../test-support";

/** Crossline's own OAuth authorization server for `/api/mcp` (docs/mcp-server.md §4.3), piece by piece. */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; globalThis.crosslineMcpCodes = undefined;
  globalThis.crosslineMcpRefreshGrace = undefined; });

const ENV = { BETTER_AUTH_SECRET: "test-secret-not-real", CROSSLINE_WEB_BASE_URL: "https://crossline.example/" };
const config = oauthConfig(ENV)!;
const NOW = new Date("2026-11-21T10:00:00.000Z");
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { principal, workspace } = store.createPrincipalWithWorkspace("owner", "个人");
  return { ...TEST_CTX, principalId: principal.id, workspaceId: workspace.id };
}

function client(uris = [CLAUDE, "http://localhost/callback"], name = "Claude") {
  const made = registerClient(config, { client_name: name, redirect_uris: uris }, NOW);
  if (!made.ok) throw new Error(made.error.error);
  return made.response.client_id as string;
}

function authorize(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256",
    state: "st-1", scope: "read write", resource: config.resource, ...extra });
}

function approved(ctx: typeof TEST_CTX, clientId: string, scope: "read" | "write" = "write") {
  const check = checkAuthorize(config, authorize(clientId));
  if (check.kind !== "ok") throw new Error(check.kind);
  return new URL(decideAuthorize(config, ctx, check.request, { allow: true, scope }, NOW));
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields);

test("discovery: the resource points at this server, which offers only code + PKCE S256, public clients and iss on every answer", () => {
  expect(oauthConfig({})).toBeUndefined();
  expect(config).toMatchObject({ issuer: "https://crossline.example", resource: "https://crossline.example/api/mcp" });
  expect(protectedResourceMetadata(config)).toMatchObject({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ["read", "write"] });
  const as = authorizationServerMetadata(config);
  expect(as).toMatchObject({ issuer: config.issuer, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true, grant_types_supported: ["authorization_code", "refresh_token"] });
  // No Client ID Metadata Document: this server never fetches a URL a client names.
  expect(as).not.toHaveProperty("client_id_metadata_document_supported");
  expect(resourceChallenge(config)).toBe('Bearer resource_metadata="https://crossline.example/.well-known/oauth-protected-resource"');
});

test("registration stores nothing: the client id is the registration, signed; a forged or altered one is unknown", () => {
  setup();
  const clientId = client();
  expect(readClient(config, clientId)).toEqual({ name: "Claude", redirectUris: [CLAUDE, "http://localhost/callback"] });
  const [payload, signature] = clientId.split(".");
  const forged = Buffer.from(JSON.stringify({ n: "Claude", r: ["https://evil.example/cb"], t: 1 })).toString("base64url");
  expect(readClient(config, `${forged}.${signature}`)).toBeUndefined();
  expect(readClient(oauthConfig({ ...ENV, BETTER_AUTH_SECRET: "another" })!, clientId)).toBeUndefined();
  expect(readClient(config, `${payload}.${signature}.x`)).toBeUndefined();
  for (const uris of [[], ["http://evil.example/cb"], ["javascript:alert(1)"], ["https://a.example/cb#x"], Array(6).fill(CLAUDE)])
    expect(registerClient(config, { redirect_uris: uris })).toMatchObject({ ok: false, error: { error: "invalid_redirect_uri" } });
});

test("authorize: an unknown client or redirect is only named; other mistakes become an error for the client, with state and iss, never followed by itself", () => {
  setup();
  const clientId = client();
  expect(checkAuthorize(config, authorize("nope.nope"))).toEqual({ kind: "fatal", code: "OAUTH_CLIENT_UNKNOWN" });
  expect(checkAuthorize(config, authorize(clientId, { redirect_uri: "https://evil.example/cb" }))).toEqual({ kind: "fatal", code: "OAUTH_REDIRECT_UNKNOWN" });
  // A loopback redirect matches whatever port the host picked (RFC 8252 §7.3).
  expect(checkAuthorize(config, authorize(clientId, { redirect_uri: "http://localhost:51234/callback" })).kind).toBe("ok");
  for (const [extra, error] of [[{ code_challenge_method: "plain" }, "invalid_request"], [{ code_challenge: "" }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"], [{ resource: "https://other.example/mcp" }, "invalid_target"]] as const) {
    const check = checkAuthorize(config, authorize(clientId, extra));
    expect(check).toMatchObject({ kind: "error", error, host: "claude.ai" });
    const url = new URL((check as { url: string }).url);
    expect([url.origin + url.pathname, url.searchParams.get("error"), url.searchParams.get("state"), url.searchParams.get("iss")]).toEqual([CLAUDE, error, "st-1", config.issuer]);
  }
  const ok = checkAuthorize(config, authorize(clientId));
  expect(ok).toMatchObject({ kind: "ok", request: { host: "claude.ai", scopes: ["read", "write"] } });
});

test("the person decides: refusing sends access_denied; allowing never grants more than asked", () => {
  const ctx = setup();
  const clientId = client();
  const check = checkAuthorize(config, authorize(clientId, { scope: "read" })) as { kind: "ok"; request: AuthorizeRequest };
  const denied = new URL(decideAuthorize(config, ctx, check.request, { allow: false }, NOW));
  expect([denied.searchParams.get("error"), denied.searchParams.get("code"), denied.searchParams.get("iss")]).toEqual(["access_denied", null, config.issuer]);
  // Asked for read only: choosing write on the page still gives read.
  const code = new URL(decideAuthorize(config, ctx, check.request, { allow: true, scope: "write" }, NOW)).searchParams.get("code")!;
  const answer = exchangeToken(config, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }), NOW);
  expect(answer.body).toMatchObject({ scope: "read" });
});

test("code → tokens: PKCE, same client and redirect, once; the token is an MCP token of the account, named and listed with its host", () => {
  const ctx = setup();
  const clientId = client();
  const code = approved(ctx, clientId).searchParams.get("code")!;
  const exchange = (fields: Record<string, string>) => exchangeToken(config, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE,
    code_verifier: verifier, ...fields }), NOW);
  expect(exchange({ client_id: "nope" })).toMatchObject({ status: 401, body: { error: "invalid_client" } });
  expect(exchange({ resource: "https://other.example/mcp" })).toMatchObject({ body: { error: "invalid_target" } });
  // A wrong verifier spends the code: an attacker who saw it gets one guess, then nothing.
  expect(exchange({ code_verifier: "w".repeat(50) })).toMatchObject({ body: { error: "invalid_grant" } });
  expect(exchange({})).toMatchObject({ body: { error: "invalid_grant" } });

  const fresh = approved(ctx, clientId).searchParams.get("code")!;
  const answer = exchangeToken(config, form({ grant_type: "authorization_code", code: fresh, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier,
    resource: config.resource }), NOW);
  expect(answer).toMatchObject({ status: 200, body: { token_type: "Bearer", expires_in: 3600, scope: "read write" } });
  const accessToken = answer.body.access_token as string;
  expect(mcpCallerFor(accessToken, NOW)).toMatchObject({ scopes: ["read", "write"], ctx: { workspaceId: ctx.workspaceId, authMethod: "mcp", via: "Claude" } });
  expect(listMcpTokens(ctx.workspaceId)).toEqual([expect.objectContaining({ label: "Claude", client: "claude.ai" })]);
  // Used once.
  expect(exchangeToken(config, form({ grant_type: "authorization_code", code: fresh, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }), NOW))
    .toMatchObject({ body: { error: "invalid_grant" } });
  // A code a minute old is dead.
  const late = approved(ctx, clientId).searchParams.get("code")!;
  expect(exchangeToken(config, form({ grant_type: "authorization_code", code: late, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }),
    new Date(NOW.getTime() + 61_000))).toMatchObject({ body: { error: "invalid_grant" } });
});

test("refresh: an hour's access, renewed with a refresh token that is replaced each time, only by its client, until revoked", () => {
  const ctx = setup();
  const clientId = client();
  const code = approved(ctx, clientId).searchParams.get("code")!;
  const first = exchangeToken(config, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }), NOW).body;
  const later = new Date(NOW.getTime() + 2 * 3600_000);
  expect(mcpCallerFor(first.access_token as string, later)).toBeUndefined();
  const refresh = (token: unknown, id = clientId, at = later) => exchangeToken(config, form({ grant_type: "refresh_token", refresh_token: String(token), client_id: id }), at);
  expect(refresh(first.refresh_token, client([CLAUDE], "Other"))).toMatchObject({ body: { error: "invalid_grant" } });
  const second = refresh(first.refresh_token).body;
  expect(second).toMatchObject({ token_type: "Bearer", scope: "read write" });
  expect(mcpCallerFor(second.access_token as string, later)).toBeDefined();
  // The old refresh token was replaced, with a minute's grace: a concurrent refresh, or a retry after a lost answer, gets the same new pair
  // (only from its own client); after that it is dead.
  expect(refresh(first.refresh_token).body).toEqual(second);
  expect(refresh(first.refresh_token, client([CLAUDE], "Other"))).toMatchObject({ body: { error: "invalid_grant" } });
  expect(refresh(first.refresh_token, clientId, new Date(later.getTime() + 61_000))).toMatchObject({ body: { error: "invalid_grant" } });
  // Narrowing on refresh is allowed, widening is not possible.
  const narrowed = exchangeToken(config, form({ grant_type: "refresh_token", refresh_token: String(second.refresh_token), client_id: clientId, scope: "read" }), later).body;
  expect(narrowed).toMatchObject({ scope: "read" });
  // The access token it replaced keeps working until its own hour is up, so requests already on their way do not fail.
  expect(mcpCallerFor(second.access_token as string, new Date(later.getTime() + 3599_000))).toBeDefined();
  expect(mcpCallerFor(second.access_token as string, new Date(later.getTime() + 3601_000))).toBeUndefined();
  // Revoked on the settings card: no token works any more, the grace included.
  revokeMcpToken(ctx.workspaceId, listMcpTokens(ctx.workspaceId)[0]!.id);
  expect(mcpCallerFor(narrowed.access_token as string, later)).toBeUndefined();
  expect(mcpCallerFor(second.access_token as string, later)).toBeUndefined();
  expect(refresh(narrowed.refresh_token)).toMatchObject({ body: { error: "invalid_grant" } });
  expect(refresh(second.refresh_token)).toMatchObject({ body: { error: "invalid_grant" } });
  // Thirty days unused: the refresh token is dead.
  const code2 = approved(ctx, clientId).searchParams.get("code")!;
  const again = exchangeToken(config, form({ grant_type: "authorization_code", code: code2, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }), NOW).body;
  expect(refresh(again.refresh_token, clientId, new Date(NOW.getTime() + 31 * 86_400_000))).toMatchObject({ body: { error: "invalid_grant" } });
  expect(exchangeToken(config, form({ grant_type: "password", client_id: clientId }), NOW)).toMatchObject({ body: { error: "unsupported_grant_type" } });
});

test("a full list refuses a new connection: the person revokes one first", () => {
  const ctx = setup();
  for (let index = 0; index < MCP_TOKENS_MAX; index += 1) issueMcpToken(ctx, { label: `t${index}`, scope: "read" }, NOW);
  // The consent page says so before the person is sent back to the other AI.
  expect(mcpTokensFull(ctx.workspaceId, NOW)).toBe(true);
  const clientId = client();
  const code = approved(ctx, clientId).searchParams.get("code")!;
  expect(exchangeToken(config, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }), NOW))
    .toMatchObject({ body: { error: "invalid_grant" } });
});

function connect(ctx: typeof TEST_CTX, clientId: string, label?: string) {
  const check = checkAuthorize(config, authorize(clientId));
  if (check.kind !== "ok") throw new Error(check.kind);
  const code = new URL(decideAuthorize(config, ctx, check.request, { allow: true, scope: "write", ...(label ? { label } : {}) }, NOW)).searchParams.get("code")!;
  return exchangeToken(config, form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }), NOW).body;
}

test("reconnecting replaces the connection of the same name from the same address; another name keeps both", () => {
  const ctx = setup();
  // claude.ai registers a new client for every fresh connection.
  const old = connect(ctx, client());
  const again = connect(ctx, client());
  expect(listMcpTokens(ctx.workspaceId)).toMatchObject([{ label: "Claude", client: "claude.ai" }]);
  expect(mcpCallerFor(old.access_token as string, NOW)).toBeUndefined();
  expect(mcpCallerFor(again.access_token as string, NOW)).toBeDefined();
  connect(ctx, client(), "Claude 工作");
  expect(listMcpTokens(ctx.workspaceId).map((token) => token.label).sort()).toEqual(["Claude", "Claude 工作"]);
});

test("a full list still lets a connection be replaced", () => {
  const ctx = setup();
  for (let index = 0; index < MCP_TOKENS_MAX - 1; index += 1) issueMcpToken(ctx, { label: `t${index}`, scope: "read" }, NOW);
  connect(ctx, client());
  expect(mcpTokensFull(ctx.workspaceId, NOW)).toBe(true);
  expect(mcpTokensFull(ctx.workspaceId, NOW, { client: "claude.ai", label: "Claude" })).toBe(false);
  expect(mcpTokensFull(ctx.workspaceId, NOW, { client: "claude.ai", label: "其他" })).toBe(true);
  expect(connect(ctx, client())).toHaveProperty("access_token");
  expect(listMcpTokens(ctx.workspaceId)).toHaveLength(MCP_TOKENS_MAX);
});
