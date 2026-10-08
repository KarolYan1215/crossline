import { getStore } from "../../../lib/crossline";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { ARCHETYPE_CURATION_PERIOD } from "../../../lib/preferences";

/** The person's own changes to what the system learned: remove an entry, retire a learned archetype, or set how often new ones are looked for. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { remove?: unknown; period?: unknown; retireArchetype?: unknown };
  const store = getStore();
  if (typeof body.remove === "string") {
    return store.deletePreference(access.ctx.workspaceId, body.remove) ? Response.json({ ok: true }) : Response.json({ ok: false, code: "PREFERENCE_NOT_FOUND" }, { status: 404 });
  }
  if (typeof body.retireArchetype === "string") {
    return store.retireLearnedArchetype(access.ctx.workspaceId, body.retireArchetype) ? Response.json({ ok: true }) : Response.json({ ok: false, code: "ARCHETYPE_NOT_FOUND" }, { status: 404 });
  }
  if (body.period === "off" || body.period === "biweekly" || body.period === "monthly") {
    store.setSetting(access.ctx.workspaceId, ARCHETYPE_CURATION_PERIOD, body.period);
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
}
