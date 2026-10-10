import { NextResponse } from "next/server";
import { removeCrossLineArtifact } from "../../../../lib/artifact-relations";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/**
 * Takes one cross-line artifact off a draft (the draft list on 主线): the candidate relation is archived and no re-derivation brings it
 * back. Only a candidate can be removed here; an approved relation is decided, and refuted only by its check.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  if (!id || id.length > 400) return NextResponse.json({ ok: false, code: "INVALID_RELATION_ID" }, { status: 400 });
  const result = removeCrossLineArtifact(access.ctx, decodeURIComponent(id));
  return NextResponse.json(result, { status: result.ok ? 200 : result.code === "RELATION_NOT_FOUND" ? 404 : 409 });
}
