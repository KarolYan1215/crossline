import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { loadWorkflowList, startWorkflowTurn } from "../../../lib/workflows";
import { writeGuard } from "../agent/guard";

/** The 自动化 page's list: every workflow (automations and grown ones) and the conversations still making one. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...loadWorkflowList(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

/** A new workflow in words (`{ text, lineId }`): its conversation starts, and the page opens it (`threadId`). */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const text = typeof guard.body.text === "string" ? guard.body.text.trim().slice(0, 2000) : "";
  const lineId = typeof guard.body.lineId === "string" ? guard.body.lineId.slice(0, 64) : "";
  if (!text) return NextResponse.json({ ok: false, code: "WORKFLOW_TEXT_REQUIRED" }, { status: 400 });
  const result = await startWorkflowTurn(guard.ctx, { text, ...(lineId ? { lineId } : {}) });
  return NextResponse.json(result, { status: result.ok ? 200 : result.status });
}
