import { authorizationServerMetadata, oauthConfig } from "../../../lib/mcp/oauth";

/** Authorization Server Metadata (RFC 8414; docs/mcp-server.md §4.3). */
export const dynamic = "force-dynamic";

export function GET() {
  const config = oauthConfig();
  if (!config) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(authorizationServerMetadata(config), { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
}
