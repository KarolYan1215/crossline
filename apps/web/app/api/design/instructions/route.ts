import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { tOf } from "../../../../lib/locale";
import { withUndo } from "../../../../lib/undo";
import { applyInstructions, describeInstructionsChange, instructionsView } from "../../../../lib/instructions";

/** Settings → 我的设计 → 给 Crossline 的话: the text in force and every version, newest first. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...instructionsView(access.ctx) });
}

/**
 * `{text, preview: true}` returns the before/after and changes nothing; `{text}` saves it as a new version; `{revertTo: n}` writes version
 * n's text again as a new version (0 = empty). Both are undoable.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { text?: unknown; preview?: unknown; revertTo?: unknown } | null;
  const t = tOf(access.ctx);
  if (typeof body?.revertTo === "number" && Number.isInteger(body.revertTo) && body.revertTo >= 0) {
    const revertTo = body.revertTo;
    const result = await withUndo(access.ctx, t("恢复「给 Crossline 的话」到第 {{version}} 版", { version: revertTo }), () => applyInstructions(access.ctx, { revertTo }));
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }
  if (typeof body?.text !== "string") return NextResponse.json({ ok: false, code: "INSTRUCTIONS_ARGS_INVALID" }, { status: 400 });
  const text = body.text;
  if (body.preview === true) return NextResponse.json({ ok: true, view: describeInstructionsChange(access.ctx, text) });
  const result = await withUndo(access.ctx, t("修改「给 Crossline 的话」"), () => applyInstructions(access.ctx, { text, by: "person" }));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
