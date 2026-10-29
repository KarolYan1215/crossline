import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { answerWrapBlock, finishWrap, type WrapOutcome } from "../../../lib/wrap";
import { isCrossSiteWrite } from "../../../lib/same-origin";

const OUTCOMES = new Set<WrapOutcome>(["done", "partial", "not_done"]);

/**
 * The evening wrap-up (docs/rituals.md): `{blockId, outcome: "done" | "partial" | "not_done"}` answers one of today's blocks the way its
 * completion check would; `day` (`YYYY-MM-DD`, within the last seven days) answers a block of that earlier day instead of today's;
 * `{finish: true}` is 「收工」, after which no wrap-up message comes tonight.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { blockId?: unknown; outcome?: unknown; finish?: unknown; day?: unknown } | null;
  if (body?.finish === true) return NextResponse.json(finishWrap(access.ctx));
  if (typeof body?.blockId !== "string" || body.blockId.length > 300 || !OUTCOMES.has(body.outcome as WrapOutcome))
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  if (body.day !== undefined && (typeof body.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)))
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const result = answerWrapBlock(access.ctx, body.blockId, body.outcome as WrapOutcome, undefined, typeof body.day === "string" ? body.day : undefined);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "CONFIRM_NOT_FOUND" ? 404 : 400 });
}
