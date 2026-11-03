import { resolveAccessContext } from "../../../../lib/access-guard";
import { recordDeviceLocation } from "../../../../lib/device-location";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The device's position, posted when the person presses 「用这台设备的位置」; kept rounded to ~1 km, latest only, only while consented. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { lat?: unknown; lon?: unknown } | null;
  const result = recordDeviceLocation(access.ctx, body?.lat, body?.lon);
  return Response.json(result, { status: result.ok ? 200 : result.code === "DEVICE_LOCATION_NOT_ENABLED" ? 403 : 400 });
}
