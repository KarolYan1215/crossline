import { resolveAccessContext } from "../../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../../lib/same-origin";
import { updateThread } from "../../../../../lib/threads";

/** `{title?, archived?}`: rename a thread, archive it or bring it back. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { title?: unknown; archived?: unknown };
  const result = updateThread(access.ctx, id, { ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}) });
  return Response.json(result, { status: result.ok ? 200 : result.code === "THREAD_NOT_FOUND" ? 404 : 400 });
}
