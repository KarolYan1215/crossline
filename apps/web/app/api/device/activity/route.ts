import { cleanActivityPayload } from "@crossline/core";
import { applyDeviceActivity, handleDeviceSend } from "../../../../lib/device";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * A linked computer's screen activity (docs/device-mode.md): daily and hourly minutes, idle stretches, input rhythm, segments by category
 * (no title, no app name) and its consents. `device` token only; a repeated idempotency key is not applied twice.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  return handleDeviceSend(request, cleanActivityPayload, applyDeviceActivity);
}
