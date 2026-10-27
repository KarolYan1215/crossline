import { resolveAccessContext } from "../../../../lib/access-guard";
import { computeNodeStatus, setComputeNode } from "../../../../lib/device";
import { pairedNode } from "../../../../lib/node-pairing";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** 「作为算力节点」 on the hosted 「这台电脑」 card (docs/compute-node.md): whether this account may, whether it is on, what the node did last. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, ...computeNodeStatus(access.ctx.workspaceId), paired: pairedNode(access.ctx.workspaceId) });
}

/** `{enabled}`: switched on, the site accepts this account's computer as the runtime for its model runs; off, it lets it go. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { enabled?: unknown };
  const view = setComputeNode(access.ctx.workspaceId, body.enabled === true);
  if (!view.available) return Response.json({ ok: false, code: "NODE_OWNER_ONLY", message: tOf(access.ctx)("只有这台服务器运行时的主人账号可以开启。") }, { status: 403 });
  return Response.json({ ok: true, ...view });
}
