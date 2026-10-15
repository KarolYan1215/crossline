import { NextResponse } from "next/server";
import { CALENDAR_SUBSCRIPTIONS_SETTING, readSubscriptions } from "@crossline/core";
import { getStore } from "../../../../lib/crossline";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "../../../../lib/codex-runtime";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Calendars read from a subscription link (docs/onboarding-v3.md 「日历接入」). The list is read here from the ledger, where only the
 * label, host and last read are kept; adding and removing go to the worker, which reads the link once and keeps it in its secret store.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ subscriptions: readSubscriptions(getStore().getSetting(access.ctx.workspaceId, CALENDAR_SUBSCRIPTIONS_SETTING)) },
    { headers: { "cache-control": "no-store" } });
}

const unavailable = (error: unknown) => error instanceof CodexSupervisorRequestError
  ? NextResponse.json({ state: "blocked", code: error.blocker.code, message: "后台服务没有连上，稍后再试。" }, { status: 503 })
  : NextResponse.json({ state: "blocked", code: "ICAL_ADD_FAILED", message: "没能接入这个日历，稍后再试。" }, { status: 503 });

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ state: "blocked", code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { link?: unknown; label?: unknown } | null;
  if (typeof body?.link !== "string" || !body.link.trim()) return NextResponse.json({ state: "blocked", code: "ICAL_LINK_INVALID", message: "先粘贴日历链接。" }, { status: 400 });
  try {
    const added = await requestCodexSupervisor<{ state: string }>(access.ctx, "/v1/calendar/subscriptions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: body.link.slice(0, 2000), label: typeof body.label === "string" ? body.label.slice(0, 40) : "" }),
      signal: AbortSignal.timeout(60_000)
    });
    // Read into the plan at once, so the week and the interview see it now rather than at the next tick.
    if (added.state === "added") await requestCodexSupervisor(access.ctx, "/v1/calendar/sync", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
    return NextResponse.json(added);
  } catch (error) { return unavailable(error); }
}

export async function DELETE(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ state: "blocked", code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[A-Za-z0-9-]{1,40}$/.test(id)) return NextResponse.json({ state: "blocked", code: "ICAL_ID_INVALID" }, { status: 400 });
  try {
    return NextResponse.json(await requestCodexSupervisor(access.ctx, `/v1/calendar/subscriptions/${id}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) }));
  } catch (error) { return unavailable(error); }
}
