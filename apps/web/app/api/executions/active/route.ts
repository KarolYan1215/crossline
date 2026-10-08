import { activeTimers } from "../../../../lib/timer";
import { resolveAccessContext } from "../../../../lib/access-guard";

/** Running and paused sessions, for the floating countdown. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, timers: activeTimers(access.ctx) });
}
