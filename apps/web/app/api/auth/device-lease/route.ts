import { randomUUID } from "node:crypto";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const LEASE_HOURS = 24;

/**
 * Issues a 24-hour device lease binding `(principalId, workspaceId, deviceId)` — the offline workbench's
 * Dexie database is scoped to a workspace, not a browser, and this is what proves a given device was
 * actually authorized by that workspace's owner rather than just having guessed at an id. A static
 * (non-catch-all) segment under `app/api/auth/`, so it is matched before Better Auth's own
 * `[...all]` handler at the same prefix — ordinary Next.js route specificity, not a special case.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const body = (await request.json().catch(() => ({}))) as { deviceId?: unknown };
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) {
    return Response.json({ ok: false, code: "DEVICE_ID_INVALID" }, { status: 400 });
  }
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + LEASE_HOURS * 60 * 60_000);
  const lease = getStore().issueDeviceLease({
    id: randomUUID(), principalId: ctx.principalId, workspaceId: ctx.workspaceId, deviceId,
    issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString()
  });
  return Response.json({ ok: true, deviceId: lease.deviceId, expiresAt: lease.expiresAt });
}
