import { getStore, LOCAL_ACTIVITY_CONSENT } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { consent?: unknown };
  // Only the two answers a person can actually give. Absent stays absent — never asked is a real state.
  if (body.consent !== "granted" && body.consent !== "denied") {
    return Response.json({ ok: false, code: "CONSENT_VALUE_INVALID" }, { status: 400 });
  }
  getStore().setSetting(access.ctx.workspaceId, LOCAL_ACTIVITY_CONSENT, body.consent);
  return Response.json({ ok: true, consent: body.consent });
}
