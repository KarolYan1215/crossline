import { NextResponse } from "next/server";
import { setBriefTime, setNotifyLevel, setQuietHours } from "../../../../lib/consents";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** How often the worker may interrupt with a desktop notification (see apps/worker/src/notify.ts). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { level?: unknown; quietHours?: unknown; briefTime?: unknown } | null;
  // One field per request: the dial, the quiet hours (`HH:MM-HH:MM`) or the brief's time (`HH:MM`, empty for the first available hour).
  const result = typeof body?.quietHours === "string" ? setQuietHours(access.ctx, body.quietHours)
    : typeof body?.briefTime === "string" ? setBriefTime(access.ctx, body.briefTime)
    : setNotifyLevel(access.ctx, typeof body?.level === "string" ? body.level : "");
  return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json(result, { status: 400 });
}
