import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { changeScale, loadScale, readScaleChange } from "../../../../lib/profile-scale";

/** The scale page before the interview (lib/profile-scale.ts): its items, the person's answers and where they stopped, and their changes. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...loadScale(access.ctx) });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const change = readScaleChange(await request.json().catch(() => null));
  if (!change) return NextResponse.json({ ok: false, code: "SCALE_CHANGE_INVALID" }, { status: 400 });
  const outcome = changeScale(access.ctx, change);
  if (!outcome.ok) return NextResponse.json(outcome, { status: 400 });
  return NextResponse.json({ ok: true, ...loadScale(access.ctx) });
}
