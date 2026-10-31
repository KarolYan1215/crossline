import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { startReadiness } from "../../../../lib/start-gate";
import { confirmStart, settleInterviewSettings, startSummary } from "../../../../lib/start-confirm";

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
  if (!outcome.ok) return NextResponse.json(outcome, { status: 409 });
  // The settings the person stated in the interview, applied with the confirmation; `skip` lists the ones they unticked (`key|target`).
  const body = await request.json().catch(() => null) as { skip?: unknown } | null;
  const skip = new Set(Array.isArray(body?.skip) ? body.skip.filter((id): id is string => typeof id === "string") : []);
  const settings = await settleInterviewSettings(access.ctx, skip);
  return NextResponse.json({ ...outcome, settings });
}
