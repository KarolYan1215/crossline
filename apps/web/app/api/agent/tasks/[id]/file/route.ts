import { resolveAccessContext } from "../../../../../../lib/access-guard";
import { readTaskFile } from "../../../../../../lib/agent";
import { validId } from "../../../guard";

/** One file the assistant made, to open on the review page. Only from the task's own directory, never a secret, never run. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const file = validId(id) ? readTaskFile(access.ctx, id, new URL(request.url).searchParams.get("path") ?? "") : undefined;
  if (!file) return Response.json({ ok: false, code: "FILE_NOT_FOUND" }, { status: 404 });
  return new Response(new Uint8Array(file.body), { headers: {
    "content-type": file.type, "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", "cache-control": "no-store"
  } });
}
