import type { McpScope } from "@crossline/core";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { checkAuthorize, decideAuthorize, oauthConfig } from "../../../../../lib/mcp/oauth";
import { mcpTokensFull } from "../../../../../lib/mcp/tokens";

/**
 * The person's answer on the consent page (`/mcp/authorize`, docs/mcp-server.md §4.3): the authorization request is checked again here,
 * from its own parameters, and only a browser session of this site can answer it. Returns where to send the browser (the client's redirect
 * URI with a code, or with `access_denied`); the page navigates there itself, since the site's `form-action 'self'` would stop a form
 * that redirects to another site.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const config = oauthConfig();
  if (!config) return Response.json({ ok: false, code: "OAUTH_OFF" }, { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (access.ctx.authMethod !== "session") return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { query?: unknown; allow?: unknown; scope?: unknown; label?: unknown };
  const check = checkAuthorize(config, new URLSearchParams(typeof body.query === "string" ? body.query : ""));
  if (check.kind === "fatal") return Response.json({ ok: false, code: check.code }, { status: 400 });
  if (check.kind === "redirect") return Response.json({ ok: true, redirect: check.url });
  // Said here, where the person can act on it, rather than as a failed sign-in in the other AI.
  if (body.allow === true && mcpTokensFull(access.ctx.workspaceId)) return Response.json({ ok: false, code: "MCP_TOKENS_FULL" }, { status: 409 });
  const redirect = decideAuthorize(config, access.ctx, check.request, { allow: body.allow === true,
    ...(body.scope === "read" || body.scope === "write" ? { scope: body.scope as McpScope } : {}), ...(typeof body.label === "string" ? { label: body.label } : {}) });
  return Response.json({ ok: true, redirect });
}
