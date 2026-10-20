import { assistantAvailable as machineOwner } from "@crossline/db";
import { CAMERA_ENERGY_CONSENT, INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { phoneHealthOn, setPhoneHealth } from "../../../../lib/energy";
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
  // This computer's own readings belong to its owner's account only; a guest's device is elsewhere (2026-10-15 walkthrough).
  if (body?.signal === "input_rhythm" && body.on === true && !machineOwner(getStore(), access.ctx.workspaceId)) return Response.json({ ok: false, code: "MACHINE_OWNER_ONLY" }, { status: 403 });
  if ((body?.signal !== "input_rhythm" && body?.signal !== "camera" && body?.signal !== "phone_health") || typeof body.on !== "boolean")
    return Response.json({ ok: false, code: "INVALID_ENERGY_SIGNAL" }, { status: 400 });
  const store = getStore(), ws = access.ctx.workspaceId;
  if (body.signal === "phone_health") setPhoneHealth(ws, body.on);
  else if (body.signal === "input_rhythm") {
    store.setSetting(ws, INPUT_RHYTHM_CONSENT, body.on ? "granted" : "denied");
    if (!body.on) store.deleteSetting(ws, INPUT_RHYTHM_BUCKETS);
  } else {
    store.setSetting(ws, CAMERA_ENERGY_CONSENT, body.on ? "granted" : "denied");
    if (!body.on) store.deleteEnergyObservations(ws, "camera_aggregate");
  }
  return Response.json({ ok: true });
}

/** Whether each optional signal is on — read by the desktop page to know whether to sample the camera at all. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const store = getStore(), ws = access.ctx.workspaceId;
  return Response.json({ inputRhythm: store.getSetting(ws, INPUT_RHYTHM_CONSENT) === "granted", camera: store.getSetting(ws, CAMERA_ENERGY_CONSENT) === "granted",
    phoneHealth: phoneHealthOn(ws) });
}
