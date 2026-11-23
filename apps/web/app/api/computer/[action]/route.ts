import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/** How long the worker may take: a direct command runs up to ten minutes on the computer (docs/plans/remote-control-1122.md §6.2). */
const ACTIONS: Record<string, number> = { state: 20_000, status: 20_000, notify: 10_000, pair: 60_000, folders: 70_000, forms: 20_000, send: 12 * 60_000 };

/**
 * 「这台电脑」 on the phone (docs/plans/remote-control-1122.md): what the person's computer is doing, pairing this phone, and the signed
 * instructions it carries. The signature is made in this phone's browser and checked on the computer; the site only passes it on.
 */
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { action } = await context.params;
  const timeoutMs = ACTIONS[action];
  if (!timeoutMs) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/remote/${action}`, { method: "POST", body: guard.body, timeoutMs });
}
