import { saveSchedulePreferences } from "../../../../lib/crossline";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const result = saveSchedulePreferences(body);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
