import { setPaused } from "@crossline/db";
import { getStore } from "../../../../lib/crossline";
import { writeGuard } from "../guard";

/** Stops (or lets resume) the assistant starting anything by itself. A task already running finishes. */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  if (typeof guard.body.paused !== "boolean") return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  setPaused(getStore(), guard.ctx.workspaceId, guard.body.paused);
  return Response.json({ ok: true });
}
