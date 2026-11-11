import { CALENDAR_IMIP_RECIPIENT_SETTING, type CalendarWritePath } from "@crossline/core";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { getStore } from "../../../../lib/crossline";
import { getAuth } from "../../../../lib/auth";
import { feedToken, resetFeedToken, setWritePaths, writePathStatuses } from "../../../../lib/calendar-write";
import { publishWorkspace } from "../../../../lib/auto-publish";

/**
 * Settings → 日历与连接 → 写入日历: which of the four paths are on, where the invitations go, and a new feed link. Turning the invitations
 * on without an address takes the signed-in account's email (the owner's default, 2026-11-10); the person can change it here.
 */
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, paths: writePathStatuses(access.ctx) });
}

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const body = (await request.json().catch(() => ({}))) as { path?: unknown; on?: unknown; recipient?: unknown; resetToken?: unknown };
  const store = getStore();
  if (typeof body.recipient === "string") {
    const recipient = body.recipient.trim().toLowerCase();
    if (!EMAIL.test(recipient) || recipient.length > 200) return Response.json({ ok: false, code: "EMAIL_INVALID" }, { status: 400 });
    store.setSetting(ctx.workspaceId, CALENDAR_IMIP_RECIPIENT_SETTING, recipient);
  }
  if (body.resetToken === true) resetFeedToken(ctx);
  if (typeof body.path === "string" && ["ics", "imip", "google", "graph"].includes(body.path) && typeof body.on === "boolean") {
    const path = body.path as CalendarWritePath;
    if (path === "imip" && body.on && !store.getSetting(ctx.workspaceId, CALENDAR_IMIP_RECIPIENT_SETTING)) {
      const email = await (async () => { try { return (await getAuth().api.getSession({ headers: request.headers }))?.user.email; } catch { return undefined; } })();
      if (!email || !EMAIL.test(email)) return Response.json({ ok: false, code: "CALENDAR_IMIP_NO_RECIPIENT" }, { status: 400 });
      store.setSetting(ctx.workspaceId, CALENDAR_IMIP_RECIPIENT_SETTING, email.toLowerCase());
    }
    if (path === "ics" && body.on) feedToken(ctx);
    setWritePaths(ctx, { [path]: body.on });
    // A path just turned on is written now, not at the next ten-minute pass.
    if (body.on) void publishWorkspace(ctx.workspaceId).catch(() => undefined);
  }
  return Response.json({ ok: true, paths: writePathStatuses(ctx), recipient: store.getSetting(ctx.workspaceId, CALENDAR_IMIP_RECIPIENT_SETTING) ?? "" });
}
