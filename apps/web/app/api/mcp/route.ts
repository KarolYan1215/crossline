import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { mcpCallerFor, type McpCaller } from "../../../lib/mcp/tokens";
import { buildMcpServer } from "../../../lib/mcp/server";
import { oauthConfig, resourceChallenge } from "../../../lib/mcp/oauth";

/**
 * Crossline's MCP endpoint (docs/mcp-server.md): Streamable HTTP, stateless, for the protocol revision 2026-07-28 and, through the SDK's
 * stateless fallback, for 2025-era clients. A bearer token is the only way in: one made in Settings → 日历与连接 → 在其他 AI 里用 Crossline,
 * or one an OAuth sign-in issued (§4.3; the 401 says where that starts). A browser session is not (another site's page must never be able
 * to drive this with the person's cookie), and a request from another site's page is refused before the token is read, as the spec
 * requires of `Origin`.
 */
export const dynamic = "force-dynamic";

const CALLER = "crossline.caller";

// One handler for the process: each request gets a fresh server built for the token's caller, carried in `authInfo.extra`.
const handler = createMcpHandler((request) => {
  const caller = request.authInfo?.extra?.[CALLER] as McpCaller | undefined;
  if (!caller) throw new Error("MCP_CALLER_MISSING");
  return buildMcpServer(caller);
}, { responseMode: "json", maxRequestBodySize: 256 * 1024 });

// No token: the challenge alone, so a host starts signing in; a token that is not (or no longer) valid: `invalid_token` too (RFC 6750 §3.1).
function unauthorized(error?: "invalid_token") {
  const config = oauthConfig();
  const challenge = config ? resourceChallenge(config, error) : `Bearer realm="crossline"${error ? `, error="${error}"` : ""}`;
  return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "A Crossline MCP token is required: sign in, or make one in Crossline's Settings." }, id: null },
    { status: 401, headers: { "WWW-Authenticate": challenge } });
}

async function serve(request: Request): Promise<Response> {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const caller = token ? mcpCallerFor(token) : undefined;
  if (!token) return unauthorized();
  if (!caller) return unauthorized("invalid_token");
  const authInfo: AuthInfo = { token: caller.tokenId, clientId: caller.ctx.via ?? "mcp", scopes: caller.scopes, extra: { [CALLER]: caller } };
  return handler.fetch(request, { authInfo });
}

export const POST = serve;
export const GET = serve;
export const DELETE = serve;
