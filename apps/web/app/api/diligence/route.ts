import { NextResponse } from "next/server";
import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../lib/codex-runtime";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { decideDiligenceProposal } from "../../../lib/diligence";
import { analyzeNewCapturesInBackground } from "../../../lib/capture-followups";

/**
 * Due diligence on a line of the person's life: `run` asks the worker to research it on the web now, `decide`
 * records the person's answer to one proposal. Nothing a report proposes becomes a goal or a task until it
 * has been accepted here: an accepted task is written down as a capture and analysed, anything else is an input to the milestone design.
 */
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
/** A proposal id is the researcher's own (「建议一」 is one it wrote): only compared with stored ids, so any short printable text is accepted. */
const PROPOSAL_ID = /^[^\s\p{C}]{1,80}$/u;

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, blocker: { code: "REQUEST_FORBIDDEN", message: "Use the local Web API" } }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* validated below */ }

  if (body.action === "decide") {
    const { reportId, proposalId, decision } = body;
    if (typeof reportId !== "string" || typeof proposalId !== "string" || !ID.test(reportId) || !PROPOSAL_ID.test(proposalId)
      || (decision !== "accepted" && decision !== "rejected" && decision !== "pending")) {
      return NextResponse.json({ ok: false, code: "DILIGENCE_DECISION_INVALID" }, { status: 400 });
    }
    const result = decideDiligenceProposal(access.ctx, reportId, proposalId, decision);
    if (result.ok && result.captured) analyzeNewCapturesInBackground(access.ctx);
    return NextResponse.json(result, { status: result.ok ? 200 : 404 });
  }

  if (body.action === "run") {
    const identityId = typeof body.identityId === "string" ? body.identityId : "";
    if (!ID.test(identityId)) return NextResponse.json({ ok: false, code: "DILIGENCE_REQUEST_INVALID" }, { status: 400 });
    try {
      const result = await requestCodexSupervisor<unknown>(access.ctx, "/v1/diligence/run", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityId, force: body.force === true }), signal: AbortSignal.timeout(3 * 60 * 60_000)
      });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof CodexSupervisorRequestError) return NextResponse.json({ ok: false, blocker: error.blocker }, { status: error.status });
      return NextResponse.json({ ok: false, blocker: { code: "DILIGENCE_FAILED", message: "尽调没有完成。" } }, { status: 503 });
    }
  }
  return NextResponse.json({ ok: false, code: "DILIGENCE_ACTION_UNKNOWN" }, { status: 400 });
}
