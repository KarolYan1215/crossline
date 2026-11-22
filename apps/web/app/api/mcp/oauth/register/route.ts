import { oauthConfig, registerClient } from "../../../../../lib/mcp/oauth";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/**
 * Dynamic client registration (RFC 7591; docs/mcp-server.md §4.3). Open to anyone, as the spec has it, and harmless: it stores nothing and
 * grants nothing; a client id only lets a sign-in reach the consent page, where the person decides.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // The hosts call this from their servers (no Origin); another site's page in a browser has no business here.
  if (isCrossSiteWrite(request)) return Response.json({ error: "invalid_request", error_description: "cross-site request" }, { status: 403 });
  const config = oauthConfig();
  if (!config) return Response.json({ error: "not_found" }, { status: 404 });
  const body = await request.json().catch(() => undefined) as unknown;
  const result = registerClient(config, body);
  return Response.json(result.ok ? result.response : result.error, { status: result.ok ? 201 : 400, headers: { "cache-control": "no-store" } });
}
