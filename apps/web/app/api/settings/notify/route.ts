import { NextResponse } from "next/server";
import { setNotifyLevel } from "../../../../lib/consents";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** How often the worker may interrupt with a desktop notification (see apps/worker/src/notify.ts). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { level?: unknown } | null;
  const result = setNotifyLevel(access.ctx, typeof body?.level === "string" ? body.level : "");
  return result.ok ? NextResponse.json({ ok: true, level: body?.level }) : NextResponse.json(result, { status: 400 });
}
