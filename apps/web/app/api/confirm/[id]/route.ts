import type { EvidenceClaimInput } from "@crossline/db";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { saveEvidenceFile } from "../../../../lib/attachments";
import { confirmBlock, confirmView, type ConfirmAnswer } from "../../../../lib/confirm";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { localeFor } from "../../../../lib/locale";

const KINDS = new Set<ConfirmAnswer["kind"]>(["as_planned", "over", "under", "not_done"]);
const MAX_FILES = 5;

/**
 * The answer to a completion check (docs/loop-and-scout.md §3), sent from the confirm page as a form: `kind`, `minutes`, `useActivity`,
 * and — when the last step of a milestone-bound task is confirmed — an optional `note` and `file`s as its evidence. The notification only
 * opens the page; nothing is written by following a link.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const kind = String(form?.get("kind") ?? "") as ConfirmAnswer["kind"];
  if (!form || !KINDS.has(kind)) return Response.json({ ok: false, code: "CONFIRM_ANSWER_INVALID" }, { status: 400 });
  const view = confirmView(access.ctx, id);
  if (!view) return Response.json({ ok: false, code: "CONFIRM_NOT_FOUND" }, { status: 404 });
  const evidence: EvidenceClaimInput[] = [];
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length > MAX_FILES) return Response.json({ ok: false, code: "ATTACHMENT_COUNT_INVALID" }, { status: 400 });
  for (const file of files) {
    const saved = saveEvidenceFile({ workOrderId: view.orderId, fileName: file.name || "evidence", mediaType: file.type, buffer: Buffer.from(await file.arrayBuffer()), locale: localeFor(access.ctx) });
    if (!saved.ok) return Response.json({ ok: false, code: saved.code, message: saved.message }, { status: 400 });
    evidence.push({ kind: "file", uri: saved.uri, description: saved.fileName });
  }
  const note = String(form.get("note") ?? "").trim().slice(0, 500);
  if (note) evidence.push({ kind: "record", uri: `note:${view.orderId}`, description: note });
  const minutes = Number(form.get("minutes") ?? 0);
  const result = confirmBlock(access.ctx, id, { kind, ...(Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
    ...(form.get("useActivity") === "1" ? { useActivity: true } : {}), ...(evidence.length ? { evidence } : {}) });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
