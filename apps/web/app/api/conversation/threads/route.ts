import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { createThread, listThreads } from "../../../../lib/threads";

/** 小帮手's thread list (`?archived` for the archived ones). */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  return Response.json({ ok: true, threads: listThreads(access.ctx, { archived: new URL(request.url).searchParams.has("archived") }) });
}

/** `{title?}`: a new thread (named by its first line when no title is given). */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  return Response.json({ ok: true, thread: createThread(access.ctx, typeof body.title === "string" ? body.title : "") });
}
