import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { changeAdoptedDate } from "../../../../../lib/imported-dates";

/** Takes one date read from the files off the calendar and the profile, or puts one the reader was unsure of back on. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: { batchId?: unknown; itemId?: unknown; include?: unknown } = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const batchId = typeof body.batchId === "string" ? body.batchId : "";
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(batchId) || !/^[a-zA-Z0-9_:.-]{1,128}$/.test(itemId) || typeof body.include !== "boolean")
    return NextResponse.json({ ok: false, code: "DATE_ITEM_INVALID" }, { status: 400 });
  const result = changeAdoptedDate(access.ctx, batchId, itemId, body.include);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
