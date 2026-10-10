import { NextResponse } from "next/server";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { formFiles, uploadSources } from "../../../../lib/sources";
import { getStore } from "../../../../lib/crossline";

const MAX_FILES = 12;

/**
 * Files the person gives the interview. They are stored first and read second: the upload is answered
 * as soon as the bytes are safe, and the text is pulled out by the worker right after, so a slow or
 * failing parse never loses the file. When the worker is not running the documents stay `pending` and
 * the next turn still works — it just does not see them yet.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ ok: false, code: "INVALID_UPLOAD" }, { status: 400 });
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (!files.length || files.length > MAX_FILES) return NextResponse.json({ ok: false, code: "SOURCE_COUNT_INVALID" }, { status: 400 });
  const projectId = typeof form.get("projectId") === "string" ? String(form.get("projectId")) : "";
  if (projectId && !getStore().listProjects(ctx.workspaceId, { includeArchived: true }).some((project) => project.id === projectId)) {
    return NextResponse.json({ ok: false, code: "PROJECT_NOT_FOUND" }, { status: 404 });
  }

  const uploaded = await uploadSources(ctx, await formFiles(form), projectId || undefined);
  if (!uploaded.ok) return NextResponse.json({ ok: false, code: uploaded.code, message: uploaded.message }, { status: 400 });
  return NextResponse.json({ ok: true, documents: uploaded.documents, ...(uploaded.deferred ? { deferred: true } : {}) });
}
