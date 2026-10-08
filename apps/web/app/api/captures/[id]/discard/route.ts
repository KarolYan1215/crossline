import { discardCapture } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { titleOf, withUndo } from "../../../../../lib/undo";

/** Throws away a raw capture, with the reason (optional) on the record. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return Response.json({ ok: false, code: "CAPTURE_NOT_FOUND" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const result = await withUndo(access.ctx, `丢弃：${titleOf(access.ctx, id)}`, () => discardCapture(access.ctx, id, String(body.reason ?? "")));
  if (result.ok) return Response.json(result);
  const status = result.code === "CAPTURE_NOT_FOUND" ? 404
    : 409;
  return Response.json(result, { status });
}
