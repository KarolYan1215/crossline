import { readFileSync } from "node:fs";
import path from "node:path";
import { FIGURE_FILE } from "@crossline/core";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { currentFigure, figureFolder } from "../../../../../lib/figures";

/**
 * The person's cartoon figure: the current one (`currentFigure`), or with `?file=` any figure in this workspace's own `portrait` folder
 * (the picker on the portrait page lists them). A name the request gives must be a figure file name, never a path.
 */
export async function GET(request: Request, context: { params: Promise<{ slot: string }> }) {
  const { slot } = await context.params;
  if (slot !== "character") return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const asked = new URL(request.url).searchParams.get("file");
  const name = asked ?? currentFigure(access.ctx)?.file ?? "";
  if (!FIGURE_FILE.test(name)) return new Response("NOT_FOUND", { status: 404 });
  const file = path.join(figureFolder(access.ctx.workspaceId), name);
  try {
    const bytes = readFileSync(file);
    // Drawn through Codex it is a PNG; drawn by Volcengine Ark, or added by the person, it may be a JPEG or WebP kept under the same name.
    const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.toString("latin1", 8, 12) === "WEBP" ? "image/webp" : "image/png";
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
  } catch { return new Response("NOT_FOUND", { status: 404 }); }
}
