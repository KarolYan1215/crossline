import { approveCategory, declineCategory, setCategoryMode } from "@crossline/db";
import { isAgentCategory } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { writeGuard } from "../guard";

/**
 * The person's answer for a kind of work: yes/no from a request (`decision`), or the settings page's off/review/auto (`mode`). Yes is
 * what lets the assistant start that kind by itself; no stops it asking.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { category, decision, mode } = guard.body;
  const store = getStore();
  if (isAgentCategory(category) && (mode === "off" || mode === "review" || mode === "auto")) {
    setCategoryMode(store, guard.ctx.workspaceId, category, mode);
    return Response.json({ ok: true });
  }
  if (!isAgentCategory(category) || (decision !== "approve" && decision !== "decline")) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  if (decision === "approve") approveCategory(store, guard.ctx.workspaceId, category); else declineCategory(store, guard.ctx.workspaceId, category);
  return Response.json({ ok: true });
}
