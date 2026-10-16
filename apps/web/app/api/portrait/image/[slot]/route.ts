import { readFileSync } from "node:fs";
import path from "node:path";
import { dataDirectory, getStore } from "../../../../../lib/crossline";
import { resolveAccessContext } from "../../../../../lib/access-guard";

/**
 * The cartoon figure of the person's portrait report. The file name comes from the ledger (`portrait.images`), never from the request, and
 * must sit in this workspace's own `portrait` folder.
 */
export async function GET(request: Request, context: { params: Promise<{ slot: string }> }) {
  const { slot } = await context.params;
  if (slot !== "character") return new Response("NOT_FOUND", { status: 404 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  let saved: { images?: Record<string, { file?: string }> } = {};
  try { saved = JSON.parse(getStore().getSetting(access.ctx.workspaceId, "portrait.images") ?? "{}"); } catch { /* none */ }
  const name = saved.images?.[slot]?.file ?? "";
  if (!/^v\d+-[a-z]+\.png$/.test(name)) return new Response("NOT_FOUND", { status: 404 });
  const file = path.join(dataDirectory(), "portrait", access.ctx.workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"), name);
  try {
    const bytes = readFileSync(file);
    // Drawn through Codex it is a PNG; drawn by Volcengine Ark it is a JPEG kept under the same name.
    const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : bytes.toString("latin1", 8, 12) === "WEBP" ? "image/webp" : "image/png";
    return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
  } catch { return new Response("NOT_FOUND", { status: 404 }); }
}
