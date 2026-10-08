import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory, getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";

/**
 * Opens one of the person's own uploaded files (a syllabus, a lecture plan) from a task: the dialog's 「材料」 links here.
 *
 * The path comes from the ledger row, never from the request, and must sit inside the data directory's `sources` folder. A PDF or an
 * image opens in place; text is shown as plain text; anything else (a .docx) downloads under its own name. `?view=text` returns the text
 * that was extracted from it instead, which is how a .docx is read without leaving the app. Nothing is ever served as HTML.
 */
const INLINE: Record<string, string> = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const doc = getStore().listSourceDocuments(access.ctx.workspaceId).find((item) => item.id === id);
  if (!doc) return new Response("NOT_FOUND", { status: 404 });
  const safeName = doc.fileName.replace(/["\r\n\\]/g, "_");
  if (new URL(request.url).searchParams.get("view") === "text") {
    return new Response(doc.extractedText || "（这份文件没有可读取的文字）", { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }
  let file: string;
  try { file = fileURLToPath(doc.uri); } catch { return new Response("NOT_FOUND", { status: 404 }); }
  const root = path.resolve(dataDirectory(), "sources");
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return new Response("FORBIDDEN", { status: 403 });
  try {
    const type = INLINE[path.extname(doc.fileName).toLowerCase()];
    return new Response(readFileSync(file), { headers: {
      "content-type": type ?? "application/octet-stream",
      "content-disposition": `${type ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      "x-content-type-options": "nosniff"
    } });
  } catch { return new Response("UNREADABLE", { status: 404 }); }
}
