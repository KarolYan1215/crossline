import { recordRetrospective } from "../../../../../lib/milestone-board";
import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";

/** Saves the note on a reached milestone's retrospective card. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { note?: unknown } | null;
  if (typeof body?.note !== "string") return Response.json({ ok: false, code: "RETROSPECTIVE_NOTE_REQUIRED" }, { status: 400 });
  const result = await recordRetrospective(access.ctx, id, body.note);
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
