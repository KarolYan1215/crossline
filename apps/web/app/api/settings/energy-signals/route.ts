import { CAMERA_ENERGY_CONSENT, INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * The two optional energy signals (docs/energy-and-ecosystem.md §8), each its own consent, both off unless turned on: 键鼠节律
 * (`input_rhythm`, the worker's quarter-hour totals of input seconds, pauses and pointer travel) and 摄像头精力采样 (`camera`, a
 * twenty-second window's eye and pulse aggregates from the desktop page). Turning either off deletes what it kept.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { signal?: unknown; on?: unknown } | null;
  if ((body?.signal !== "input_rhythm" && body?.signal !== "camera") || typeof body.on !== "boolean")
    return Response.json({ ok: false, code: "INVALID_ENERGY_SIGNAL" }, { status: 400 });
  const store = getStore(), ws = access.ctx.workspaceId;
  if (body.signal === "input_rhythm") {
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
  return Response.json({ inputRhythm: store.getSetting(ws, INPUT_RHYTHM_CONSENT) === "granted", camera: store.getSetting(ws, CAMERA_ENERGY_CONSENT) === "granted" });
}
