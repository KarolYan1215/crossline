import { CAMERA_ENERGY_CONSENT, INPUT_RHYTHM_CONSENT } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { setEnergySignal } from "../../../../lib/consents";
import { phoneHealthOn } from "../../../../lib/energy";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The two optional energy signals (docs/energy-and-ecosystem.md §8), each its own consent, both off unless turned on: 键鼠节律
 * (`input_rhythm`, the worker's quarter-hour totals of input seconds, pauses and pointer travel) and 摄像头精力采样 (`camera`, a
 * twenty-second window's eye and pulse aggregates from the desktop page), and 手机健康数据 (`phone_health`, what the phone's shortcut sends;
 * on by itself once the health token is made). Turning any off deletes what it kept.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { signal?: unknown; on?: unknown } | null;
  if ((body?.signal !== "input_rhythm" && body?.signal !== "camera" && body?.signal !== "phone_health") || typeof body.on !== "boolean")
    return Response.json({ ok: false, code: "INVALID_ENERGY_SIGNAL" }, { status: 400 });
  // This computer's own readings belong to its owner's account only; a guest's device is elsewhere (2026-10-15 walkthrough).
  const result = setEnergySignal(access.ctx, body.signal, body.on);
  return Response.json(result, { status: result.ok ? 200 : 403 });
}

/** Whether each optional signal is on — read by the desktop page to know whether to sample the camera at all. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const store = getStore(), ws = access.ctx.workspaceId;
  return Response.json({ inputRhythm: store.getSetting(ws, INPUT_RHYTHM_CONSENT) === "granted", camera: store.getSetting(ws, CAMERA_ENERGY_CONSENT) === "granted",
    phoneHealth: phoneHealthOn(ws) });
}
