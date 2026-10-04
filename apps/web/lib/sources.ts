import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_SIZE_LIMIT, sourceKindFor, type AccessContext, type SourceKind } from "@crossline/core";
import type { StoredSourceDocument } from "@crossline/db";
import { dataDirectory, getStore } from "./crossline";

/**
 * Files the person hands over so the system can learn about them: a syllabus, a lecture plan, notes, a
 * recording. They live under the installation's own data directory (`sources/`), not beside the code, so
 * a backup that takes the ledger takes the files too.
 *
 * The on-disk name is the content hash plus a type-derived extension, never anything from the uploader:
 * there is nothing in a file name that ever has to be sanitised into a path, and the same file dropped
 * twice is one file.
 */
const EXTENSION: Record<SourceKind, string> = { pdf: "pdf", docx: "docx", image: "img", audio: "audio", text: "txt" };

export function sourcesRoot(): string {
  return path.resolve(dataDirectory(), "sources");
}

export type SourceSaveResult =
  | { ok: true; documents: StoredSourceDocument[] }
  | { ok: false; code: string; message: string };

export function saveSourceFiles(ctx: AccessContext,
  files: Array<{ fileName: string; mediaType: string; buffer: Buffer }>, projectId?: string): SourceSaveResult {
  const store = getStore();
  const documents: StoredSourceDocument[] = [];
  const root = sourcesRoot();
  for (const file of files) {
    const kind = sourceKindFor(file.fileName, file.mediaType);
    if (!kind) return { ok: false, code: "SOURCE_TYPE_NOT_ALLOWED", message: `不支持的文件类型：${file.fileName}` };
    if (file.buffer.byteLength > SOURCE_SIZE_LIMIT[kind]) {
      return { ok: false, code: "SOURCE_TOO_LARGE", message: `${file.fileName} 超过大小上限（${Math.round(SOURCE_SIZE_LIMIT[kind] / 1024 / 1024)}MB）。` };
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const target = path.resolve(root, `${sha256}.${EXTENSION[kind]}`);
    if (path.relative(root, target).startsWith("..")) return { ok: false, code: "SOURCE_PATH_OUTSIDE_ROOT", message: "文件路径越界；没有写入。" };
    mkdirSync(root, { recursive: true });
    writeFileSync(target, file.buffer);
    documents.push(store.saveSourceDocument({
      id: randomUUID(), ownerId: ctx.principalId, workspaceId: ctx.workspaceId, ...(projectId ? { projectId } : {}), kind,
      fileName: file.fileName.slice(0, 200), mediaType: file.mediaType || "application/octet-stream", sha256,
      uri: pathToFileURL(target).href, extractedText: "", extractionStatus: "pending", createdAt: new Date().toISOString()
    }));
  }
  return { ok: true, documents };
}
