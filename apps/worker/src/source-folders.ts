import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FOLDER_MAX_ENTRIES, FOLDER_MAX_FILES, SOURCE_FOLDERS_SETTING, cleanFolderNames, cleanFolderRules, credentialName, credentialText, excludedByRules, folderFileAction, folderGroup, folderLabel,
  folderPathProblem, readSourceFolders, sensitiveName, sensitiveText, skipFolderDirectory, sourceFolderIndexSetting, sourceKindFor,
  type FolderIndexEntry, type SourceFolder, type SourceKind
} from "@crossline/core";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { ownerOf } from "./owner";

/**
 * Authorized folders (docs/onboarding-v3.md 「文件夹授权」; the rules are in `packages/core/src/source-folders.ts`). The worker walks a
 * folder, copies each readable file into the app's own `sources/` (by content hash, like an upload, so the reading never depends on the
 * original staying put) and has it read; a file it cannot read is recorded by name. On every tick it walks again and reads only what is
 * new or changed — the index keeps size and modification time per relative path.
 *
 * What is not read (decided 2026-10-15): what the person excluded (kept with the authorization), files that look like private papers by
 * name or by the IDs in their opening text unless the person includes them, second copies of one content, and past `FOLDER_MAX_FILES`
 * the least recently changed files. Excluding something already read removes it from `sources` again. Credentials — by name, extension or a
 * key in the opening text — are never read, and no `include` brings them back: that is enforced here, not in the page.
 */
export type ScannedFile = {
  relative: string; size: number; mtimeMs: number; action: ReturnType<typeof folderFileAction>;
  /** Why it looks like a private paper; not read unless the person includes it. */
  sensitive?: string;
  /** Same content as this other file, which is the one read. */
  duplicateOf?: string;
  /** Past the cap: one of the least recently changed files. */
  capped?: true;
};
export type FolderScan = {
  files: ScannedFile[]; read: number; nameOnly: number; bytes: number; skippedDirectories: number;
  /** Readable files past the cap, not read. */
  over: number;
  duplicates: number;
  /** The walk stopped at `FOLDER_MAX_ENTRIES`. */
  truncated: boolean;
  /** Credentials found, never read and never offered back. */
  credentials: Array<{ relative: string; reason: string }>;
};
type Rules = { exclude?: string[]; include?: string[]; names?: string[] };

const EXTENSION: Record<SourceKind, string> = { pdf: "pdf", docx: "docx", image: "img", audio: "audio", text: "txt" };
/** New or changed files read per folder per tick; the rest wait for the next one, so a large folder never holds the tick. */
const READ_PER_PASS = 40;
const slash = (relative: string) => relative.replace(/\\/g, "/");
const included = (relative: string, rules: Rules) => (rules.include ?? []).some((item) => item.toLowerCase() === slash(relative).toLowerCase());
/** Read in full (`read`) or recorded by name (`name_only`), as opposed to left out. */
const kept = (file: ScannedFile) => !file.sensitive && !file.duplicateOf && !file.capped;

/**
 * Walks a folder without following links (a junction can loop or lead anywhere), skipping what `skipFolderDirectory` names and what the
 * person excluded, then marks suspected private papers, second copies and what lies past the cap. Only files of the same size are hashed.
 */
// ponytail: same-size files are hashed on every scan; keep their hash in the index if a folder of many equal-size files gets slow.
export async function scanFolder(root: string, rules: Rules = {}, options: { peekText?: boolean } = {}): Promise<FolderScan> {
  const files: ScannedFile[] = [];
  const credentials: FolderScan["credentials"] = [];
  let entries = 0, skippedDirectories = 0, truncated = false;
  const queue = [""];
  walk: while (queue.length) {
    const relativeDir = queue.shift()!;
    let listing;
    try { listing = await readdir(path.join(root, relativeDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of listing) {
      if ((entries += 1) > FOLDER_MAX_ENTRIES) { truncated = true; break walk; }
      const relative = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (skipFolderDirectory(entry.name)) skippedDirectories += 1;
        else if (!excludedByRules(`${slash(relative)}/`, rules.exclude)) queue.push(relative);
        continue;
      }
      if (!entry.isFile() || excludedByRules(relative, rules.exclude)) continue;
      // A credential is listed (so the person sees it was found) and never read, whatever its kind.
      const credential = credentialName(relative);
      if (credential) { credentials.push({ relative: slash(relative), reason: credential }); continue; }
      // The name decides first, so files the app never reads (pictures, archives …) cost no disk read.
      if (folderFileAction(relative, 0).action === "skip") continue;
      let info;
      try { info = await stat(path.join(root, relative)); } catch { continue; }
      const sensitive = included(relative, rules) ? undefined : sensitiveName(relative, rules.names);
      files.push({ relative, size: info.size, mtimeMs: Math.round(info.mtimeMs), action: folderFileAction(relative, info.size), ...(sensitive ? { sensitive } : {}) });
    }
  }
  // The preview also checks text files' openings for keys and IDs (PDF and Word are checked when they are read, from their extracted text).
  if (options.peekText) for (const file of [...files]) {
    if (file.action.action !== "read" || file.action.kind !== "text") continue;
    const head = await opening(path.join(root, file.relative)).catch(() => "");
    const key = credentialText(head);
    if (key) { credentials.push({ relative: slash(file.relative), reason: `内容含${key}` }); files.splice(files.indexOf(file), 1); continue; }
    if (file.sensitive || included(file.relative, rules)) continue;
    const hit = sensitiveText(head);
    if (hit) file.sensitive = `内容含${hit}`;
  }
  const readable = files.filter((file) => file.action.action === "read" && !file.sensitive);
  const bySize = new Map<number, ScannedFile[]>();
  for (const file of readable) if (file.size > 0) bySize.set(file.size, [...(bySize.get(file.size) ?? []), file]);
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map<string, ScannedFile>();
    // The shortest name is the one read: 「开题报告.doc」 rather than 「开题报告 (2).doc」.
    for (const file of same.sort((a, b) => a.relative.length - b.relative.length || a.relative.localeCompare(b.relative))) {
      const hash = await readFile(path.join(root, file.relative)).then((bytes) => createHash("sha256").update(bytes).digest("hex")).catch(() => undefined);
      if (!hash) continue;
      const first = byHash.get(hash);
      if (first) file.duplicateOf = first.relative; else byHash.set(hash, file);
    }
  }
  const unique = readable.filter((file) => !file.duplicateOf).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of unique.slice(FOLDER_MAX_FILES)) file.capped = true;
  const toRead = unique.slice(0, FOLDER_MAX_FILES);
  return { files, read: toRead.length, nameOnly: files.filter((file) => file.action.action === "name_only" && !file.sensitive).length,
    bytes: toRead.reduce((sum, file) => sum + file.size, 0), skippedDirectories, over: Math.max(0, unique.length - FOLDER_MAX_FILES),
    duplicates: readable.length - unique.length, truncated, credentials };
}

/** The opening of a text file, for the ID check (PDF and Word are checked when they are read). */
async function opening(full: string): Promise<string> {
  const handle = await open(full, "r");
  try { const buffer = Buffer.alloc(2048); const { bytesRead } = await handle.read(buffer, 0, 2048, 0); return buffer.subarray(0, bytesRead).toString("utf8"); }
  finally { await handle.close(); }
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
  /** Reads a file's text (the worker's own `extractText`), before anything is kept, so a file whose text holds an ID is never stored. */
  readText: (bytes: Uint8Array, kind: StoredSourceDocument["kind"]) => Promise<{ status: StoredSourceDocument["extractionStatus"]; text: string; note?: string }>;
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

/** Profile facts that hold the person's name, in any script. */
const NAME_SLOTS = /^(name|full_name|legal_name|chinese_name|english_name|pinyin_name|preferred_name)$/;
/** The person's names: those given with the request (the account's) and any the profile has confirmed. */
export function personNames(store: CrosslineStore, workspaceId: string, given: unknown = []): string[] {
  const facts = store.listProfileFacts(workspaceId, { identityId: "person" }).filter((fact) => NAME_SLOTS.test(fact.slot) && !fact.value.startsWith("假设")).map((fact) => fact.value);
  return cleanFolderNames([...cleanFolderNames(given), ...facts]);
}

/** Files listed per group in the preview; the rest are counted. */
const LISTED_PER_GROUP = 300;
export type PreviewGroup = { name: string; files: number; nameOnly: number; bytes: number;
  list: Array<{ relative: string; size: number; nameOnly?: true; duplicates?: number }>; more: number };

/**
 * What authorizing a folder would read, before anything is read: grouped by top-level subfolder so the person can leave out a group or a
 * file, with suspected private papers listed apart (left out unless ticked back) and text files' openings checked for IDs.
 */
export async function previewFolder(raw: string, deps: FolderDeps, names: string[] = []) {
  const checked = await checkedPath(raw, deps);
  if (!checked.ok) return { state: "blocked" as const, code: "FOLDER_REFUSED", message: checked.message };
  const scan = await scanFolder(checked.path, { names }, { peekText: true });
  const copies = new Map<string, number>();
  for (const file of scan.files) if (file.duplicateOf) copies.set(file.duplicateOf, (copies.get(file.duplicateOf) ?? 0) + 1);
  const groups = new Map<string, PreviewGroup & { all: ScannedFile[] }>();
  for (const file of scan.files) {
    if (file.sensitive || file.duplicateOf) continue;
    const name = folderGroup(file.relative);
    const group = groups.get(name) ?? { name, files: 0, nameOnly: 0, bytes: 0, list: [], more: 0, all: [] };
    if (file.action.action === "read") { group.files += 1; group.bytes += file.size; } else group.nameOnly += 1;
    group.all.push(file);
    groups.set(name, group);
  }
  const sensitive = scan.files.filter((file) => file.sensitive).map((file) => ({ relative: slash(file.relative), reason: file.sensitive!, size: file.size,
    ...(file.action.action === "name_only" ? { nameOnly: true as const } : {}) }));
  return { state: "preview" as const, path: checked.path, label: folderLabel(checked.path), files: scan.read, nameOnly: scan.nameOnly, bytes: scan.bytes,
    skippedDirectories: scan.skippedDirectories, over: scan.over, duplicates: scan.duplicates, truncated: scan.truncated, limit: FOLDER_MAX_FILES,
    groups: [...groups.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).map(({ all, ...group }) => {
      const recent = all.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { ...group, more: Math.max(0, recent.length - LISTED_PER_GROUP), list: recent.slice(0, LISTED_PER_GROUP).map((file) => ({ relative: slash(file.relative), size: file.size,
        ...(file.action.action === "name_only" ? { nameOnly: true as const } : {}), ...(copies.get(file.relative) ? { duplicates: copies.get(file.relative)! } : {}) })) };
    }),
    sensitive: sensitive.slice(0, LISTED_PER_GROUP), sensitiveCount: sensitive.length,
    credentials: scan.credentials.slice(0, LISTED_PER_GROUP), credentialCount: scan.credentials.length };
}

export async function addFolder(store: CrosslineStore, workspaceId: string, raw: string, deps: FolderDeps, rules?: { exclude?: unknown; include?: unknown; names?: unknown }) {
  const checked = await checkedPath(raw, deps);
  if (!checked.ok) return { state: "blocked" as const, code: "FOLDER_REFUSED", message: checked.message };
  const clean = { ...cleanFolderRules(rules), names: personNames(store, workspaceId, rules?.names) };
  const existing = list(store, workspaceId).find((folder) => folder.path.toLowerCase() === checked.path.toLowerCase());
  if (existing) {
    // Authorized again from a fresh preview: the choices made in it replace the old ones (the next pass removes what they exclude).
    if (rules) update(store, workspaceId, existing.id, clean);
    return { state: "added" as const, folder: { ...existing, ...(rules ? clean : {}) } };
  }
  const folder: SourceFolder = { id: randomUUID().slice(0, 8), path: checked.path, label: folderLabel(checked.path), addedAt: new Date().toISOString(), lines: [], linesBy: "", ...clean };
  save(store, workspaceId, [...list(store, workspaceId), folder]);
  return { state: "added" as const, folder };
}

/**
 * Deletes the documents these index entries point at — only ones this folder's reading made, that no other folder and no remaining
 * entry of this one still uses — and the stored copy once no row reads it. Writes one ledger event with the count.
 */
function dropDocuments(store: CrosslineStore, workspaceId: string, folder: SourceFolder, dropped: FolderIndexEntry[],
  remaining: FolderIndexEntry[], dataDir: string, reason: "excluded" | "revoked"): number {
  const inUse = new Set(remaining.map((entry) => entry.documentId));
  for (const other of list(store, workspaceId)) if (other.id !== folder.id) for (const entry of Object.values(readIndex(store, workspaceId, other.id))) inUse.add(entry.documentId);
  const documents = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
  const sources = path.resolve(dataDir, "sources");
  let removed = 0;
  for (const entry of dropped) {
    const doc = documents.get(entry.documentId);
    // An index written before `created` existed: the folder's own documents are named after it; an upload with the same content is not.
    const made = entry.created ?? doc?.fileName.startsWith(`${folder.label}/`);
    if (!doc || !made || inUse.has(doc.id)) continue;
    const gone = store.deleteSourceDocument(workspaceId, doc.id);
    if (!gone) continue;
    removed += 1;
    if (gone.uriInUse) continue;
    // Only a copy in the app's own `sources/`: a name-only document points at the person's original, which is never touched.
    try { const file = fileURLToPath(gone.uri); if (path.resolve(file).startsWith(sources + path.sep)) rmSync(file, { force: true }); } catch { /* not a local copy */ }
  }
  if (removed) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `sources.folder_content_removed:${folder.id}:${randomUUID()}`,
    type: "sources.folder_content_removed", entityId: folder.id, payload: { folderId: folder.id, label: folder.label, removed, reason } });
  return removed;
}

/**
 * Stops reading a folder. By default what was already read stays — it is the person's material and may already be part of plans; with
 * `purge`, the documents this folder brought in are deleted too.
 */
export function removeFolder(store: CrosslineStore, workspaceId: string, id: string, options: { purge?: boolean; dataDir?: string } = {}): { removed: boolean; purged: number } {
  const before = list(store, workspaceId);
  const folder = before.find((item) => item.id === id);
  if (!folder) return { removed: false, purged: 0 };
  const purged = options.purge && options.dataDir ? dropDocuments(store, workspaceId, folder, Object.values(readIndex(store, workspaceId, id)), [], options.dataDir, "revoked") : 0;
  save(store, workspaceId, before.filter((item) => item.id !== id));
  store.deleteSetting(workspaceId, sourceFolderIndexSetting(id));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `sources.folder_revoked:${id}:${randomUUID()}`,
    type: "sources.folder_revoked", entityId: id, payload: { folderId: id, label: folder.label, purged } });
  return { removed: true, purged };
}

/** The person chose this folder's lines: kept as theirs, never replaced by the model again. */
export function setFolderLines(store: CrosslineStore, workspaceId: string, id: string, lines: string[]): boolean {
  if (!list(store, workspaceId).some((folder) => folder.id === id)) return false;
  update(store, workspaceId, id, { lines: [...new Set(lines)].slice(0, 8), linesBy: "person" });
  return true;
}

/**
 * The person changed what is left out after authorizing: the rules are saved and the folder is read again at once, which removes what
 * is now excluded and reads what was ticked back.
 */
export async function setFolderRules(store: CrosslineStore, workspaceId: string, id: string, rules: { exclude?: unknown; include?: unknown; names?: unknown }, deps: FolderDeps) {
  const folder = list(store, workspaceId).find((item) => item.id === id);
  if (!folder) return { saved: false as const };
  const clean = { ...cleanFolderRules(rules), names: personNames(store, workspaceId, [...cleanFolderNames(rules.names), ...(folder.names ?? [])]) };
  update(store, workspaceId, id, clean);
  const outcome = await syncFolder(store, workspaceId, { ...folder, ...clean }, deps);
  return { saved: true as const, ...outcome };
}

/**
 * Reads what is new or changed in one folder (at most `READ_PER_PASS` per call) and records what it saw; first removes what an exclusion
 * or a suspected private paper now leaves out. A file whose content is the same as one already stored becomes that document.
 */
export async function syncFolder(store: CrosslineStore, workspaceId: string, folder: SourceFolder, deps: FolderDeps): Promise<{ read: number; waiting: number; removed: number }> {
  const exists = await stat(folder.path).then((info) => info.isDirectory()).catch(() => false);
  if (!exists) { update(store, workspaceId, folder.id, { lastScanAt: new Date().toISOString(), lastError: "找不到这个文件夹了（移动、改名或拔掉了磁盘？）" }); return { read: 0, waiting: 0, removed: 0 }; }
  const saved = list(store, workspaceId).find((item) => item.id === folder.id) ?? folder;
  const rules = { ...saved, names: personNames(store, workspaceId, saved.names) };
  const scan = await scanFolder(folder.path, rules);
  const index = readIndex(store, workspaceId, folder.id);
  const present = new Map(scan.files.map((file) => [file.relative, file]));
  // Left out now (excluded, a credential, or a private paper not ticked back): what was read from it goes. Gone from disk: the entry goes,
  // the document stays.
  const dropped: FolderIndexEntry[] = [];
  for (const [relative, entry] of Object.entries(index)) {
    const file = present.get(relative);
    const leftOut = excludedByRules(relative, rules.exclude) || Boolean(file?.sensitive) || Boolean(credentialName(relative))
      || Boolean(!included(relative, rules) && (sensitiveName(relative, rules.names) || entry.flagged));
    if (leftOut) { if (entry.documentId) dropped.push(entry); delete index[relative]; }
    else if (!file) delete index[relative];
  }
  const removed = dropDocuments(store, workspaceId, folder, dropped, Object.values(index), deps.dataDir, "excluded");

  const changed = scan.files.filter((file) => {
    if (!kept(file)) return false;
    const known = index[file.relative];
    return !known || known.size !== file.size || known.mtimeMs !== file.mtimeMs || Boolean(known.sensitive && !known.hard && included(file.relative, rules));
  });
  const owner = ownerOf(store, workspaceId);
  const root = path.resolve(deps.dataDir, "sources");
  const bySha = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.sha256, doc]));
  const createdHere = new Set(Object.values(index).filter((entry) => entry.created).map((entry) => entry.documentId));
  let done = 0;
  for (const file of changed.slice(0, READ_PER_PASS)) {
    const full = path.join(folder.path, file.relative);
    const fileName = `${folder.label}/${slash(file.relative)}`.slice(-200);
    let doc: StoredSourceDocument | undefined;
    let created = false;
    let flagged: string | undefined;
    if (file.action.action === "read") {
      let bytes: Buffer;
      try { bytes = readFileSync(full); } catch { continue; }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      doc = bySha.get(sha256);
      if (doc) created = createdHere.has(doc.id);
      else {
        const result = await deps.readText(new Uint8Array(bytes), file.action.kind).catch(() => ({ status: "failed" as const, text: "", note: "解析失败。" }));
        // A key in its text: never kept, and no tick in the page brings it back.
        const key = credentialText(result.text);
        if (key) { index[file.relative] = { size: file.size, mtimeMs: file.mtimeMs, documentId: "", sensitive: `内容含${key}`, hard: true }; done += 1; continue; }
        const hit = sensitiveText(result.text);
        // Its text holds an ID or an account number: nothing is kept, and the card lists it as left out — unless the person ticked it back.
        if (hit && !included(file.relative, rules)) { index[file.relative] = { size: file.size, mtimeMs: file.mtimeMs, documentId: "", sensitive: `内容含${hit}` }; done += 1; continue; }
        if (hit) flagged = `内容含${hit}`;
        const target = path.resolve(root, `${sha256}.${EXTENSION[file.action.kind]}`);
        mkdirSync(root, { recursive: true });
        writeFileSync(target, bytes);
        const id = randomUUID();
        doc = store.saveSourceDocument({ id, ownerId: owner, workspaceId, kind: file.action.kind, fileName,
          mediaType: file.action.kind === "pdf" ? "application/pdf" : file.action.kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain",
          sha256, uri: pathToFileURL(target).href, extractedText: result.text, extractionStatus: result.status,
          ...(result.note ? { extractionNote: result.note } : {}), createdAt: new Date().toISOString() });
        created = doc.id === id;
        bySha.set(sha256, doc);
      }
    } else if (file.action.action === "name_only") {
      // Nothing is copied: the name, size and time are all that is kept, keyed so the same file seen again is the same row.
      const sha256 = createHash("sha256").update(`name-only:${full}:${file.size}:${file.mtimeMs}`).digest("hex");
      const id = randomUUID();
      doc = store.saveSourceDocument({ id, ownerId: owner, workspaceId, kind: sourceKindFor(file.relative, "") ?? "text", fileName,
        mediaType: "application/octet-stream", sha256, uri: pathToFileURL(full).href, extractedText: "", extractionStatus: "unsupported",
        extractionNote: file.action.reason, createdAt: new Date().toISOString() });
      created = doc.id === id;
    }
    if (doc) {
      index[file.relative] = { size: file.size, mtimeMs: file.mtimeMs, documentId: doc.id, ...(created ? { created: true } : {}), ...(flagged ? { flagged } : {}) };
      if (created) createdHere.add(doc.id);
      done += 1;
    }
  }
  store.setSetting(workspaceId, sourceFolderIndexSetting(folder.id), JSON.stringify(index));
  const autoExcluded = [
    ...scan.credentials.map((file) => ({ ...file, hard: true as const })),
    ...Object.entries(index).filter(([, entry]) => entry.sensitive && entry.hard).map(([relative, entry]) => ({ relative: slash(relative), reason: entry.sensitive!, hard: true as const })),
    ...scan.files.filter((file) => file.sensitive).map((file) => ({ relative: slash(file.relative), reason: file.sensitive! })),
    ...Object.entries(index).filter(([, entry]) => entry.sensitive && !entry.hard).map(([relative, entry]) => ({ relative: slash(relative), reason: entry.sensitive! }))
  ].slice(0, 300);
  const { lastError: _cleared, ...rest } = list(store, workspaceId).find((item) => item.id === folder.id) ?? folder;
  save(store, workspaceId, list(store, workspaceId).map((item) => item.id === folder.id
    ? { ...rest, lastScanAt: new Date().toISOString(), files: scan.read, nameOnly: scan.nameOnly, bytes: scan.bytes, capped: scan.over > 0 || scan.truncated,
      over: scan.over, duplicates: scan.duplicates, autoExcluded } : item));
  return { read: done, waiting: Math.max(0, changed.length - done), removed };
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
  for (const folder of list(store, workspaceId)) for (const entry of Object.values(readIndex(store, workspaceId, folder.id))) if (entry.documentId) byDocument.set(entry.documentId, folder);
  return byDocument;
}
