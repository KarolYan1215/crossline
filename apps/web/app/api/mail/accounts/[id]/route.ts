import { serviceProxy } from "../../../../../lib/service-proxy";
import { validId, writeGuard } from "../../../agent/guard";

/** Removes a mailbox (its password is deleted from the worker's secret store). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  return serviceProxy(guard.ctx, `/v1/mail/accounts/${id}`, { method: "DELETE" });
}

/**
 * Turns sorting of new mail on or off for one mailbox (`{ triage: boolean }`), or whether its bank and shop mails become wealth records
 * (`{ bookkeeping: boolean }`, docs/domain-lines.md).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  if (typeof guard.body.bookkeeping === "boolean") return serviceProxy(guard.ctx, `/v1/mail/accounts/${id}/bookkeeping`, { method: "POST", body: { on: guard.body.bookkeeping } });
  return serviceProxy(guard.ctx, `/v1/mail/accounts/${id}/triage`, { method: "POST", body: { on: guard.body.triage === true } });
}
