import { NextResponse } from "next/server";
import { serviceProxy } from "../../../lib/service-proxy";
import { writeGuard } from "../agent/guard";

/**
 * The login dialog acting on the server browser: `{action: "input", events}` (clicks, scrolling, typing — passed on as they are, never
 * logged), `back`, `reload` and `cancel` (closes it without recording a login). 「登录完成」 goes through `/api/skills/grown/[id]`
 * `login_done`, the same path a login window on the person's computer takes.
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  const { action, events } = guard.body;
  if (action === "input") {
    if (!Array.isArray(events) || events.length > 60) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
    return serviceProxy(guard.ctx, "/v1/remote-browser/input", { method: "POST", body: { events }, timeoutMs: 20_000 });
  }
  if (action === "back" || action === "reload" || action === "cancel") return serviceProxy(guard.ctx, `/v1/remote-browser/${action}`, { method: "POST", body: {}, timeoutMs: 35_000 });
  return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
}
