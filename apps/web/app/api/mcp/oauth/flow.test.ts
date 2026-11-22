import { afterEach, expect, test, vi } from "vitest";
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider, type OAuthClientMetadata } from "@modelcontextprotocol/client";
import { CrosslineStore } from "@crossline/db";
import type { AccessContext } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("../../../../lib/codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
let SESSION: AccessContext | undefined;
vi.mock("../../../../lib/access-guard", () => ({
  resolveAccessContext: vi.fn(async () => SESSION ? { ctx: SESSION } : { response: Response.json({ ok: false, code: "UNAUTHENTICATED" }, { status: 401 }) })
}));
import * as mcp from "../route";
import * as register from "./register/route";
import * as token from "./token/route";
import * as consent from "./consent/route";
import * as resourceMetadata from "../../../.well-known/oauth-protected-resource/route";
import * as resourceMetadataAtPath from "../../../.well-known/oauth-protected-resource/api/mcp/route";
import * as serverMetadata from "../../../.well-known/oauth-authorization-server/route";
import { listMcpTokens, resetMcpRateLimits } from "../../../../lib/mcp/tokens";
import { TEST_CTX } from "../../../../lib/test-support";

/**
 * The OAuth sign-in as claude.ai or ChatGPT does it (docs/mcp-server.md §4.3), with the MCP SDK's own OAuth client: from a 401 on
 * `/api/mcp`, discovery, registration, the consent page's answer (the person, signed in, presses 允许), the code exchange with the `iss`
 * check, the tools, and a refresh. Every request goes to this site's route handlers.
 */
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; globalThis.crosslineMcpCodes = undefined; SESSION = undefined;
  resetMcpRateLimits(); vi.unstubAllEnvs(); });

const BASE = "http://localhost:3210";
const CALLBACK = "http://localhost:4567/callback";

function setup() {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-not-real");
  vi.stubEnv("CROSSLINE_WEB_BASE_URL", BASE);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { principal, workspace } = store.createPrincipalWithWorkspace("owner", "个人");
  return { ...TEST_CTX, principalId: principal.id, workspaceId: workspace.id, authMethod: "session" as const };
}

const seen: string[] = [];
/** fetch → this site's handlers by path, as Next would route them. */
async function site(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  seen.push(`${request.method} ${pathname}`);
  if (pathname === "/.well-known/oauth-protected-resource/api/mcp") return resourceMetadataAtPath.GET();
  if (pathname === "/.well-known/oauth-protected-resource") return resourceMetadata.GET();
  if (pathname === "/.well-known/oauth-authorization-server") return serverMetadata.GET();
  if (pathname === "/api/mcp/oauth/register") return register.POST(request);
  if (pathname === "/api/mcp/oauth/token") return token.POST(request);
  if (pathname === "/api/mcp") return request.method === "POST" ? mcp.POST(request) : request.method === "DELETE" ? mcp.DELETE(request) : mcp.GET(request);
  return new Response("not found", { status: 404 });
}

/** The person on the consent page: what the page posts when 允许 (or 拒绝) is pressed, and where the browser goes next. */
async function personAnswers(authorizationUrl: URL, allow: boolean, scope: "read" | "write" = "write") {
  expect(authorizationUrl.pathname).toBe("/mcp/authorize");
  const response = await consent.POST(new Request(`${BASE}/api/mcp/oauth/consent`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "localhost:3210" },
    body: JSON.stringify({ query: authorizationUrl.searchParams.toString(), allow, scope, label: "Claude" }) }));
  const body = await response.json() as { ok: boolean; redirect: string };
  expect(body.ok).toBe(true);
  return new URL(body.redirect);
}

function provider(onRedirect: (url: URL) => void): OAuthClientProvider {
  let client: unknown, tokens: unknown, verifier = "";
  const metadata: OAuthClientMetadata = { client_name: "Claude", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    token_endpoint_auth_method: "none" };
  return {
    get redirectUrl() { return CALLBACK; },
    get clientMetadata() { return metadata; },
    clientInformation: () => client as never,
    saveClientInformation: (info) => { client = info; },
    tokens: () => tokens as never,
    saveTokens: (next) => { tokens = next; },
    redirectToAuthorization: (url) => onRedirect(url),
    saveCodeVerifier: (next) => { verifier = next; },
    codeVerifier: () => verifier
  };
}

const transportFor = (auth: OAuthClientProvider) => new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { fetch: site, authProvider: auth });

test("claude.ai's path: 401 → discovery → registration → consent → code with iss → tools → the connection on the settings card", async () => {
  const ctx = setup();
  seen.length = 0;
  let authorizationUrl: URL | undefined;
  const auth = provider((url) => { authorizationUrl = url; });
  const first = new Client({ name: "claude-ai", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = transportFor(auth);
  await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  // The 401's `resource_metadata` is followed; the path-suffixed address (tried by hosts without it) serves the same document.
  expect(seen).toEqual(["POST /api/mcp", "GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-authorization-server", "POST /api/mcp/oauth/register"]);
  expect(await resourceMetadataAtPath.GET().json()).toEqual(await resourceMetadata.GET().json());
  expect(authorizationUrl!.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorizationUrl!.searchParams.get("resource")).toBe(`${BASE}/api/mcp`);

  // Not signed in to Crossline: the consent page's answer is refused; the page itself sends the person to sign in first.
  expect((await consent.POST(new Request(`${BASE}/api/mcp/oauth/consent`, { method: "POST", body: "{}" }))).status).toBe(401);
  SESSION = ctx;
  const callback = await personAnswers(authorizationUrl!, true);
  expect(callback.origin + callback.pathname).toBe(CALLBACK);
  expect(callback.searchParams.get("iss")).toBe(BASE);
  // The SDK checks `iss` against the issuer it discovered (RFC 9207) before it exchanges the code.
  await transport.finishAuth(callback.searchParams);

  const client = new Client({ name: "claude-ai", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transportFor(auth));
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toContain("crossline_capture");
  const captured = await client.callTool({ name: "crossline_capture", arguments: { text: "问导师要数据" } });
  expect(captured.isError).toBeFalsy();
  const recorded = globalThis.crosslineStore!.listEvents(ctx.workspaceId, { type: "capture.created" }).at(-1)?.payload;
  expect(recorded).toMatchObject({ via: "mcp", agent: "Claude" });
  expect(listMcpTokens(ctx.workspaceId)).toEqual([expect.objectContaining({ label: "Claude", client: "localhost:4567", scopes: ["read", "write"] })]);
  await client.close();

  // An expired access token: the SDK renews it with the refresh token and carries on.
  const stored = JSON.parse(globalThis.crosslineStore!.getSetting(ctx.workspaceId, "mcp.tokens")!) as Array<{ oauth: { expiresAt: string } }>;
  stored[0]!.oauth.expiresAt = new Date(Date.now() - 1000).toISOString();
  globalThis.crosslineStore!.setSetting(ctx.workspaceId, "mcp.tokens", JSON.stringify(stored));
  seen.length = 0;
  const renewed = new Client({ name: "claude-ai", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await renewed.connect(transportFor(auth));
  expect(seen).toContain("POST /api/mcp/oauth/token");
  expect((await renewed.callTool({ name: "crossline_today", arguments: {} })).isError).toBeFalsy();
  await renewed.close();
});

test("ChatGPT's path with read only, and a refusal: the person's choice is what the AI gets", async () => {
  const ctx = setup();
  SESSION = ctx;
  let authorizationUrl: URL | undefined;
  const auth = provider((url) => { authorizationUrl = url; });
  const transport = transportFor(auth);
  await expect(new Client({ name: "chatgpt", version: "1.0.0" }).connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

  // A wrong request is not sent back anywhere from here either: registration is open, so its address proves nothing.
  const wrong = new URL(authorizationUrl!);
  wrong.searchParams.set("response_type", "token");
  const invalid = await consent.POST(new Request(`${BASE}/api/mcp/oauth/consent`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, host: "localhost:3210" },
    body: JSON.stringify({ query: wrong.searchParams.toString(), allow: true, scope: "read" }) }));
  expect([invalid.status, await invalid.json()]).toEqual([400, { ok: false, code: "OAUTH_REQUEST_INVALID" }]);

  const refused = await personAnswers(authorizationUrl!, false);
  expect(refused.searchParams.get("error")).toBe("access_denied");
  expect(listMcpTokens(ctx.workspaceId)).toEqual([]);

  await transport.finishAuth((await personAnswers(authorizationUrl!, true, "read")).searchParams);
  const client = new Client({ name: "chatgpt", version: "1.0.0" });
  await client.connect(transportFor(auth));
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["crossline_list_asks", "crossline_list_tasks", "crossline_today"]);
  await client.close();
});

test("no token: the 401 names where signing in starts; a cross-site answer to the consent page is refused", async () => {
  const ctx = setup();
  SESSION = ctx;
  const response = await mcp.POST(new Request(`${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  const crossSite = await consent.POST(new Request(`${BASE}/api/mcp/oauth/consent`, { method: "POST", headers: { origin: "https://evil.example", host: "localhost:3210" }, body: "{}" }));
  expect(crossSite.status).toBe(403);
});
