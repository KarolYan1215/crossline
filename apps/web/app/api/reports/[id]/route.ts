import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { decideReportItem } from "../../../../lib/reports";
import { analyzeNewCapturesInBackground } from "../../../../lib/capture-followups";
import { validId } from "../../agent/guard";

/** One of a report's actions: 「加入任务」 (`add`, written down as a capture and analysed) or 「不需要」 (`dismiss`). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* validated below */ }
  const { key, decision } = body;
  if (!validId(id) || typeof key !== "string" || !/^[a-f0-9]{12}$/.test(key) || (decision !== "add" && decision !== "dismiss"))
    return NextResponse.json({ ok: false, code: "REPORT_DECISION_INVALID" }, { status: 400 });
  const result = decideReportItem(access.ctx, id, key, decision);
  if (result.ok && result.captured) analyzeNewCapturesInBackground(access.ctx);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
