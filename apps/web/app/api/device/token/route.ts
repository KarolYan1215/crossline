import { resolveAccessContext } from "../../../../lib/access-guard";
import { deviceStatus, revokeDeviceToken } from "../../../../lib/device";
import { issueDeviceToken } from "../../../../lib/energy";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The 「这台电脑」 card (docs/device-mode.md): whether a device is linked, when it last sent, its folders. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, ...deviceStatus(access.ctx.workspaceId) });
}

/** A new device token, shown once; the previous one stops working at once. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, token: issueDeviceToken(access.ctx, "device") });
}

/** 撤销: the device's next send is refused. What it already sent stays. */
export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  revokeDeviceToken(access.ctx.workspaceId);
  return Response.json({ ok: true });
}
