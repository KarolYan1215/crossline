import { loginHostOf } from "@crossline/core";
import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/** Removes a saved website login: the worker deletes it from its secret store and the host from the ledger's record. */
export async function DELETE(request: Request, context: { params: Promise<{ host: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const host = loginHostOf(decodeURIComponent((await context.params).host));
  if (!host) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/apply-logins/${encodeURIComponent(host)}`, { method: "DELETE" });
}
