import type { BackgroundKind } from "@crossline/core";
import { resolveAccessContext } from "../../../lib/access-guard";
import { setBackgroundPaused } from "../../../lib/background";
import { isCrossSiteWrite } from "../../../lib/same-origin";

/** `{kind, paused}`: pauses or resumes one kind of background work (设置 → 后台任务). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; paused?: unknown };
  if (typeof body.kind !== "string" || typeof body.paused !== "boolean") return Response.json({ ok: false, code: "BACKGROUND_REQUEST_INVALID" }, { status: 400 });
  const result = setBackgroundPaused(access.ctx, body.kind as BackgroundKind, body.paused);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
