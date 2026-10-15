import { resolveAccessContext } from "../../../../../../lib/access-guard";
import { loadTaskAudit, outputNames, readTaskFile } from "../../../../../../lib/agent";
import { groupOutputs } from "../../../../../approvals/assistant-outputs";
import { fileResponse } from "../../../../../materials/file-response";
import { validId } from "../../../guard";

/**
 * One file the assistant made. Only from the task's own directory, never a secret, never run. How it is answered — opened in place, drawn
 * on the material page, previewed as data (`?view=preview`), downloaded (`?download=1`) — is `fileResponse` (app/materials): a Word file
 * used to come back as `application/octet-stream` with no name, so the browser saved it as 「file」 with no extension and nothing opened it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  // `?view=outputs`: what the run made, grouped by use (the review page's own grouping), for the task's materials to draw — with the
  // readable names of the files it read, so a stored copy's hash is shown as the file's own name.
  if (new URL(request.url).searchParams.get("view") === "outputs") {
    const audit = validId(id) ? loadTaskAudit(access.ctx, id) : undefined;
    if (!audit) return Response.json({ ok: false, code: "FILE_NOT_FOUND" }, { status: 404 });
    return Response.json({ ...groupOutputs(audit.artifacts), names: outputNames(access.ctx, id, audit) }, { headers: { "cache-control": "no-store" } });
  }
  const relative = new URL(request.url).searchParams.get("path") ?? "";
  const file = validId(id) ? readTaskFile(access.ctx, id, relative) : undefined;
  if (!file) return Response.json({ ok: false, code: "FILE_NOT_FOUND" }, { status: 404 });
  return fileResponse(request, { bytes: new Uint8Array(file.body), fileName: relative.split(/[\\/]/).pop() || "file",
    src: `/api/agent/tasks/${encodeURIComponent(id)}/file?path=${encodeURIComponent(relative)}` });
}
