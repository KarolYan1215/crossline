import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { restoreUploadedSource } from "../../../../../lib/sources";

/** The 「撤销」 of a removed upload (deleting asks nothing, 2026-11-22): brings it back within the undo window. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ ok: false, code: "SOURCE_NOT_IN_TRASH" }, { status: 404 });
  const result = await restoreUploadedSource(access.ctx, id);
  return NextResponse.json(result, { status: result.ok ? 200 : 404 });
}
