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

export type AttachmentSaveResult =
  | { ok: true; saved: Array<{ uri: string; mediaType: string; fileName: string }> }
  | { ok: false; code: string; message: string };

/**
 * Writes uploaded capture attachments to `.crossline-attachments/<captureId>/`, mirroring the path-
 * safety pattern `apps/worker/src/materials.ts` already uses for prepared materials.
 *
 * The on-disk name is always server-generated (`<uuid>.<ext>`), never derived from the uploader's own
 * file name — the original name is kept only as a display label in the ledger row, so there is nothing
 * in it that ever has to be sanitized into a safe path.
 */
export function saveCaptureAttachments(store: CrosslineStore, input: {
  workspaceId: string; ownerId: string; captureId: string;
  files: Array<{ fileName: string; mediaType: string; buffer: Buffer }>;
}): AttachmentSaveResult {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.captureId)) {
    return { ok: false, code: "ATTACHMENT_CAPTURE_ID_INVALID", message: "无效的捕获 id；没有保存附件。" };
  }
  const root = attachmentsRoot(input.captureId);
  const saved: Array<{ uri: string; mediaType: string; fileName: string }> = [];
  for (const file of input.files) {
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
    const uri = pathToFileURL(target).href;
    const createdAt = new Date().toISOString();
    store.saveCaptureAttachment({ id: randomUUID(), ownerId: input.ownerId, workspaceId: input.workspaceId,
      captureId: input.captureId, uri, mediaType: file.mediaType, fileName: file.fileName.slice(0, 200), createdAt });
    saved.push({ uri, mediaType: file.mediaType, fileName: file.fileName });
  }
  return { ok: true, saved };
}
