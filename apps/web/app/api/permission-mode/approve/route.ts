import { approvePermissionCandidate } from "../../../../lib/permission-mode";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { key?: unknown };
  if (typeof body.key !== "string") return Response.json({ ok: false, code: "PERMISSION_KEY_INVALID" }, { status: 400 });
  const result = approvePermissionCandidate(access.ctx, body.key);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
