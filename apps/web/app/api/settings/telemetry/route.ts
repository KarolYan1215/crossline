import { NextResponse } from "next/server";
import { TELEMETRY_ENABLED_SETTING } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** Whether an installed copy sends its usage metadata (docs/local-installer.md, 回传). On by default; the worker reads it each pass. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return NextResponse.json({ ok: false, code: "INVALID_TELEMETRY_SETTING" }, { status: 400 });
  getStore().setSetting(access.ctx.workspaceId, TELEMETRY_ENABLED_SETTING, body.on ? "1" : "0");
  return NextResponse.json({ ok: true, on: body.on });
}
