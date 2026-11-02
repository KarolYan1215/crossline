import { readFile } from "node:fs/promises";
import path from "node:path";
import { formRunOf } from "@crossline/db";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { dataDirectory, getStore } from "../../../../../lib/crossline";

/** One screenshot of a form run (`?n=` its index), served only from that run's own folder; sensitive fields were masked when taken. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return new Response("NOT_FOUND", { status: 404 });
  const run = formRunOf(getStore(), access.ctx.workspaceId, id);
  const n = Number(new URL(request.url).searchParams.get("n") ?? "-1");
  const file = run && Number.isInteger(n) ? run.screenshots[n < 0 ? run.screenshots.length + n : n] : undefined;
  if (!file) return new Response("NOT_FOUND", { status: 404 });
  const folder = path.resolve(dataDirectory(), "forms", access.ctx.workspaceId, id);
  const relative = path.relative(folder, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !file.endsWith(".png")) return new Response("FORBIDDEN", { status: 403 });
  try { return new Response(new Uint8Array(await readFile(file)), { headers: { "content-type": "image/png", "x-content-type-options": "nosniff", "cache-control": "private, max-age=300" } }); }
  catch { return new Response("NOT_FOUND", { status: 404 }); }
}
