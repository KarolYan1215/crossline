import { resolveAccessContext } from "../../../../lib/access-guard";
import { chooseFigure, figureUrl, listFigures } from "../../../../lib/figures";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** Every figure drawn for (or added by) the person, newest first, with which one the 小帮手 shows. */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const figures = listFigures(access.ctx).map((figure) => ({ ...figure, url: figureUrl(figure) }));
  return Response.json({ ok: true, figures }, { headers: { "cache-control": "no-store" } });
}

/** `{file}` picks the figure the 小帮手 and the portrait show; `{file: null}` goes back to the latest drawing. Undoable. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { file?: unknown } | null;
  if (!body || !(typeof body.file === "string" || body.file === null)) return Response.json({ ok: false, code: "FIGURE_INVALID" }, { status: 400 });
  const result = await chooseFigure(access.ctx, body.file);
  return Response.json(result, { status: result.ok ? 200 : 404 });
}
