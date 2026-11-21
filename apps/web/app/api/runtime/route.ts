import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { runtimeStatus } from "../../../lib/runtime-status";
import { statusNotices } from "../../../lib/asks";

export const dynamic = "force-dynamic";

/**
 * Whether the background worker and its model runtime can work (the banner every page shows when they cannot), and the states that
 * recover by themselves and ask nothing of the person (`notices`, P4: background paused on the quota, a calendar that failed to read).
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, status: await runtimeStatus(access.ctx), notices: statusNotices(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
