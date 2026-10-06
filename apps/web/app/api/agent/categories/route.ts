import { approveCategory, declineCategory } from "@crossline/db";
import { isAgentCategory } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { writeGuard } from "../guard";

/** The person's yes or no to a kind of work. Saying yes is what lets the assistant start that kind by itself; saying no stops it asking. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { category, decision } = guard.body;
  if (!isAgentCategory(category) || (decision !== "approve" && decision !== "decline")) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const store = getStore();
  if (decision === "approve") approveCategory(store, guard.ctx.workspaceId, category); else declineCategory(store, guard.ctx.workspaceId, category);
  return Response.json({ ok: true });
}
