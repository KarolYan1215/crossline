import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { runtimeStatus } from "../../../lib/runtime-status";

export const dynamic = "force-dynamic";

/** Whether the background worker and its model runtime can work (the banner every page shows when they cannot). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, status: await runtimeStatus(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
