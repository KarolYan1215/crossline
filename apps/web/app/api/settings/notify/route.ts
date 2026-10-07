import { NextResponse } from "next/server";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

const LEVELS = new Set(["off", "less", "normal", "more"]);

/** How often the worker may interrupt with a desktop notification (see apps/worker/src/notify.ts). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { level?: unknown } | null;
  if (typeof body?.level !== "string" || !LEVELS.has(body.level)) return NextResponse.json({ ok: false, code: "INVALID_NOTIFY_LEVEL" }, { status: 400 });
  getStore().setSetting(access.ctx.workspaceId, "notify.level", body.level);
  return NextResponse.json({ ok: true, level: body.level });
}
