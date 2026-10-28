import { serviceProxy } from "../../../../../lib/service-proxy";
import { validId, writeGuard } from "../../../agent/guard";

/** Disconnects a tool: its token is deleted from the worker's secret store at once. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/import/sources/${id}`, { method: "DELETE" });
}

/** `{ action: "read" }` reads the tool now; otherwise `{ daily?, writeBack? }` sets the daily read and, for Todoist, write-back. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  if (guard.body.action === "read") return serviceProxy(guard.ctx, `/v1/import/sources/${id}/read`, { method: "POST", timeoutMs: 120_000, body: {} });
  return serviceProxy(guard.ctx, `/v1/import/sources/${id}/options`, { method: "POST", body: {
    ...(typeof guard.body.daily === "boolean" ? { daily: guard.body.daily } : {}), ...(typeof guard.body.writeBack === "boolean" ? { writeBack: guard.body.writeBack } : {}) } });
}
