import { resolveAccessContext } from "../../../../lib/access-guard";
import { lockBlock, unlockBlock } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { withUndo } from "../../../../lib/undo";

/**
 * `{blockId, day, start, end, reason?}`: locks one block at its time — started (`pinned`, the default) or locked by the button
 * (`locked`). A pencilled-in (`optional:`) block becomes the same-numbered scheduled block.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { blockId?: unknown; day?: unknown; start?: unknown; end?: unknown; reason?: unknown; overlapOk?: unknown };
  const reason = body.reason === "locked" ? "locked" : "pinned";
  const result = await withUndo(access.ctx, reason === "locked" ? "锁定时间块" : "转为正式排程", () => lockBlock(access.ctx, String(body.blockId ?? ""),
    { day: String(body.day ?? ""), start: String(body.start ?? ""), end: String(body.end ?? "") }, reason, { overlapOk: body.overlapOk === true }));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}

/** `{blockId}`: unlocks the block; the scheduler places it again. */
export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { blockId?: unknown };
  const blockId = String(body.blockId ?? "");
  if (!/^(scheduled|optional):/.test(blockId)) return Response.json({ ok: false, code: "PIN_INVALID" }, { status: 400 });
  const result = await withUndo(access.ctx, "解除锁定", () => unlockBlock(access.ctx, blockId));
  return Response.json(result);
}
