import { resolveAccessContext } from "../../../../lib/access-guard";
import { pollPairing, startPairing, unpairNode } from "../../../../lib/node-pairing";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The standalone compute node's pairing (docs/compute-node.md). POST and GET are the program's, with no account: POST `{host}` asks for
 * a code (and the secret id to ask about it with), GET `?id=` asks whether the person approved it and, once, takes the node's token.
 * DELETE is the person's (解除配对 on the 「这台电脑」 card).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { host?: unknown };
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const started = startPairing(address, typeof body.host === "string" ? body.host : "");
  return Response.json(started, { status: started.ok ? 200 : 429 });
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return Response.json({ state: "expired" }, { status: 400 });
  return Response.json(pollPairing(id), { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  unpairNode(access.ctx.workspaceId);
  return Response.json({ ok: true });
}
