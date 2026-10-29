import { saveEvidenceFile } from "../../../../../lib/attachments";
import { getStore } from "../../../../../lib/crossline";
import { rejectUnsafeRequest } from "../guard";
import { localeFor } from "../../../../../lib/locale";

const MAX_FILES = 5;

/**
 * Uploads a file as task-completion evidence for AI review (see 工作块 E) — writes to
 * `.crossline-evidence/<workOrderId>/`, with no ledger row of its own: the caller (`TaskCompletion`)
 * includes the returned `uri` in a `kind:"file"` entry of the `evidence` array it then submits to
 * `POST /api/work-orders/[id]/execution`, and that route's `human.completed` handling is what actually
 * writes the `evidence_claims` row. Restricted to `active` orders — a file only makes sense attached to a
 * completion that is actually happening right now.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const { ctx } = guard;
  const order = getStore().getWorkOrder(ctx.workspaceId, id);
  if (!order) return Response.json({ code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  if (order.state !== "active") return Response.json({ code: "EXECUTION_NOT_ACTIVE" }, { status: 409 });

  const form = await request.formData().catch(() => null);
  if (!form) return Response.json({ code: "INVALID_UPLOAD" }, { status: 400 });
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (!files.length || files.length > MAX_FILES) return Response.json({ code: "ATTACHMENT_COUNT_INVALID" }, { status: 400 });

  const saved: Array<{ uri: string; fileName: string; mediaType: string }> = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = saveEvidenceFile({ workOrderId: id, fileName: file.name || "evidence", mediaType: file.type, buffer, locale: localeFor(ctx) });
    if (!result.ok) return Response.json({ code: result.code, message: result.message }, { status: 400 });
    saved.push({ uri: result.uri, fileName: result.fileName, mediaType: result.mediaType });
  }
  return Response.json({ saved });
}
