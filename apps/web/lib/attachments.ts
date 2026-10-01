import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { CrosslineStore } from "@crossline/db";

const PROJECT_ROOT = path.resolve(process.cwd(), "..", "..");

/** Server-validated media types only — an uploaded file whose claimed type is not one of these is
 * refused, so a stored attachment is always served back with a type this app itself picked, never one
 * the uploader's browser happened to send. */
export const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "application/pdf": "pdf", "text/plain": "txt"
};

const MAX_BYTES = 10 * 1024 * 1024;

export function attachmentsRoot(captureId: string): string {
  return path.resolve(PROJECT_ROOT, ".crossline-attachments", captureId);
}

/** Mirrors `attachmentsRoot`, kept in its own directory so an assistant-thread file never reads as a
 * capture's own attachment — the two have different owners (a thread vs. a capture row) and different
 * lifetimes. */
export function assistantAttachmentsRoot(threadId: string): string {
  return path.resolve(PROJECT_ROOT, ".crossline-assistant-attachments", threadId);
}

/** Mirrors `attachmentsRoot` again, for a submitted-evidence file — see 工作块 E. Kept in its own
 * directory for the same reason the other two are: different owner, different lifetime, and (unlike
 * captures/assistant threads) read back server-side by `milestone-gate-runner.ts` for quoting, not just
 * served to a browser. */
export function evidenceAttachmentsRoot(workOrderId: string): string {
  return path.resolve(PROJECT_ROOT, ".crossline-evidence", workOrderId);
}

export type AttachmentSaveResult =
  | { ok: true; saved: Array<{ id: string; uri: string; mediaType: string; fileName: string }> }
  | { ok: false; code: string; message: string };

/**
 * Validates and writes uploaded files under `root`, mirroring the path-safety pattern
 * `apps/worker/src/materials.ts` already uses for prepared materials. Shared by `saveCaptureAttachments`
 * and `saveAssistantAttachments` — only the root directory and the ledger row each writes afterward
 * differ between the two.
 *
 * The on-disk name is always server-generated (`<uuid>.<ext>`), never derived from the uploader's own
 * file name — the original name is kept only as a display label in the ledger row, so there is nothing
 * in it that ever has to be sanitized into a safe path.
 */
function writeAttachmentFiles(root: string, files: Array<{ fileName: string; mediaType: string; buffer: Buffer }>):
  AttachmentSaveResult {
  const saved: Array<{ id: string; uri: string; mediaType: string; fileName: string }> = [];
  for (const file of files) {
    const ext = ALLOWED_ATTACHMENT_TYPES[file.mediaType];
    if (!ext) return { ok: false, code: "ATTACHMENT_TYPE_NOT_ALLOWED", message: `不支持的文件类型：${file.mediaType || "未知"}` };
    if (file.buffer.byteLength > MAX_BYTES) return { ok: false, code: "ATTACHMENT_TOO_LARGE", message: "单个文件不能超过 10MB。" };
    const target = path.resolve(root, `${randomUUID()}.${ext}`);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, code: "ATTACHMENT_PATH_OUTSIDE_ROOT", message: "附件路径越出获准目录；没有写入文件。" };
    }
    mkdirSync(root, { recursive: true });
    writeFileSync(target, file.buffer);
    // Generated once here and reused as the ledger row's own id below — the caller reports the same id
    // back to the uploader, so a turn can reference exactly the attachment that was actually stored.
    saved.push({ id: randomUUID(), uri: pathToFileURL(target).href, mediaType: file.mediaType, fileName: file.fileName });
  }
  return { ok: true, saved };
}

export function saveCaptureAttachments(store: CrosslineStore, input: {
  workspaceId: string; ownerId: string; captureId: string;
  files: Array<{ fileName: string; mediaType: string; buffer: Buffer }>;
}): AttachmentSaveResult {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.captureId)) {
    return { ok: false, code: "ATTACHMENT_CAPTURE_ID_INVALID", message: "无效的捕获 id；没有保存附件。" };
  }
  const result = writeAttachmentFiles(attachmentsRoot(input.captureId), input.files);
  if (!result.ok) return result;
  const createdAt = new Date().toISOString();
  for (const file of result.saved) {
    store.saveCaptureAttachment({ id: file.id, ownerId: input.ownerId, workspaceId: input.workspaceId,
      captureId: input.captureId, uri: file.uri, mediaType: file.mediaType, fileName: file.fileName.slice(0, 200), createdAt });
  }
  return result;
}

/** Same shape as `saveCaptureAttachments`, for the floating assistant's own threads — kept separate
 * because a thread and a capture are different entities with different tables, not because the file-
 * handling logic itself differs (see `writeAttachmentFiles`). */
export function saveAssistantAttachments(store: CrosslineStore, input: {
  workspaceId: string; ownerId: string; threadId: string;
  files: Array<{ fileName: string; mediaType: string; buffer: Buffer }>;
}): AttachmentSaveResult {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.threadId)) {
    return { ok: false, code: "ATTACHMENT_THREAD_ID_INVALID", message: "无效的会话 id；没有保存附件。" };
  }
  const result = writeAttachmentFiles(assistantAttachmentsRoot(input.threadId), input.files);
  if (!result.ok) return result;
  const createdAt = new Date().toISOString();
  for (const file of result.saved) {
    store.saveAssistantAttachment({ id: file.id, ownerId: input.ownerId, workspaceId: input.workspaceId,
      threadId: input.threadId, uri: file.uri, mediaType: file.mediaType, fileName: file.fileName.slice(0, 200), createdAt });
  }
  return result;
}

/**
 * Writes one submitted-evidence file to disk and hands back its `uri` — no ledger row here, unlike the
 * three functions above. The real ledger row is the `evidence_claims` insert `transitionWorkOrder`
 * already makes for a `kind:"file"` claim (`human.completed`); this only has to get the file safely onto
 * disk first so that claim's `uri` points at something real. The caller (the completion form) builds the
 * `EvidenceClaimInput` itself from the returned `uri`/`fileName`.
 */
export function saveEvidenceFile(input: {
  workOrderId: string; fileName: string; mediaType: string; buffer: Buffer;
}): { ok: true; uri: string; mediaType: string; fileName: string } | { ok: false; code: string; message: string } {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.workOrderId)) {
    return { ok: false, code: "ATTACHMENT_WORK_ORDER_ID_INVALID", message: "无效的作业 id；没有保存文件。" };
  }
  const result = writeAttachmentFiles(evidenceAttachmentsRoot(input.workOrderId),
    [{ fileName: input.fileName, mediaType: input.mediaType, buffer: input.buffer }]);
  if (!result.ok) return result;
  const saved = result.saved[0]!;
  return { ok: true, uri: saved.uri, mediaType: saved.mediaType, fileName: saved.fileName };
}
