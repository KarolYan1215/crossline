import { syncDeviceTimeZone } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** `{timeZone}`: the zone the person's device reports (`Intl`); written into the schedule preferences when it differs. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { timeZone?: unknown };
  const result = syncDeviceTimeZone(access.ctx, body.timeZone);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
