import { permissionHeartbeat } from "../../../../lib/permission-mode";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { keys?: unknown; visible?: unknown };
  if (!Array.isArray(body.keys) || body.keys.length > 100 || typeof body.visible !== "boolean")
    return Response.json({ ok: false, code: "PERMISSION_HEARTBEAT_INVALID" }, { status: 400 });
  return Response.json({ ok: true, ...permissionHeartbeat(access.ctx, body.keys, body.visible) });
}
