import { setAutoHandoff } from "@crossline/db";
import { getStore } from "../../../../lib/crossline";
import { writeGuard } from "../guard";

/**
 * 「自动交给 Agent」 on or off. On: a step on the calendar that the system can do is started by the worker when its block comes up (or
 * earlier when the assistant is idle), of a kind the person allowed; each kind's 关闭 / 逐次审阅 / 自动 still decides what happens to the
 * result. Off (the default): such steps wait for 「交给 Agent」.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  if (typeof guard.body.enabled !== "boolean") return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  setAutoHandoff(getStore(), guard.ctx.workspaceId, guard.body.enabled);
  return Response.json({ ok: true });
}
