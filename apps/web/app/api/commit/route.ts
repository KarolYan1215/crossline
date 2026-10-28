import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { applyWeeklyCommit, previewWeeklyCommit } from "../../../lib/weekly-commit";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { withUndo } from "../../../lib/undo";
import { tOf } from "../../../lib/locale";

/**
 * The weekly commitment (docs/rituals.md): `{action: "preview" | "apply" | "keep", groups: {[taskId]: "keep" | "defer" | "drop"}}`. A row
 * not named keeps its suggestion. 「确认本周」 (`apply`) and 「这周不调整」 (`keep`) are one undoable operation each; `preview` writes nothing.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { action?: unknown; groups?: unknown } | null;
  const groups = body?.groups && typeof body.groups === "object" && !Array.isArray(body.groups) ? body.groups as Record<string, unknown> : {};
  if (Object.keys(groups).length > 500) return NextResponse.json({ ok: false, code: "COMMIT_GROUP_INVALID" }, { status: 400 });
  if (body?.action === "preview") {
    const result = await previewWeeklyCommit(access.ctx, groups);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }
  if (body?.action !== "apply" && body?.action !== "keep") return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const t = tOf(access.ctx);
  const keepAll = body.action === "keep";
  const result = await withUndo(access.ctx, t(keepAll ? "本周不调整" : "确认本周承诺"), () => applyWeeklyCommit(access.ctx, groups, { keepAll }));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
