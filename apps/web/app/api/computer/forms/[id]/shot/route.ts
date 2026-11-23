import { serviceProxy } from "../../../../../../lib/service-proxy";
import { validId, writeGuard } from "../../../../agent/guard";

/** A fresh, masked picture of a free registration form waiting on the person's computer, for a submit from the phone (§6.5). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/remote/forms/${id}/shot`, { method: "POST", body: {}, timeoutMs: 60_000 });
}
