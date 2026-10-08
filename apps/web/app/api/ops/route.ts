import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { recentOps, undoOp } from "../../../lib/undo";

/** The person's operations of the last 24 hours that can still be undone, newest first. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, ops: recentOps(access.ctx).map((op) => ({ id: op.id, label: op.label, at: op.at })) });
}

/** `{id}`: undoes that operation. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = String(body.id ?? "");
  if (!/^op-[a-z0-9-]{1,40}$/.test(id)) return Response.json({ ok: false, code: "OP_NOT_UNDOABLE" }, { status: 404 });
  const result = undoOp(access.ctx, id);
  return Response.json(result, { status: result.ok ? 200 : result.code === "OP_NOT_UNDOABLE" ? 404 : 409 });
}
