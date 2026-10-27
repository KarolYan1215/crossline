import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { setTravel } from "../../../../lib/travel";

/** Home and work address, the default travel time and whether a map may estimate it (Settings → 时间与提醒 「出行」). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { home?: unknown; work?: unknown; defaultMinutes?: unknown; useMap?: unknown } | null;
  if (!body || (body.home !== undefined && typeof body.home !== "string") || (body.work !== undefined && typeof body.work !== "string")
    || (body.defaultMinutes !== undefined && (typeof body.defaultMinutes !== "number" || body.defaultMinutes < 0 || body.defaultMinutes > 240))
    || (body.useMap !== undefined && typeof body.useMap !== "boolean")) return NextResponse.json({ ok: false, code: "INVALID_TRAVEL" }, { status: 400 });
  const settings = setTravel(access.ctx, { ...(typeof body.home === "string" ? { home: body.home } : {}), ...(typeof body.work === "string" ? { work: body.work } : {}),
    ...(typeof body.defaultMinutes === "number" ? { defaultMinutes: body.defaultMinutes } : {}), ...(typeof body.useMap === "boolean" ? { useMap: body.useMap } : {}) });
  return NextResponse.json({ ok: true, settings });
}
