import { serviceProxy } from "../../../../lib/service-proxy";
import { validId, writeGuard } from "../../agent/guard";

/** Deletes an automation. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/automations/${id}`, { method: "DELETE" });
}

/** `{ action: "run" }` runs it now; `{ action: "pause" | "resume" }` switches it off or on. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const action = guard.body.action;
  if (action === "run") return serviceProxy(guard.ctx, `/v1/automations/${id}/run`, { method: "POST", body: {} });
  if (action === "pause" || action === "resume") return serviceProxy(guard.ctx, `/v1/automations/${id}/status`, { method: "POST", body: { status: action === "pause" ? "off" : "active" } });
  return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
}
