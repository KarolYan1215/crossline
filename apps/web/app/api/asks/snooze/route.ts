import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { snoozeAsk } from "../../../../lib/asks";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** 「明天再问」/「下周再问」. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { askId?: unknown; choice?: unknown } | null;
  if (typeof body?.askId !== "string" || (body.choice !== "tomorrow" && body.choice !== "week"))
    return NextResponse.json({ ok: false, code: "INVALID_SNOOZE" }, { status: 400 });
  const result = snoozeAsk(access.ctx, body.askId, body.choice);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
