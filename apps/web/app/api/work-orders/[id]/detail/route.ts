import { resolveAccessContext } from "../../../../../lib/access-guard";
import { loadTaskDetail } from "../../../../../lib/task-detail";

/**
 * One task's detail, for the day panel on Today when the person picks a block whose task was not read with the page (a block on a day
 * other than the coming week's). Read-only; the same `TaskDetail` the task card and dialog render.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (!/^[a-zA-Z0-9:_.-]{1,200}$/.test(id)) return Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  const detail = loadTaskDetail(access.ctx, id);
  if (!detail) return Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  return Response.json({ ok: true, detail });
}
