import { saveGoalSettings } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) ?? {};
  const result = saveGoalSettings(id, body);
  return Response.json(result, { status: result.ok ? 200 : result.code === "GOAL_NOT_APPROVED" ? 404 : 400 });
}
