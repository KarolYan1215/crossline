import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { getStore } from "../../../lib/crossline";
import { PRESENCE_SETTING } from "../../../lib/nudges";

/** A visible page says so every minute: while it does, nudges are shown on the page; once it stops, the worker sends them to the desktop and phone. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  getStore().setSetting(access.ctx.workspaceId, PRESENCE_SETTING, new Date().toISOString());
  return Response.json({ ok: true });
}
