import { permissionCandidates, setPermissionMode } from "../../../lib/permission-mode";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") return Response.json({ ok: false, code: "PERMISSION_MODE_INVALID" }, { status: 400 });
  return Response.json({ ok: true, ...setPermissionMode(ctx, body.enabled), candidates: permissionCandidates(ctx) });
}
