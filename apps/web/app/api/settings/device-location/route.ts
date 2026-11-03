import { resolveAccessContext } from "../../../../lib/access-guard";
import { deviceLocationState, setDeviceLocationConsent } from "../../../../lib/device-location";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** 设备位置 (docs/opportunity-agent.md §17.6 a): its own consent, off by default; off deletes the reading. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return Response.json({ ok: false, code: "INVALID_DEVICE_LOCATION_CONSENT" }, { status: 400 });
  setDeviceLocationConsent(access.ctx, body.on);
  return Response.json({ ok: true, ...deviceLocationState(access.ctx) });
}

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json(deviceLocationState(access.ctx));
}
