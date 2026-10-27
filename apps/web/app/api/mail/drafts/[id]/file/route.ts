import { draftBodyOf } from "@crossline/core";
import { resolveAccessContext } from "../../../../../../lib/access-guard";
import { draftOf } from "../../../../../../lib/mail-drafts";
import { fileResponse } from "../../../../../materials/file-response";
import { tOf } from "../../../../../../lib/locale";

/**
 * One reply draft as a file of the viewer's own account (docs/personal-agent.md §3.1): drawn by the material page, downloaded with
 * `?download=1`, and `?part=body` gives the body alone as plain text for 「复制草稿」.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const found = draftOf(access.ctx, id);
  if (!found) return Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404 });
  if (new URL(request.url).searchParams.get("part") === "body") {
    return new Response(draftBodyOf(found.text), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  return fileResponse(request, { bytes: new TextEncoder().encode(found.text), fileName: tOf(access.ctx)("回复草稿-{{subject}}.md", { subject: found.draft.subject.replace(/[\\/:*?"<>|\r\n]/g, " ").slice(0, 60) || id }),
    src: `/api/mail/drafts/${id}/file` });
}
