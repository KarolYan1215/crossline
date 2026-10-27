import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { listNotices, markNoticesRead } from "../../../lib/notices";

export const dynamic = "force-dynamic";

/** The bell's reminders of the last week and how many are unread. Read-only. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return NextResponse.json({ ok: true, ...listNotices(access.ctx) }, { headers: { "cache-control": "no-store" } });
}

/** `{ readAt }`: the bell was opened, everything up to that moment is read. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => ({})) as { readAt?: unknown };
  if (typeof body.readAt !== "string" || !Number.isFinite(Date.parse(body.readAt))) return Response.json({ ok: false, code: "INVALID_READ_AT" }, { status: 400 });
  markNoticesRead(access.ctx, new Date(Math.min(Date.parse(body.readAt), Date.now())).toISOString());
  return Response.json({ ok: true });
}
