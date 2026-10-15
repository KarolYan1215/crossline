import { saveDraftSettings } from "../../../../../lib/milestone-board";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { withUndo } from "../../../../../lib/undo";

/**
 * A draft milestone's deadline and importance, edited in place on 主线 before it is approved (`{deadline?, weight?}`); an approved one's
 * go through `/api/goals/[id]`. The weight waits beside the draft and becomes its goal setting on approval.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { deadline?: unknown; weight?: unknown } | null;
  const result = await withUndo(access.ctx, "修改里程碑草稿", () => saveDraftSettings(access.ctx, id, { deadline: body?.deadline, weight: body?.weight }));
  return Response.json(result, { status: result.ok ? 200 : result.code === "MILESTONE_NOT_DRAFT" ? 404 : 400 });
}
