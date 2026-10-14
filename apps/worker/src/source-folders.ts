import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  FOLDER_MAX_ENTRIES, FOLDER_MAX_FILES, SOURCE_FOLDERS_SETTING, folderFileAction, folderLabel, folderPathProblem, readSourceFolders,
  skipFolderDirectory, sourceFolderIndexSetting, sourceKindFor, type FolderIndexEntry, type SourceFolder, type SourceKind
} from "@crossline/core";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { ownerOf } from "./owner";

/**
 * Authorized folders (docs/onboarding-v3.md 「文件夹授权」; the rules are in `packages/core/src/source-folders.ts`). The worker walks a
 * folder, copies each readable file into the app's own `sources/` (by content hash, like an upload, so the reading never depends on the
 * original staying put) and has it read; a file it cannot read is recorded by name. On every tick it walks again and reads only what is
 * new or changed — the index keeps size and modification time per relative path.
 */
export type ScannedFile = { relative: string; size: number; mtimeMs: number; action: ReturnType<typeof folderFileAction> };
export type FolderScan = { files: ScannedFile[]; read: number; nameOnly: number; bytes: number; skippedDirectories: number; capped: boolean };

const EXTENSION: Record<SourceKind, string> = { pdf: "pdf", docx: "docx", image: "img", audio: "audio", text: "txt" };
/** New or changed files read per folder per tick; the rest wait for the next one, so a large folder never holds the tick. */
const READ_PER_PASS = 40;

/** Walks a folder without following links (a junction can loop or lead anywhere), skipping what `skipFolderDirectory` names. */
export async function scanFolder(root: string): Promise<FolderScan> {
  const files: ScannedFile[] = [];
  let entries = 0, skippedDirectories = 0, read = 0, capped = false;
  const queue = [""];
  while (queue.length) {
    const relativeDir = queue.shift()!;
    let listing;
    try { listing = await readdir(path.join(root, relativeDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of listing) {
      if ((entries += 1) > FOLDER_MAX_ENTRIES) { capped = true; break; }
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (skipFolderDirectory(entry.name)) skippedDirectories += 1; else queue.push(relative); continue; }
      if (!entry.isFile()) continue;
      let info;
      try { info = await stat(path.join(root, relative)); } catch { continue; }
      const action = folderFileAction(relative, info.size);
      if (action.action === "skip") continue;
      if (action.action === "read") { if (read >= FOLDER_MAX_FILES) { capped = true; continue; } read += 1; }
      files.push({ relative, size: info.size, mtimeMs: Math.round(info.mtimeMs), action });
    }
    if (capped && entries > FOLDER_MAX_ENTRIES) break;
  }
  return { files, read, nameOnly: files.filter((file) => file.action.action === "name_only").length,
    bytes: files.filter((file) => file.action.action === "read").reduce((sum, file) => sum + file.size, 0), skippedDirectories, capped };
}

const list = (store: CrosslineStore, workspaceId: string) => readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING));
const save = (store: CrosslineStore, workspaceId: string, folders: SourceFolder[]) => store.setSetting(workspaceId, SOURCE_FOLDERS_SETTING, JSON.stringify(folders));
const update = (store: CrosslineStore, workspaceId: string, id: string, patch: Partial<SourceFolder>) =>
  save(store, workspaceId, list(store, workspaceId).map((folder) => folder.id === id ? { ...folder, ...patch } : folder));
const readIndex = (store: CrosslineStore, workspaceId: string, id: string): Record<string, FolderIndexEntry> => {
  try { return JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting(id)) ?? "{}") as Record<string, FolderIndexEntry>; } catch { return {}; }
};

export type FolderDeps = {
  dataDir: string;
  home: string;
  /** Reads a stored document's text (the worker's own `extractSource`). */
  extract: (workspaceId: string, documentId: string) => Promise<unknown>;
};

/** Checks a path the person typed: absolute, an existing folder, and not one of the places `folderPathProblem` refuses. */
async function checkedPath(raw: string, deps: FolderDeps): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const problem = folderPathProblem(raw, { home: deps.home, appData: deps.dataDir });
  if (problem) return { ok: false, message: problem };
  const resolved = path.resolve(raw.trim());
  try { if (!(await stat(resolved)).isDirectory()) return { ok: false, message: "这不是一个文件夹" }; }
  catch { return { ok: false, message: "找不到这个文件夹" }; }
  return { ok: true, path: resolved };
}

/** What authorizing a folder would read, before anything is read: shown to the person first. */
export async function previewFolder(raw: string, deps: FolderDeps) {
  const checked = await checkedPath(raw, deps);
  if (!checked.ok) return { state: "blocked" as const, code: "FOLDER_REFUSED", message: checked.message };
  const scan = await scanFolder(checked.path);
  return { state: "preview" as const, path: checked.path, label: folderLabel(checked.path), files: scan.read, nameOnly: scan.nameOnly, bytes: scan.bytes,
    skippedDirectories: scan.skippedDirectories, capped: scan.capped, sample: scan.files.slice(0, 8).map((file) => file.relative) };
}

export async function addFolder(store: CrosslineStore, workspaceId: string, raw: string, deps: FolderDeps) {
  const checked = await checkedPath(raw, deps);
  if (!checked.ok) return { state: "blocked" as const, code: "FOLDER_REFUSED", message: checked.message };
  const existing = list(store, workspaceId).find((folder) => folder.path.toLowerCase() === checked.path.toLowerCase());
  if (existing) return { state: "added" as const, folder: existing };
  const folder: SourceFolder = { id: randomUUID().slice(0, 8), path: checked.path, label: folderLabel(checked.path), addedAt: new Date().toISOString(), lines: [], linesBy: "" };
  save(store, workspaceId, [...list(store, workspaceId), folder]);
  return { state: "added" as const, folder };
}

/** Stops reading a folder. What was already read stays: it is the person's material, and it may already be part of plans. */
export function removeFolder(store: CrosslineStore, workspaceId: string, id: string): boolean {
  const before = list(store, workspaceId);
  if (!before.some((folder) => folder.id === id)) return false;
  save(store, workspaceId, before.filter((folder) => folder.id !== id));
  store.deleteSetting(workspaceId, sourceFolderIndexSetting(id));
  return true;
}

/** The person chose this folder's lines: kept as theirs, never replaced by the model again. */
export function setFolderLines(store: CrosslineStore, workspaceId: string, id: string, lines: string[]): boolean {
  if (!list(store, workspaceId).some((folder) => folder.id === id)) return false;
  update(store, workspaceId, id, { lines: [...new Set(lines)].slice(0, 8), linesBy: "person" });
  return true;
}

/**
 * Reads what is new or changed in one folder (at most `READ_PER_PASS` per call) and records what it saw. A file whose content is the
 * same as one already stored becomes that document (the store keys documents by content hash).
 */
export async function syncFolder(store: CrosslineStore, workspaceId: string, folder: SourceFolder, deps: FolderDeps): Promise<{ read: number; waiting: number }> {
  const exists = await stat(folder.path).then((info) => info.isDirectory()).catch(() => false);
  if (!exists) { update(store, workspaceId, folder.id, { lastScanAt: new Date().toISOString(), lastError: "找不到这个文件夹了（移动、改名或拔掉了磁盘？）" }); return { read: 0, waiting: 0 }; }
  const scan = await scanFolder(folder.path);
  const index = readIndex(store, workspaceId, folder.id);
  const changed = scan.files.filter((file) => { const known = index[file.relative]; return !known || known.size !== file.size || known.mtimeMs !== file.mtimeMs; });
  const owner = ownerOf(store, workspaceId);
  const root = path.resolve(deps.dataDir, "sources");
  let done = 0;
  for (const file of changed.slice(0, READ_PER_PASS)) {
    const full = path.join(folder.path, file.relative);
    const fileName = `${folder.label}/${file.relative.replace(/\\/g, "/")}`.slice(-200);
    let doc: StoredSourceDocument | undefined;
    if (file.action.action === "read") {
      let bytes: Buffer;
      try { bytes = readFileSync(full); } catch { continue; }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const target = path.resolve(root, `${sha256}.${EXTENSION[file.action.kind]}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(target, bytes);
      doc = store.saveSourceDocument({ id: randomUUID(), ownerId: owner, workspaceId, kind: file.action.kind, fileName,
        mediaType: file.action.kind === "pdf" ? "application/pdf" : file.action.kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain",
        sha256, uri: pathToFileURL(target).href, extractedText: "", extractionStatus: "pending", createdAt: new Date().toISOString() });
      if (doc.extractionStatus === "pending") await deps.extract(workspaceId, doc.id).catch(() => undefined);
    } else if (file.action.action === "name_only") {
      // Nothing is copied: the name, size and time are all that is kept, keyed so the same file seen again is the same row.
      const sha256 = createHash("sha256").update(`name-only:${full}:${file.size}:${file.mtimeMs}`).digest("hex");
      doc = store.saveSourceDocument({ id: randomUUID(), ownerId: owner, workspaceId, kind: sourceKindFor(file.relative, "") ?? "text", fileName,
        mediaType: "application/octet-stream", sha256, uri: pathToFileURL(full).href, extractedText: "", extractionStatus: "unsupported",
        extractionNote: file.action.reason, createdAt: new Date().toISOString() });
    }
    if (doc) { index[file.relative] = { size: file.size, mtimeMs: file.mtimeMs, documentId: doc.id }; done += 1; }
  }
  // Files gone from the folder leave the index (their documents stay, as read).
  const present = new Set(scan.files.map((file) => file.relative));
  for (const relative of Object.keys(index)) if (!present.has(relative)) delete index[relative];
  store.setSetting(workspaceId, sourceFolderIndexSetting(folder.id), JSON.stringify(index));
  const { lastError: _cleared, ...rest } = list(store, workspaceId).find((item) => item.id === folder.id) ?? folder;
  save(store, workspaceId, list(store, workspaceId).map((item) => item.id === folder.id
    ? { ...rest, lastScanAt: new Date().toISOString(), files: scan.read, nameOnly: scan.nameOnly, bytes: scan.bytes, capped: scan.capped } : item));
  return { read: done, waiting: Math.max(0, changed.length - done) };
}

/** Every folder of a workspace, once (the tick's pass). */
export async function syncFolders(store: CrosslineStore, workspaceId: string, deps: FolderDeps) {
  const outcomes = [];
  for (const folder of list(store, workspaceId)) outcomes.push({ id: folder.id, ...(await syncFolder(store, workspaceId, folder, deps)) });
  return outcomes;
}

/** Documents that came from the authorized folders, by id, with the folder each came from. */
export function folderDocuments(store: CrosslineStore, workspaceId: string): Map<string, SourceFolder> {
  const byDocument = new Map<string, SourceFolder>();
  for (const folder of list(store, workspaceId)) for (const entry of Object.values(readIndex(store, workspaceId, folder.id))) byDocument.set(entry.documentId, folder);
  return byDocument;
}
