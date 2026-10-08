import { saveGoalSettings } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { withUndo } from "../../../../lib/undo";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) ?? {};
  const result = await withUndo(access.ctx, "修改里程碑设置", () => saveGoalSettings(access.ctx, id, body));
  return Response.json(result, { status: result.ok ? 200 : result.code === "GOAL_NOT_APPROVED" ? 404 : 400 });
}
