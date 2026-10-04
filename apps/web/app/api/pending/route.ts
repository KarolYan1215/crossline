import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { countPending } from "../../../lib/pending";

/** What is waiting for this person's decision, for the badge in the header. Read-only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...countPending(access.ctx) }, { headers: { "cache-control": "no-store" } });
}
