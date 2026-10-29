import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { helperDay } from "../../../../lib/helper";

export const dynamic = "force-dynamic";

/**
 * Today for the narrow 小帮手 window (`/helper` and the pinned Picture-in-Picture window): the day's blocks as one band, the next block
 * of work and the assistant's runs going on now. Read-only; polled once a minute while the window is visible.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...(await helperDay(access.ctx)) }, { headers: { "cache-control": "no-store" } });
}
