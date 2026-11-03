import { resolveAccessContext } from "../../../../../lib/access-guard";
import { approvePairing } from "../../../../../lib/node-pairing";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/**
 * `{code}` typed on the 「这台电脑」 card shows that computer and what it would receive; `{code, confirm: true}` makes it this account's
 * compute node (docs/compute-node.md).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { code?: unknown; confirm?: unknown };
  const approved = approvePairing(access.ctx.workspaceId, typeof body.code === "string" ? body.code : "", body.confirm === true);
  return Response.json(approved, { status: approved.ok ? 200 : approved.code === "NODE_PAIR_LIMIT" ? 429 : 404 });
}
