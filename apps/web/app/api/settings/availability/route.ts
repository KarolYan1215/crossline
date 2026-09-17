import { saveAvailability } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** The weekly pattern the scheduler places work into. Rejected rather than coerced when it is wrong. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { windows?: unknown };
  const result = saveAvailability(body.windows);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
