import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { dryRunWorkflow, loadWorkflowDetail, rollbackWorkflow, startWorkflowTurn } from "../../../../lib/workflows";
import { validId, writeGuard } from "../../agent/guard";

/** One workflow or a conversation making one: its turns (polled while one streams) and its versions. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_WORKFLOW" }, { status: 400 });
  const detail = loadWorkflowDetail(access.ctx, id);
  return detail ? NextResponse.json({ ok: true, detail }, { headers: { "cache-control": "no-store" } }) : NextResponse.json({ ok: false, code: "WORKFLOW_NOT_FOUND" }, { status: 404 });
}

/**
 * `{ action: "turn", text }` says the next thing in its conversation; `{ action: "rollback", version }` goes back to any version (a new
 * version); `{ action: "dry_run", version }` works out what that version would do, running nothing and writing nothing.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  if (!validId(id)) return NextResponse.json({ ok: false, code: "INVALID_WORKFLOW" }, { status: 400 });
  const { action, text, version } = guard.body;
  if (action === "turn") {
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
    const detail = loadWorkflowDetail(guard.ctx, id);
    if (!detail) return NextResponse.json({ ok: false, code: "WORKFLOW_NOT_FOUND" }, { status: 404 });
    const result = await startWorkflowTurn(guard.ctx, detail.threadId ? { threadId: detail.threadId, text } : { workflowId: detail.id, text });
    return NextResponse.json(result, { status: result.ok ? 200 : result.status });
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  if (action === "rollback") {
    const result = rollbackWorkflow(guard.ctx, id, version);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }
  if (action === "dry_run") {
    const run = dryRunWorkflow(guard.ctx, id, version);
    return run ? NextResponse.json({ ok: true, run }) : NextResponse.json({ ok: false, code: "WORKFLOW_VERSION_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
}
