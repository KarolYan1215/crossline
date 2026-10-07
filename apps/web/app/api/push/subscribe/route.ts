import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { subscribePush, unsubscribePush } from "../../../../lib/push";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** A phone's push subscription: stored (POST) or removed (DELETE). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { subscription?: unknown; origin?: unknown; device?: unknown } | null;
  const result = subscribePush(access.ctx, { subscription: body?.subscription, origin: body?.origin, device: body?.device });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { endpoint?: unknown } | null;
  return NextResponse.json(unsubscribePush(access.ctx, body?.endpoint));
}
