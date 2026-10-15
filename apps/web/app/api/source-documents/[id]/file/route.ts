import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory, getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { fileResponse } from "../../../../materials/file-response";

/**
 * Opens one of the person's own uploaded files (a syllabus, a lecture plan) from a task: the dialog's 「材料」 links here.
 *
 * The path comes from the ledger row, never from the request, and must sit inside the data directory's `sources` folder. How the file is
 * answered — opened in place, drawn on the material page, previewed as data, downloaded — is `fileResponse` (app/materials). `?view=text`
 * returns the text that was extracted from it. Nothing is ever served as HTML.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const doc = getStore().listSourceDocuments(access.ctx.workspaceId).find((item) => item.id === id);
  if (!doc) return new Response("NOT_FOUND", { status: 404 });
  if (new URL(request.url).searchParams.get("view") === "text") {
    return new Response(doc.extractedText || "（这份文件没有可读取的文字）", { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }
  let file: string;
  try { file = fileURLToPath(doc.uri); } catch { return new Response("NOT_FOUND", { status: 404 }); }
  const root = path.resolve(dataDirectory(), "sources");
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("FORBIDDEN", { status: 403 });
  let bytes: Uint8Array;
  try { bytes = readFileSync(file); } catch { return new Response("UNREADABLE", { status: 404 }); }
  return fileResponse(request, { bytes, fileName: doc.fileName, extractedText: doc.extractedText, src: `/api/source-documents/${encodeURIComponent(doc.id)}/file` });
}
