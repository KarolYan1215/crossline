import { requestCodexSupervisor, CodexSupervisorRequestError } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { blocksToPublish } from "../../../../lib/calendar-publish";

/**
 * Writes the plan's own suggested blocks to the calendar named 「Crossline」 — the only calendar this app ever writes.
 * The person's calendars are not touched; the worker's writer refuses anything but that calendar and events it made itself.
 * Only an approved plan is written, and only when the button is pressed; nothing here runs on a timer.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  try {
    const { approved, blocks } = await blocksToPublish(access.ctx);
    if (!approved) return Response.json({ ok: false, code: "PLAN_NOT_APPROVED", message: "计划还没批准；批准后才会写入 Crossline 日历。" }, { status: 409 });
    const result = await requestCodexSupervisor<Record<string, unknown>>(access.ctx, "/v1/calendar/publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks }),
      signal: AbortSignal.timeout(120_000)
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError) {
      return Response.json({ ok: false, code: error.blocker.code, message: error.blocker.message }, { status: error.status });
    }
    return Response.json({ ok: false, code: "CALENDAR_PUBLISH_UNAVAILABLE" }, { status: 503 });
  }
}
