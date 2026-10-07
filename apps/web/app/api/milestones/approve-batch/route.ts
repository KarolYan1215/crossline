import { NextResponse } from "next/server";
import { approveMilestoneDrafts } from "../../../../lib/approvals";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** 「接受这条线的 N 个草稿」: approves the listed milestone drafts; anything not a draft comes back in `skipped`. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { ids?: unknown } | null;
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || id.length > 200)) {
    return NextResponse.json({ ok: false, code: "INVALID_MILESTONE_IDS" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ...approveMilestoneDrafts(access.ctx, ids as string[]) });
}
