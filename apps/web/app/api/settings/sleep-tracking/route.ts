import { setSleepTracking } from "../../../../lib/consents";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** 作息记录: whether the start and end of long idle stretches are kept to read sleep from. Turning it off deletes what was kept. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return Response.json({ ok: false, code: "INVALID_SLEEP_TRACKING" }, { status: 400 });
  // This computer's own readings belong to its owner's account only; a guest's device is elsewhere (2026-10-15 walkthrough).
  const result = setSleepTracking(access.ctx, body.on);
  return Response.json(result, { status: result.ok ? 200 : 403 });
}
