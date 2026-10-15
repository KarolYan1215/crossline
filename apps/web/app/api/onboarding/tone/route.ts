import { NextResponse } from "next/server";
import { ONBOARDING_TONES, ONBOARDING_TONE_SETTING } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** How the interview talks to the person (docs/onboarding-v3.md): chosen on the opening card, changeable any time; read every turn. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { tone?: unknown } | null;
  if (typeof body?.tone !== "string" || !(ONBOARDING_TONES as readonly string[]).includes(body.tone))
    return NextResponse.json({ ok: false, code: "INVALID_TONE" }, { status: 400 });
  getStore().setSetting(access.ctx.workspaceId, ONBOARDING_TONE_SETTING, body.tone);
  return NextResponse.json({ ok: true, tone: body.tone });
}
