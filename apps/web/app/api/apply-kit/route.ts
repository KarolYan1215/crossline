import { KIT_DOCUMENT_KINDS, type KitDocumentKind, type KitEdit } from "@crossline/core";
import { editApplyKit } from "@crossline/db";
import { getStore } from "../../../lib/crossline";
import { opportunityOwner } from "../../../lib/opportunities";
import { writeGuard } from "../agent/guard";

/**
 * One edit of the 申请资料包 (docs/opportunity-agent.md §18.3): a short answer or a document added, changed or removed, each a new
 * version. Nothing here is sensitive (sensitive items stay in the worker's secret store through /api/apply-profile).
 */
export async function POST(request: Request) {
  const guard = await writeGuard(request);
  if ("response" in guard) return guard.response;
  if (!opportunityOwner(guard.ctx)) return Response.json({ ok: false, code: "OPPORTUNITY_NOT_OWNER" }, { status: 403 });
  const body = guard.body;
  const str = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
  const id = str(body.id, 40) || undefined;
  const edit: KitEdit | undefined = body.op === "answer" ? { op: "answer", id, prompt: str(body.prompt, 200), text: str(body.text, 4000) }
    : body.op === "remove_answer" && id ? { op: "remove_answer", id }
    : body.op === "document" && (KIT_DOCUMENT_KINDS as readonly string[]).includes(str(body.kind, 20))
      ? { op: "document", id, kind: str(body.kind, 20) as KitDocumentKind, label: str(body.label, 120), path: str(body.path, 500) }
    : body.op === "remove_document" && id ? { op: "remove_document", id } : undefined;
  if (!edit) return Response.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
  const result = editApplyKit(getStore(), guard.ctx.workspaceId, edit);
  return result.changed ? Response.json({ ok: true, version: result.kit.version, ...(result.id ? { id: result.id } : {}) })
    : Response.json({ ok: false, code: "APPLY_KIT_UNCHANGED" }, { status: 400 });
}
