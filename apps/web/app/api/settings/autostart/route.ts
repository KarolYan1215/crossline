import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { autostartAvailable, setAutostart } from "../../../../lib/autostart";

export const runtime = "nodejs";

/** Turns starting with Windows on or off for an installed copy (`lib/autostart.ts`). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (!autostartAvailable()) return NextResponse.json({ ok: false, code: "NOT_INSTALLED" }, { status: 404 });
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ ok: false, code: "INVALID_AUTOSTART_SETTING" }, { status: 400 });
  const ok = await setAutostart(body.on);
  return NextResponse.json(ok ? { ok: true, on: body.on } : { ok: false, code: "AUTOSTART_NOT_SAVED" }, { status: ok ? 200 : 500 });
}
