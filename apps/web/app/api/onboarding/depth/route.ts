import { NextResponse } from "next/server";
import { ONBOARDING_DEPTHS, ONBOARDING_DEPTH_SETTING } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** How thorough the interview is (onboarding-depth.ts): chosen on the opening card, changeable any time; read every turn. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { depth?: unknown } | null;
  if (typeof body?.depth !== "string" || !(ONBOARDING_DEPTHS as readonly string[]).includes(body.depth))
    return NextResponse.json({ ok: false, code: "INVALID_DEPTH" }, { status: 400 });
  getStore().setSetting(access.ctx.workspaceId, ONBOARDING_DEPTH_SETTING, body.depth);
  return NextResponse.json({ ok: true, depth: body.depth });
}
