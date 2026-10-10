import { ACTIVITY_LAST_ACTIVE, ACTIVITY_LONG_GAPS, SLEEP_TRACKING_CONSENT } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** 作息记录: whether the start and end of long idle stretches are kept to read sleep from. Turning it off deletes what was kept. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return Response.json({ ok: false, code: "INVALID_SLEEP_TRACKING" }, { status: 400 });
  const store = getStore();
  store.setSetting(access.ctx.workspaceId, SLEEP_TRACKING_CONSENT, body.on ? "granted" : "denied");
  if (!body.on) { store.deleteSetting(access.ctx.workspaceId, ACTIVITY_LAST_ACTIVE); store.deleteSetting(access.ctx.workspaceId, ACTIVITY_LONG_GAPS); }
  return Response.json({ ok: true });
}
