import { resolveAccessContext } from "../../../../lib/access-guard";
import { outputZip } from "../../../../lib/outputs";
import { validId } from "../../agent/guard";

/**
 * One zip of the output folder: a task (`?task=`), a line (`?line=`) or everything. Streamed, so the archive is never held whole; a part
 * past the limits is left out and said in `x-crossline-truncated`.
 */
export async function GET(request: Request) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const params = new URL(request.url).searchParams;
  const taskId = params.get("task") ?? "", lineId = params.get("line") ?? "";
  if ((taskId && !validId(taskId)) || (lineId && !/^[a-z0-9_-]{1,64}$/i.test(lineId))) return Response.json({ ok: false, code: "OUTPUT_SCOPE_INVALID" }, { status: 400 });
  const zip = outputZip(access.ctx, { ...(taskId ? { taskId } : {}), ...(lineId ? { lineId } : {}) });
  if (!zip) return Response.json({ ok: false, code: "OUTPUT_EMPTY" }, { status: 404 });
  return new Response(zip.stream, { headers: { "content-type": "application/zip", "cache-control": "no-store",
    "content-disposition": `attachment; filename="outputs.zip"; filename*=UTF-8''${encodeURIComponent(zip.fileName)}`,
    ...(zip.truncated ? { "x-crossline-truncated": "1" } : {}) } });
}
