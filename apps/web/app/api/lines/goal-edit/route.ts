import { resolveAccessContext } from "../../../../lib/access-guard";
import { decideGoalEdit } from "../../../../lib/line-cards";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { withUndo } from "../../../../lib/undo";

/**
 * `{lineId, decision: "adopt" | "dismiss"}`: the person's answer to a change of a line's long-term goal they asked for in the interview
 * (「把目标改成…」). The interview never applies such a change itself; this is the click that does (undoable).
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { lineId?: unknown; decision?: unknown };
  if (typeof body.lineId !== "string" || (body.decision !== "adopt" && body.decision !== "dismiss")) {
    return Response.json({ ok: false, code: "GOAL_EDIT_INVALID", message: "缺少主线或决定" }, { status: 400 });
  }
  const decision = body.decision;
  const result = await withUndo(access.ctx, decision === "adopt" ? "采用访谈中的长期目标修改" : "不改长期目标", () => decideGoalEdit(access.ctx, body.lineId as string, decision));
  return Response.json(result, { status: result.ok ? 200 : result.code === "GOAL_EDIT_NOT_FOUND" ? 404 : 400 });
}
