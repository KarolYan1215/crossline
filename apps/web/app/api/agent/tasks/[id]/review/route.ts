import { reviewAgentTask } from "@crossline/db";
import { getStore } from "../../../../../../lib/crossline";
import { validId, writeGuard } from "../../../guard";

/** The person's verdict on a finished task. Accepting a clean result earns its kind of work a step towards being trusted; a rejection takes that back. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { id } = await context.params;
  const { decision, note } = guard.body;
  if (!validId(id) || (decision !== "accepted" && decision !== "rejected")) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const result = reviewAgentTask(getStore(), guard.ctx.workspaceId, id, decision, typeof note === "string" ? note : "");
  return Response.json(result, { status: result.ok ? 200 : result.code === "TASK_NOT_FOUND" ? 404 : 409 });
}
