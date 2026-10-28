import { serviceProxy } from "../../../../../lib/service-proxy";
import { validId, writeGuard } from "../../../agent/guard";

/** The person's one confirmation: `{ choices: [{ key, keep, lineId? }] }`; items not named follow the ticked suggestion. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const choices = Array.isArray(guard.body.choices) ? guard.body.choices.slice(0, 300) : [];
  return serviceProxy(guard.ctx, `/v1/import/batches/${id}/confirm`, { method: "POST", body: { choices } });
}

/** Closes a batch without importing; `{ remember: true }` also never offers its items again. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/import/batches/${id}`, { method: "DELETE", body: { remember: guard.body.remember === true } });
}
