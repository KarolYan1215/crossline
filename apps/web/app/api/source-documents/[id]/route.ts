import { NextResponse } from "next/server";
import { removeUploadedSource } from "../../../../lib/sources";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Takes back one uploaded file (the interview's materials list, 「删除」): the row and, when nothing else reads it, the stored copy. A
 * folder's file is refused here; the folder's card excludes it instead.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ ok: false, code: "SOURCE_NOT_FOUND" }, { status: 404 });
  const result = removeUploadedSource(access.ctx, id);
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "SOURCE_NOT_FOUND" ? 404 : 409 });
}
