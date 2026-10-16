import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentsRoot, saveCaptureAttachments } from "../../../../../lib/attachments";
import { getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { localeFor } from "../../../../../lib/locale";

const MAX_FILES = 10;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const capture = getStore().listCaptures(ctx.workspaceId).find((item) => item.id === id);
  if (!capture) return Response.json({ code: "CAPTURE_NOT_FOUND" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ code: "INVALID_UPLOAD" }, { status: 400 });
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (!files.length || files.length > MAX_FILES) return Response.json({ code: "ATTACHMENT_COUNT_INVALID" }, { status: 400 });

  const buffers = await Promise.all(files.map(async (file) => ({
    fileName: file.name || "attachment", mediaType: file.type, buffer: Buffer.from(await file.arrayBuffer())
  })));
  const result = saveCaptureAttachments(getStore(), {
    workspaceId: ctx.workspaceId, ownerId: ctx.principalId, captureId: id, files: buffers, locale: localeFor(ctx)
  });
  if (!result.ok) return Response.json({ code: result.code, message: result.message }, { status: 400 });
  return Response.json({ saved: result.saved.length });
}

/**
 * Serves one uploaded attachment back — the same "path comes from the ledger row, never the query
 * string" pattern `/api/work-orders/[id]/materials` already uses. Unlike that route this does not force
 * `text/plain`: the media type was itself validated against a small allowlist at upload time, so serving
 * it as claimed cannot make the browser execute anything.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const uri = new URL(request.url).searchParams.get("uri") ?? "";
  const attachment = getStore().listCaptureAttachments(access.ctx.workspaceId, id).find((item) => item.uri === uri);
  if (!attachment) return new Response("ATTACHMENT_NOT_FOUND", { status: 404 });

  const root = attachmentsRoot(id);
  let file: string;
  try { file = fileURLToPath(attachment.uri); } catch { return new Response("ATTACHMENT_NOT_FOUND", { status: 404 }); }
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return new Response("ATTACHMENT_PATH_OUTSIDE_ROOT", { status: 403 });
  }
  try {
    const disposition = attachment.mediaType === "application/pdf" || attachment.mediaType.startsWith("image/") ? "inline" : "attachment";
    return new Response(readFileSync(file), {
      headers: {
        "content-type": attachment.mediaType,
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`
      }
    });
  } catch { return new Response("ATTACHMENT_UNREADABLE", { status: 404 }); }
}
