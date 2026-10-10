import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { formFiles, uploadSources } from "../../../../lib/sources";

const MAX_FILES = 6;

/**
 * Files dropped into the one input box: stored and read here, then sent with the turn by id, so the box can say what each one is and
 * propose what to do with it (docs/one-input.md §3.6). They become the person's materials like any interview upload.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ ok: false, code: "INVALID_UPLOAD" }, { status: 400 });
  const files = await formFiles(form);
  if (!files.length || files.length > MAX_FILES) return Response.json({ ok: false, code: "SOURCE_COUNT_INVALID" }, { status: 400 });
  const uploaded = await uploadSources(access.ctx, files);
  if (!uploaded.ok) return Response.json({ ok: false, code: uploaded.code, message: uploaded.message }, { status: 400 });
  return Response.json({ ok: true, documents: uploaded.documents, ...(uploaded.deferred ? { deferred: true } : {}) });
}
