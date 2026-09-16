import { isCrossSiteWrite } from "../../../../lib/same-origin";

// The same trust boundary the capture analyze route already enforces: a local single-user board still
// rejects cross-origin writes, and an id that could not have been issued here never reaches the store.
export function rejectUnsafeRequest(request: Request, id: string): Response | undefined {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    return Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  }
  return undefined;
}
