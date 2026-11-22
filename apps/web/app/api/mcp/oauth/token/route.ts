import { exchangeToken, oauthConfig } from "../../../../../lib/mcp/oauth";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/** The OAuth token endpoint (docs/mcp-server.md §4.3): a form body, as RFC 6749 §4.1.3 has it. */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // The hosts call this from their servers (no Origin); another site's page in a browser has no business here.
  if (isCrossSiteWrite(request)) return Response.json({ error: "invalid_request", error_description: "cross-site request" }, { status: 403 });
  const config = oauthConfig();
  if (!config) return Response.json({ error: "not_found" }, { status: 404 });
  const form = new URLSearchParams(await request.text().catch(() => ""));
  const answer = exchangeToken(config, form);
  return Response.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store", pragma: "no-cache" } });
}
