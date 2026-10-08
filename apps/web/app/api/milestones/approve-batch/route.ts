import { NextResponse } from "next/server";
import { approveMilestoneDrafts, rejectMilestoneDrafts } from "../../../../lib/approvals";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Approves (or, with `decision: "archived"`, rejects) the listed milestone drafts; anything not a draft comes back in `skipped`.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { ids?: unknown; decision?: unknown } | null;
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || id.length > 200)) {
    return NextResponse.json({ ok: false, code: "INVALID_MILESTONE_IDS" }, { status: 400 });
  }
  if (body?.decision !== undefined && body.decision !== "approved" && body.decision !== "archived") {
    return NextResponse.json({ ok: false, code: "INVALID_DECISION" }, { status: 400 });
  }
  const decide = body?.decision === "archived" ? rejectMilestoneDrafts : approveMilestoneDrafts;
  return NextResponse.json({ ok: true, ...decide(access.ctx, ids as string[]) });
}
