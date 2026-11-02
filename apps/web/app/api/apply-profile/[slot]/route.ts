import { APPLICATION_SLOTS } from "@crossline/core";
import { serviceProxy } from "../../../../lib/service-proxy";
import { writeGuard } from "../../agent/guard";

/**
 * One item of the application profile (docs/opportunity-agent.md §12). Saving goes to the worker: a sensitive item is written to its
 * secret store only, the rest as a confirmed fact; a run waiting on this item goes on.
 */
export async function POST(request: Request, context: { params: Promise<{ slot: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { slot } = await context.params;
  if (!(slot in APPLICATION_SLOTS)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const value = typeof guard.body.value === "string" ? guard.body.value.slice(0, 500) : "";
  return serviceProxy(guard.ctx, `/v1/apply-profile/${slot}`, { method: "POST", body: { value, sourceRef: "settings" } });
}

export async function DELETE(request: Request, context: { params: Promise<{ slot: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { slot } = await context.params;
  if (!(slot in APPLICATION_SLOTS)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/apply-profile/${slot}`, { method: "DELETE" });
}
