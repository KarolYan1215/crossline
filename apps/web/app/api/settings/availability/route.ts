import { saveAvailability } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The weekly pattern the scheduler places work into. Rejected rather than coerced when it is wrong. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { windows?: unknown };
  const result = saveAvailability(access.ctx, body.windows);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
