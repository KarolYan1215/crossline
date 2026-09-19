import { permissionCandidates, setPermissionMode } from "../../../lib/permission-mode";
import { isCrossSiteWrite } from "../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return Response.json({ ok: false, code: "PERMISSION_MODE_INVALID" }, { status: 400 });
  return Response.json({ ok: true, ...setPermissionMode(body.enabled), candidates: permissionCandidates() });
}
