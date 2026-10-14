import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { helperState } from "../../../lib/helper";

export const dynamic = "force-dynamic";

/** The 小帮手's figure and state (working / down), polled by the floating button. Read-only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...(await helperState(access.ctx)) }, { headers: { "cache-control": "no-store" } });
}
