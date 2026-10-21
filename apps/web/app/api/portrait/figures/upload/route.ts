import { resolveAccessContext } from "../../../../../lib/access-guard";
import { addFigure, FIGURE_MAX_BYTES } from "../../../../../lib/figures";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/** A figure the person adds (the picture itself as the body: PNG, JPEG or WebP), kept beside the drawn ones and picked at once. Undoable. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  if (Number(request.headers.get("content-length") ?? "0") > FIGURE_MAX_BYTES) return Response.json({ ok: false, code: "FIGURE_TOO_LARGE" }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const result = await addFigure(access.ctx, bytes);
  return Response.json(result, { status: result.ok ? 200 : result.code === "FIGURE_TOO_LARGE" ? 413 : 415 });
}
