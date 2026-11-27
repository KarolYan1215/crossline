import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { credentialName, credentialText, sourceKindFor, sourceModifiedSetting, sourceSizeLimit, type AccessContext, type SourceKind } from "@crossline/core";
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

export type SourceRefusal = { fileName: string; code: string; message: string };
export type SourceSaveResult =
  | { ok: true; documents: StoredSourceDocument[]; refused: SourceRefusal[] }
  | { ok: false; code: string; message: string; refused: SourceRefusal[] };
export type IncomingFile = { fileName: string; mediaType: string; buffer: Buffer; modifiedAt?: number };

/**
 * Stores each file on its own: one the app cannot take (a type it does not read, over the size limit, a credential) is refused and the
 * rest are kept (2026-11-22: one bad file used to fail the whole batch). Credentials are refused by name and by the opening of a text file
 * before anything is written; the worker checks the extracted text of every kind again before a model reads it. `ok: false` only when
 * nothing at all was kept, with the first refusal.
 */
export function saveSourceFiles(ctx: AccessContext, files: IncomingFile[], projectId?: string): SourceSaveResult {
  const store = getStore();
  const t = tOf(ctx);
  const documents: StoredSourceDocument[] = [];
  const refused: SourceRefusal[] = [];
  const root = sourcesRoot();
  for (const file of files) {
    const kind = sourceKindFor(file.fileName, file.mediaType);
    if (!kind) { refused.push({ fileName: file.fileName, code: "SOURCE_TYPE_NOT_ALLOWED", message: t("不支持的文件类型：{{type}}", { type: file.fileName }) }); continue; }
    const limit = sourceSizeLimit(file.fileName, kind);
    if (file.buffer.byteLength > limit) {
      refused.push({ fileName: file.fileName, code: "SOURCE_TOO_LARGE", message: t("{{name}} 超过大小上限（{{mb}}MB）。", { name: file.fileName, mb: Math.round(limit / 1024 / 1024) }) });
      continue;
    }
    if (credentialName(file.fileName) || (kind === "text" && credentialText(file.buffer.subarray(0, 2048).toString("utf8")))) {
      refused.push({ fileName: file.fileName, code: "SOURCE_CREDENTIAL", message: t("「{{name}}」像是密钥或密码文件，没有保存，也没有交给模型。", { name: file.fileName }) });
      continue;
    }
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const target = path.resolve(root, `${sha256}.${EXTENSION[kind]}`);
    if (path.relative(root, target).startsWith("..")) { refused.push({ fileName: file.fileName, code: "SOURCE_PATH_OUTSIDE_ROOT", message: t("文件路径越界；没有写入。") }); continue; }
    mkdirSync(root, { recursive: true });
    writeFileSync(target, file.buffer);
    const doc = store.saveSourceDocument({
      id: randomUUID(), ownerId: ctx.principalId, workspaceId: ctx.workspaceId, ...(projectId ? { projectId } : {}), kind,
      fileName: file.fileName.slice(0, 200), mediaType: file.mediaType || "application/octet-stream", sha256,
      uri: pathToFileURL(target).href, extractedText: "", extractionStatus: "pending", createdAt: new Date().toISOString()
    });
    // When the person's computer last changed it: a version signal for telling which of two versions is the latest (source-versions.ts).
    if (file.modifiedAt && Number.isFinite(file.modifiedAt)) store.setSetting(ctx.workspaceId, sourceModifiedSetting(doc.id), String(Math.round(file.modifiedAt)));
    documents.push(doc);
  }
  if (!documents.length && refused.length) return { ok: false, code: refused[0]!.code, message: refused[0]!.message, refused };
  return { ok: true, documents, refused };
}

export type UploadedDocument = { id: string; fileName: string; kind: SourceKind; extractionStatus: StoredSourceDocument["extractionStatus"]; extractionNote?: string;
  projectId?: string };

/** Files the worker reads at once for one upload: reading is mostly waiting on PDF parsing, and one slow file must not hold the rest. */
export const EXTRACT_CONCURRENCY = 4;

/**
 * Stores the files, then has the worker read them, several at once (a minute each at most), and answers with what came of each. The
 * bytes are safe before any reading starts, so a slow or failing parse never loses a file; with the worker down the documents stay
 * `pending` and `deferred` says so. A recording only joins the worker's transcription queue here (one at a time, on this computer's CPU),
 * so it never holds the other files. What the worker refused (a key inside a PDF) is gone and listed in `refused`.
 */
export async function uploadSources(ctx: AccessContext, files: IncomingFile[], projectId?: string):
  Promise<{ ok: true; documents: UploadedDocument[]; deferred: boolean; refused: SourceRefusal[] } | { ok: false; code: string; message: string; refused: SourceRefusal[] }> {
  const saved = saveSourceFiles(ctx, files, projectId);
  if (!saved.ok) return saved;
  const refused = [...saved.refused];
  let deferred = false;
  const pending = saved.documents.filter((item) => item.extractionStatus === "pending");
  let next = 0;
  const readNext = async () => {
    while (next < pending.length) {
      const document = pending[next++]!;
      try {
        const answer = await requestCodexSupervisor<{ state?: string; code?: string; message?: string } | undefined>(ctx, "/v1/sources/extract", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentId: document.id }),
          signal: AbortSignal.timeout(60_000)
        });
        if (answer?.state === "refused") refused.push({ fileName: document.fileName, code: answer.code ?? "SOURCE_CREDENTIAL", message: answer.message ?? "" });
      } catch { deferred = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, pending.length) }, readNext));
  const documents = getStore().listSourceDocuments(ctx.workspaceId)
    .filter((item) => saved.documents.some((doc) => doc.id === item.id))
    .map(({ id, fileName, kind, extractionStatus, extractionNote, projectId: assigned }) =>
      ({ id, fileName, kind, extractionStatus, ...(extractionNote ? { extractionNote } : {}), ...(assigned ? { projectId: assigned } : {}) }));
  return { ok: true, documents, deferred, refused };
}

/** Form files as the upload routes receive them. */
export async function formFiles(form: FormData): Promise<IncomingFile[]> {
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  // The browser's `lastModified` of each file, sent beside it (`modified`, in the same order): a File rebuilt on the server has none of its own.
  const modified = form.getAll("modified").map((value) => Number(value));
  return Promise.all(files.map(async (file, index) => ({ fileName: file.name || "file", mediaType: file.type, buffer: Buffer.from(await file.arrayBuffer()),
    ...(modified[index]! > 0 ? { modifiedAt: modified[index]! } : {}) })));
}
export type SourceRemoveResult = { ok: true; fileName: string } | { ok: false; code: "SOURCE_NOT_FOUND" | "SOURCE_FROM_FOLDER" };

/** How long a removed upload can be brought back (the notice's 「撤销」); its stored copy is deleted once this has passed. */
export const UNDO_WINDOW_MS = 10 * 60_000;
const TRASH_SETTING = "sources.trash";
type TrashEntry = Pick<StoredSourceDocument, "id" | "ownerId" | "kind" | "fileName" | "mediaType" | "sha256" | "uri" | "projectId"> & { at: number };
const readTrash = (ctx: AccessContext): TrashEntry[] => {
  try { const value = JSON.parse(getStore().getSetting(ctx.workspaceId, TRASH_SETTING) ?? "[]"); return Array.isArray(value) ? value as TrashEntry[] : []; } catch { return []; }
};
/** Deletes the stored copies whose undo window has passed (only a copy inside `sources/` that no row reads), and keeps the rest. */
function purgeTrash(ctx: AccessContext, trash: TrashEntry[], now: number): TrashEntry[] {
  const store = getStore();
  const kept = trash.filter((entry) => now - entry.at < UNDO_WINDOW_MS);
  for (const entry of trash.filter((item) => !kept.includes(item))) {
    if (kept.some((other) => other.uri === entry.uri) || store.sourceDocumentUriInUse(entry.uri)) continue;
    try {
      const file = path.resolve(fileURLToPath(entry.uri));
      if (file.startsWith(sourcesRoot() + path.sep)) rmSync(file, { force: true });
    } catch { /* not a local copy */ }
  }
  return kept;
}

/**
 * Takes back a file the person uploaded by mistake (2026-10-17 walkthrough, W-6): it had no way out, and kept being asked about as a
 * project's material. Asked nothing (2026-11-22): the row goes at once, so nothing reads it or asks which project it belongs to; its stored
 * copy waits `UNDO_WINDOW_MS` so the notice's 「撤销」 can bring it back, then goes unless another row (an identical upload, another
 * workspace's) still reads it, and only ever a copy inside `sources/`. A folder's file is excluded in the folder's own card instead,
 * where the exclusion is kept and obeyed on every scan.
 */
export function removeUploadedSource(ctx: AccessContext, id: string, now = Date.now()): SourceRemoveResult {
  const store = getStore();
  const doc = store.listSourceDocuments(ctx.workspaceId).find((item) => item.id === id);
  if (!doc) return { ok: false, code: "SOURCE_NOT_FOUND" };
  if (folderDocumentIds(ctx).has(id)) return { ok: false, code: "SOURCE_FROM_FOLDER" };
  const gone = store.deleteSourceDocument(ctx.workspaceId, id);
  if (!gone) return { ok: false, code: "SOURCE_NOT_FOUND" };
  const { kind, fileName, mediaType, sha256, uri, ownerId, projectId } = doc;
  const trash = purgeTrash(ctx, readTrash(ctx).filter((entry) => entry.id !== id), now);
  store.setSetting(ctx.workspaceId, TRASH_SETTING, JSON.stringify([...trash, { id, ownerId, kind, fileName, mediaType, sha256, uri, ...(projectId ? { projectId } : {}), at: now }].slice(-50)));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `source.removed:${id}:${now}`, type: "person.decided", entityId: id,
    payload: { fileName: doc.fileName, kind: doc.kind, by: "person", subject: "source", decision: "removed" } });
  return { ok: true, fileName: doc.fileName };
}

export type SourceRestoreResult = { ok: true; fileName: string } | { ok: false; code: "SOURCE_NOT_IN_TRASH" | "SOURCE_FILE_GONE" };

/**
 * The notice's 「撤销」: a removed upload comes back under its own id, read again by the worker (its text was not kept in the trash). Only
 * within `UNDO_WINDOW_MS`, and only while its stored copy is still there.
 */
export async function restoreUploadedSource(ctx: AccessContext, id: string, now = Date.now()): Promise<SourceRestoreResult> {
  const store = getStore();
  const trash = purgeTrash(ctx, readTrash(ctx), now);
  const entry = trash.find((item) => item.id === id);
  if (!entry) { store.setSetting(ctx.workspaceId, TRASH_SETTING, JSON.stringify(trash)); return { ok: false, code: "SOURCE_NOT_IN_TRASH" }; }
  store.setSetting(ctx.workspaceId, TRASH_SETTING, JSON.stringify(trash.filter((item) => item.id !== id)));
  let present = false;
  try { present = existsSync(fileURLToPath(entry.uri)); } catch { present = false; }
  if (!present) return { ok: false, code: "SOURCE_FILE_GONE" };
  const doc = store.saveSourceDocument({ id: entry.id, ownerId: entry.ownerId, workspaceId: ctx.workspaceId, ...(entry.projectId ? { projectId: entry.projectId } : {}),
    kind: entry.kind, fileName: entry.fileName, mediaType: entry.mediaType, sha256: entry.sha256, uri: entry.uri, extractedText: "", extractionStatus: "pending",
    createdAt: new Date(now).toISOString() });
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `source.restored:${id}:${now}`, type: "person.decided", entityId: doc.id,
    payload: { fileName: entry.fileName, by: "person", subject: "source", decision: "restored" } });
  // The same content uploaded again meanwhile is that row; otherwise the restored row is read again.
  if (doc.id === entry.id) {
    await requestCodexSupervisor<unknown>(ctx, "/v1/sources/extract", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentId: doc.id }), signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
  }
  return { ok: true, fileName: entry.fileName };
}
