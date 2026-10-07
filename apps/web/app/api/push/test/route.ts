import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { sendTestPush } from "../../../../lib/push";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** Sends one test notification to every subscribed device. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...(await sendTestPush(access.ctx)) });
}
