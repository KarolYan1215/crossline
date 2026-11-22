import { oauthConfig, protectedResourceMetadata } from "../../../lib/mcp/oauth";

/** Protected Resource Metadata for `/api/mcp` (RFC 9728; docs/mcp-server.md §4.3): where an MCP host learns how to sign in. */
export const dynamic = "force-dynamic";

export function GET() {
  const config = oauthConfig();
  if (!config) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(protectedResourceMetadata(config), { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
}
