import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { issueMcpToken, listMcpTokens, revokeMcpToken } from "../../../../lib/mcp/tokens";

/**
 * The person's MCP tokens (docs/mcp-server.md §4), managed from Settings with their own session — never with an MCP token, so an agent
 * cannot make itself another token or widen its own scope. GET lists them (never the token), POST `{label, scope}` makes one and returns
 * it once, DELETE `?id=` revokes one.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (access.ctx.authMethod !== "session") return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  return Response.json({ ok: true, tokens: listMcpTokens(access.ctx.workspaceId) });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (access.ctx.authMethod !== "session") return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { label?: unknown; scope?: unknown };
  const result = issueMcpToken(access.ctx, body);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (access.ctx.authMethod !== "session") return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return revokeMcpToken(access.ctx.workspaceId, id) ? Response.json({ ok: true }) : Response.json({ ok: false, code: "MCP_TOKEN_NOT_FOUND" }, { status: 404 });
}
