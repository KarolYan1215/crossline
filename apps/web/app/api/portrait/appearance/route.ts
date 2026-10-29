import { resolveAccessContext } from "../../../../lib/access-guard";
import { setAppearance } from "../../../../lib/portrait";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

/** `{text}` records how the person says they look, `{skip: true}` a neutral figure (`setAppearance`); the next figure is drawn from it. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { text?: unknown; skip?: unknown } | null;
  const result = setAppearance(access.ctx, { ...(typeof body?.text === "string" ? { text: body.text } : {}), skip: body?.skip === true });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
