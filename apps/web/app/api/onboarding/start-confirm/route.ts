import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { startReadiness } from "../../../../lib/start-gate";
import { confirmStart, startSummary } from "../../../../lib/start-confirm";

/** What the person looks over before the app opens (`startSummary`), and their confirmation of it. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, summary: startSummary(access.ctx) });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  // Only once the start standard stands: there is nothing to confirm before that.
  if (!startReadiness(access.ctx).standard) return NextResponse.json({ ok: false, code: "START_STANDARD_OPEN" }, { status: 409 });
  const outcome = confirmStart(access.ctx);
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 409 });
}
