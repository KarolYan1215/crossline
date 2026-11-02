import { serviceProxy } from "../../../../../lib/service-proxy";
import { validId, writeGuard } from "../../../agent/guard";

const ACTIONS = new Set(["continue", "front", "stop", "confirm", "submitted"]);

/** 继续 (after the person handled a stop), 显示窗口, 停止, 已收到确认, 我已提交 — on one form run. */
export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id, action } = await context.params;
  if (!validId(id) || !ACTIONS.has(action)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/forms/${id}/${action}`, { method: "POST", body: {} });
}
