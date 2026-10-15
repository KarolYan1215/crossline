import { NextResponse } from "next/server";
import { TELEMETRY_ENABLED_SETTING } from "@crossline/core";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { recordPageView } from "../../../../lib/telemetry";

export const runtime = "nodejs";

/** A page view on an installed copy, kept as its route template (docs/local-installer.md, 回传); nothing while sending is off. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (getStore().getSetting(access.ctx.workspaceId, TELEMETRY_ENABLED_SETTING) === "0") return NextResponse.json({ recorded: false });
  const body = await request.json().catch(() => ({})) as { path?: unknown };
  return NextResponse.json({ recorded: typeof body.path === "string" && body.path.length < 300 && recordPageView(body.path) });
}
