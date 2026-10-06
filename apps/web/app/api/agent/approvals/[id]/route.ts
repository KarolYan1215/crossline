import { decideAgentApproval } from "@crossline/db";
import { getStore } from "../../../../../lib/crossline";
import { validId, writeGuard } from "../../guard";

/** The person's answer to a question the guard put to them in the middle of a run. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  const decision = guard.body.decision;
  if (!validId(id) || (decision !== "accepted" && decision !== "declined")) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const recorded = decideAgentApproval(getStore(), guard.ctx.workspaceId, id, decision);
  return Response.json({ ok: recorded }, { status: recorded ? 200 : 409 });
}
