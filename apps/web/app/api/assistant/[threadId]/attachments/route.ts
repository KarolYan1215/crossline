import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assistantAttachmentsRoot, saveAssistantAttachments } from "../../../../../lib/attachments";
import { getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

const MAX_FILES = 10;

/**
 * Unlike `/api/captures/[id]/attachments`, there is no "thread not found" check here: the widget lets a
 * person attach a file before ever sending a message, so `assistant_threads` may not have a row for this
 * `threadId` yet — the worker's first turn call creates it (`assistant-runner.ts`). The thread id is
 * client-generated and only has to match the shape every id in this app already requires.
 */
export async function POST(request: Request, context: { params: Promise<{ threadId: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const { threadId } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) return Response.json({ code: "ASSISTANT_THREAD_ID_INVALID" }, { status: 400 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ code: "INVALID_UPLOAD" }, { status: 400 });
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (!files.length || files.length > MAX_FILES) return Response.json({ code: "ATTACHMENT_COUNT_INVALID" }, { status: 400 });

  const buffers = await Promise.all(files.map(async (file) => ({
    fileName: file.name || "attachment", mediaType: file.type, buffer: Buffer.from(await file.arrayBuffer())
  })));
  const result = saveAssistantAttachments(getStore(), {
    workspaceId: ctx.workspaceId, ownerId: ctx.principalId, threadId, files: buffers
  });
  if (!result.ok) return Response.json({ code: result.code, message: result.message }, { status: 400 });
  return Response.json({ saved: result.saved.map((file) => ({ id: file.id, fileName: file.fileName, mediaType: file.mediaType })) });
}

/** Same "path comes from the ledger row, never the query string" pattern as `/api/captures/[id]/attachments`. */
export async function GET(request: Request, context: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const uri = new URL(request.url).searchParams.get("uri") ?? "";
  const attachment = getStore().listAssistantAttachments(access.ctx.workspaceId, threadId).find((item) => item.uri === uri);
  if (!attachment) return new Response("ATTACHMENT_NOT_FOUND", { status: 404 });

  const root = assistantAttachmentsRoot(threadId);
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
