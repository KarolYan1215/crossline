import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { answerWrapBlock, finishWrap, type WrapOutcome } from "../../../lib/wrap";
import { isCrossSiteWrite } from "../../../lib/same-origin";

const OUTCOMES = new Set<WrapOutcome>(["done", "partial", "not_done"]);

/**
 * The evening wrap-up (docs/rituals.md): `{blockId, outcome: "done" | "partial" | "not_done"}` answers one of today's blocks the way its
 * completion check would; `{finish: true}` is 「收工」, after which no wrap-up message comes tonight.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { blockId?: unknown; outcome?: unknown; finish?: unknown } | null;
  if (body?.finish === true) return NextResponse.json(finishWrap(access.ctx));
  if (typeof body?.blockId !== "string" || body.blockId.length > 300 || !OUTCOMES.has(body.outcome as WrapOutcome))
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const result = answerWrapBlock(access.ctx, body.blockId, body.outcome as WrapOutcome);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "CONFIRM_NOT_FOUND" ? 404 : 400 });
}
