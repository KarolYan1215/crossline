import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { decideDateBatch } from "../../../../../lib/imported-dates";

/** The person's answer to a batch of dates: which ones go on the calendar. An empty list is a valid "none of them". */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let body: { batchId?: unknown; includedIds?: unknown } = {};
  try { body = await request.json(); } catch { /* validated below */ }
  const batchId = typeof body.batchId === "string" ? body.batchId : "";
  const includedIds = Array.isArray(body.includedIds) ? body.includedIds.filter((id): id is string => typeof id === "string").slice(0, 300) : [];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(batchId)) return NextResponse.json({ ok: false, code: "DATE_BATCH_INVALID" }, { status: 400 });
  const result = decideDateBatch(access.ctx, batchId, includedIds);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "DATE_BATCH_NOT_FOUND" ? 404 : 409 });
}
