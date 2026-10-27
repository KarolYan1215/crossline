import { getStore } from "../../../../../../lib/crossline";
import { uploadSources } from "../../../../../../lib/sources";
import { settleProvideStep } from "../../../../../../lib/steps";
import { rejectUnsafeRequest } from "../../guard";

const MAX_FILES = 10;

/**
 * The person hands over the material a provide step asks for (2026-10-22: the person's own material comes first): the files are stored and
 * read like any upload, filed under the task's project so every plan and tutorial of it finds them, and the step is done. Form fields
 * `stepId` and `file` (one or more).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const guard = await rejectUnsafeRequest(request, id);
  if ("response" in guard) return guard.response;
  const { ctx } = guard;
  const order = getStore().getWorkOrder(ctx.workspaceId, id);
  if (!order) return Response.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const stepId = form?.get("stepId");
  const files = (form?.getAll("file") ?? []).filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (typeof stepId !== "string" || !files.length || files.length > MAX_FILES) return Response.json({ ok: false, code: "UPLOAD_INVALID" }, { status: 400 });
  const uploaded = await uploadSources(ctx, await Promise.all(files.map(async (file) => ({ fileName: file.name || "material", mediaType: file.type,
    buffer: Buffer.from(await file.arrayBuffer()) }))), order.projectId || undefined);
  if (!uploaded.ok) return Response.json(uploaded, { status: 400 });
  const settled = settleProvideStep(ctx, id, stepId, "file", uploaded.documents.map((document) => document.id));
  return Response.json(settled, { status: settled.ok ? 200 : 400 });
}
