import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SOURCE_SIZE_LIMIT, sourceKindFor, type AccessContext, type SourceKind } from "@crossline/core";
import type { StoredSourceDocument } from "@crossline/db";
import { dataDirectory, getStore } from "./crossline";
import { requestCodexSupervisor } from "./codex-runtime";
import { tOf } from "./locale";
import { folderDocumentIds } from "./onboarding-board";

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
    if (!kind) return { ok: false, code: "SOURCE_TYPE_NOT_ALLOWED", message: tOf(ctx)("不支持的文件类型：{{type}}", { type: file.fileName }) };
    if (file.buffer.byteLength > SOURCE_SIZE_LIMIT[kind]) {
      return { ok: false, code: "SOURCE_TOO_LARGE", message: tOf(ctx)("{{name}} 超过大小上限（{{mb}}MB）。", { name: file.fileName, mb: Math.round(SOURCE_SIZE_LIMIT[kind] / 1024 / 1024) }) };
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const target = path.resolve(root, `${sha256}.${EXTENSION[kind]}`);
    if (path.relative(root, target).startsWith("..")) return { ok: false, code: "SOURCE_PATH_OUTSIDE_ROOT", message: tOf(ctx)("文件路径越界；没有写入。") };
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

export type UploadedDocument = { id: string; fileName: string; kind: SourceKind; extractionStatus: StoredSourceDocument["extractionStatus"]; extractionNote?: string;
  projectId?: string };

/**
 * Stores the files, then has the worker read each one (one at a time, a minute each at most), and answers with what came of it. The
 * bytes are safe before any reading starts, so a slow or failing parse never loses a file; with the worker down the documents stay
 * `pending` and `deferred` says so.
 */
export async function uploadSources(ctx: AccessContext, files: Array<{ fileName: string; mediaType: string; buffer: Buffer }>, projectId?: string):
  Promise<{ ok: true; documents: UploadedDocument[]; deferred: boolean } | { ok: false; code: string; message: string }> {
  const saved = saveSourceFiles(ctx, files, projectId);
  if (!saved.ok) return saved;
  let deferred = false;
  for (const document of saved.documents.filter((item) => item.extractionStatus === "pending")) {
    try {
      await requestCodexSupervisor<unknown>(ctx, "/v1/sources/extract", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId: document.id }),
        signal: AbortSignal.timeout(60_000)
      });
    } catch { deferred = true; }
  }
  const documents = getStore().listSourceDocuments(ctx.workspaceId)
    .filter((item) => saved.documents.some((doc) => doc.id === item.id))
    .map(({ id, fileName, kind, extractionStatus, extractionNote, projectId: assigned }) =>
      ({ id, fileName, kind, extractionStatus, ...(extractionNote ? { extractionNote } : {}), ...(assigned ? { projectId: assigned } : {}) }));
  return { ok: true, documents, deferred };
}

/** Form files as the upload routes receive them. */
export async function formFiles(form: FormData): Promise<Array<{ fileName: string; mediaType: string; buffer: Buffer }>> {
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  return Promise.all(files.map(async (file) => ({ fileName: file.name || "file", mediaType: file.type, buffer: Buffer.from(await file.arrayBuffer()) })));
}

export type SourceRemoveResult = { ok: true; fileName: string } | { ok: false; code: "SOURCE_NOT_FOUND" | "SOURCE_FROM_FOLDER" };

/**
 * Takes back a file the person uploaded by mistake (2026-10-17 walkthrough, W-6): it had no way out, and kept being asked about as a
 * project's material. The row goes, so nothing asks which project it belongs to any more; the stored copy goes too unless another row
 * (an identical upload, another workspace's) still reads it, and only ever a copy inside `sources/`. A folder's file is excluded in the
 * folder's own card instead, where the exclusion is kept and obeyed on every scan.
 */
export function removeUploadedSource(ctx: AccessContext, id: string): SourceRemoveResult {
  const store = getStore();
  const doc = store.listSourceDocuments(ctx.workspaceId).find((item) => item.id === id);
  if (!doc) return { ok: false, code: "SOURCE_NOT_FOUND" };
  if (folderDocumentIds(ctx).has(id)) return { ok: false, code: "SOURCE_FROM_FOLDER" };
  const gone = store.deleteSourceDocument(ctx.workspaceId, id);
  if (!gone) return { ok: false, code: "SOURCE_NOT_FOUND" };
  if (!gone.uriInUse) {
    try {
      const file = path.resolve(fileURLToPath(gone.uri));
      if (file.startsWith(sourcesRoot() + path.sep)) rmSync(file, { force: true });
    } catch { /* not a local copy */ }
  }
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `source.removed:${id}`, type: "source.removed", entityId: id,
    payload: { fileName: doc.fileName, kind: doc.kind, by: "person" } });
  return { ok: true, fileName: doc.fileName };
}
