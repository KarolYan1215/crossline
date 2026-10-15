import { buildPreview } from "./preview";
import { materialKind, viewerHref } from "./kinds";

/**
 * How the app's three file routes (the person's uploads, the assistant's files, a tutorial's kept copies) answer, in one place.
 *
 * - `?view=preview` → the viewer's JSON (`MaterialPreview`), never HTML.
 * - `?download=1` → the bytes as an attachment under the file's own name.
 * - A browser opening a Markdown, text, Word or table file as a page (a plain link, a new tab) is sent to the material page, which draws
 *   it; before this a .md opened as raw text and a .docx arrived as a nameless 「file」 with no extension that nothing could open.
 * - Otherwise a PDF or an image opens in place and everything else downloads under its name.
 *
 * Nothing is served as HTML or SVG from these routes, and every answer carries `nosniff`.
 */
const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  md: "text/plain; charset=utf-8", markdown: "text/plain; charset=utf-8", txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
const INLINE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "md", "markdown", "txt", "log", "csv", "tsv"]);
const ext = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * `attachment; filename="…"; filename*=UTF-8''…`: an ASCII fallback beside the real name. A header value must be bytes under 256, so a
 * Chinese name written straight into `filename="…"` made the Headers constructor throw and the route answer 500.
 */
export function contentDisposition(disposition: "inline" | "attachment", fileName: string): string {
  const clean = fileName.replace(/[\r\n"\\/]/g, "_").trim() || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Kinds the material page draws better than the browser does. */
const VIEWED = new Set(["markdown", "text", "docx", "csv"]);


export async function fileResponse(request: Request, file: { bytes: Uint8Array; fileName: string; extractedText?: string; src: string }): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "preview") {
    const preview = await buildPreview({ fileName: file.fileName, bytes: file.bytes, ...(file.extractedText !== undefined ? { extractedText: file.extractedText } : {}) });
    return Response.json(preview, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  const download = url.searchParams.get("download") === "1";
  // A navigation (not a fetch, an embed or a download) to something the page draws goes to the material page.
  if (!download && request.headers.get("sec-fetch-dest") === "document" && VIEWED.has(materialKind(file.fileName))) {
    return new Response(null, { status: 303, headers: { location: viewerHref(file.src, file.fileName), "cache-control": "no-store" } });
  }
  const extension = ext(file.fileName);
  const inline = !download && INLINE.has(extension);
  return new Response(new Uint8Array(file.bytes), { headers: {
    "content-type": MIME[extension] ?? "application/octet-stream",
    "content-disposition": contentDisposition(inline ? "inline" : "attachment", file.fileName),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // Shown in place, text and images still run nothing. Not on an attachment (never rendered; a sandbox there stops the download
    // itself) and not on a PDF (the browser's PDF viewer refuses to load in a sandboxed page).
    ...(inline && extension !== "pdf" ? { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" } : {})
  } });
}
