import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory, getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { contentDisposition } from "../../../../materials/file-response";
import { buildPreview, htmlPageText } from "../../../../materials/preview";

/**
 * Serves one prepared material back to the person who asked for it.
 *
 * The board recorded materials as raw `file:///…` URIs, which a browser will not open — so a work order
 * could finish preparation and the person still had no way to read what was prepared without leaving
 * the app and pasting a path into a file manager.
 *
 * The URI is not taken from the query string: the caller names a work order, and the path comes from
 * the ledger row. Anything that is not a recorded material for that work order, or that resolves
 * outside that work order's own materials folder, is not served.
 */
const PROJECT_ROOT = path.resolve(process.cwd(), "..", "..");

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const uri = new URL(request.url).searchParams.get("uri") ?? "";
  const material = getStore().listMaterials(access.ctx.workspaceId, id).find((item) => item.uri === uri);
  if (!material) return new Response("MATERIAL_NOT_FOUND", { status: 404 });

  // The data directory is where manualbooks live now; the repository folder is where earlier ones were written, and
  // stays readable so nothing prepared before the move disappears.
  const roots = [path.resolve(dataDirectory(), "materials", id), path.resolve(PROJECT_ROOT, ".crossline-materials", id)];
  let file: string;
  try { file = fileURLToPath(material.uri); } catch { return new Response("MATERIAL_NOT_FOUND", { status: 404 }); }
  if (!roots.some((root) => { const relative = path.relative(root, file); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); })) {
    return new Response("MATERIAL_PATH_OUTSIDE_ROOT", { status: 403 });
  }
  try {
    const bytes = readFileSync(file);
    if (new URL(request.url).searchParams.get("view") === "preview") {
      // A kept web page is shown as its text, never as the page.
      const page = /\.html?$/i.test(file);
      return Response.json(await buildPreview(page ? { fileName: "page.txt", extractedText: htmlPageText(bytes.toString("utf8")), kind: "text" } : { fileName: path.basename(file), bytes }),
        { headers: { "cache-control": "no-store" } });
    }
    // A downloaded paper is a PDF and is shown as one; everything else is shown as text and never executed, whatever
    // media type it claims.
    const pdf = file.toLowerCase().endsWith(".pdf");
    return new Response(bytes, {
      headers: {
        "content-type": pdf ? "application/pdf" : "text/plain; charset=utf-8",
        // A name outside ASCII written straight into the header made the route answer 500.
        "content-disposition": contentDisposition("inline", path.basename(file)),
        "x-content-type-options": "nosniff"
      }
    });
  } catch { return new Response("MATERIAL_UNREADABLE", { status: 404 }); }
}
