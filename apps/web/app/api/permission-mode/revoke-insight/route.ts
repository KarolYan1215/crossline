import { revokeInsight } from "../../../../lib/permission-mode";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { eventId?: unknown };
  if (typeof body.eventId !== "string") return Response.json({ ok: false, code: "INSIGHT_ID_INVALID" }, { status: 400 });
  const result = revokeInsight(body.eventId);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
