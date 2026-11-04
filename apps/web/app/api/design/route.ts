import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { tOf } from "../../../lib/locale";
import { withUndo } from "../../../lib/undo";
import { applyDesignChange, describeDesignChange, designProblem, noteSkillIds, pauseDesignEntry } from "../../../lib/personal-design";

/**
 * Settings → 我的设计. `{preview: true, kind, id, value}` returns 当前 → 改成 and changes nothing; the same without `preview` saves it
 * (undoable); `{pause: boolean, kind, id}` pauses or resumes an entry. An empty value resets a knob or removes a note.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { kind?: unknown; id?: unknown; value?: unknown; preview?: unknown; pause?: unknown } | null;
  const kind = body?.kind === "skill" ? "skill" : body?.kind === "knob" ? "knob" : undefined;
  if (!kind || typeof body?.id !== "string") return NextResponse.json({ ok: false, code: "DESIGN_ARGS_INVALID" }, { status: 400 });
  const t = tOf(access.ctx);
  if (typeof body.pause === "boolean") {
    const pause = body.pause;
    const result = await withUndo(access.ctx, t(pause ? "暂停我的设计中的一项" : "恢复我的设计中的一项"), () => pauseDesignEntry(access.ctx, kind, String(body.id), pause));
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }
  const args = { kind, id: body.id, value: typeof body.value === "string" ? body.value : "" } as const;
  const problem = designProblem(args, noteSkillIds());
  if (problem) return NextResponse.json({ ok: false, code: problem.split("：")[0], message: problem }, { status: 400 });
  if (body.preview === true) return NextResponse.json({ ok: true, view: describeDesignChange(access.ctx, args) });
  const result = await withUndo(access.ctx, t("修改我的设计"), () => applyDesignChange(access.ctx, args));
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
