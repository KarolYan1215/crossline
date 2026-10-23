import { resolveAccessContext } from "../../../../../lib/access-guard";
import { approvePairing } from "../../../../../lib/node-pairing";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/** `{code}` typed on the 「这台电脑」 card: that computer becomes this account's compute node (docs/compute-node.md). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { code?: unknown };
  const approved = approvePairing(access.ctx.workspaceId, typeof body.code === "string" ? body.code : "");
  return Response.json(approved, { status: approved.ok ? 200 : approved.code === "NODE_OWNER_ONLY" ? 403 : 404 });
}
