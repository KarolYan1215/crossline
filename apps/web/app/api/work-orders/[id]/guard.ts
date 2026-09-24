import type { AccessContext } from "@crossline/core";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";

// The same trust boundary the capture analyze route already enforces: a local single-user board still
// rejects cross-origin writes, and an id that could not have been issued here never reaches the store.
// Folded into the same guard as the session check, since every work-order route needs both in order.
export async function rejectUnsafeRequest(request: Request, id: string): Promise<{ ctx: AccessContext } | { response: Response }> {
  if (isCrossSiteWrite(request)) return { response: Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 }) };
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    return { response: Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 }) };
  }
  return resolveAccessContext(request);
}
