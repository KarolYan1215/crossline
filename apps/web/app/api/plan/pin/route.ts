import { resolveAccessContext } from "../../../../lib/access-guard";
import { pinBlock } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { withUndo } from "../../../../lib/undo";

/** `{blockId, day, start, end}`: a pencilled-in (off-hours) block the person starts becomes formal at that time. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { blockId?: unknown; day?: unknown; start?: unknown; end?: unknown };
  const result = await withUndo(access.ctx, "转为正式排程", () => pinBlock(access.ctx, String(body.blockId ?? ""),
    { day: String(body.day ?? ""), start: String(body.start ?? ""), end: String(body.end ?? "") }));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
