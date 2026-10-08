import { restoreCapture, restoreWorkOrder } from "../../../lib/crossline";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { titleOf, withUndo } from "../../../lib/undo";

/** Takes an archived task or a discarded capture back to where it was (恢复 in the archive drawer). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown };
  const id = String(body.id ?? "");
  if (!/^[a-zA-Z0-9_:#-]{1,160}$/.test(id)) return Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404 });
  const result = await withUndo(access.ctx, `恢复：${titleOf(access.ctx, id)}`, () => body.kind === "capture" ? restoreCapture(access.ctx, id) : restoreWorkOrder(access.ctx, id));
  if (result.ok) return Response.json(result);
  return Response.json(result, { status: /NOT_FOUND/.test(result.code) ? 404 : 409 });
}
