import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEVICE_FOLDER_SCREEN_LIMIT, FOLDER_MAX_ENTRIES, chatHistoryName, FOLDER_MAX_FILES, RECORDING_SETTLE_MS, SOURCE_FOLDERS_SETTING, cleanFolderNames, cleanFolderRules, credentialName, credentialText, excludedByRules, folderFileAction, folderGroup, folderLabel,
  folderPathProblem, LOCAL_ONLY_MASK, PDK_TERMS_SETTING, pdkHit, readPdkTerms, readSourceFolders, redactSecrets, sensitiveName, sensitiveText, skipFolderDirectory,
  sourceFolderIndexSetting, sourceKindFor, type FolderIndexEntry, type SourceFolder, type SourceKind, tFor, type Locale
} from "@crossline/core";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { ownerOf } from "./owner";
import { privacyOf } from "./git-commits";
import { localeOf } from "./locale";

/** 「内容含身份证号」: what a file's opening was found to hold, said in the workspace's language (the label is core's). */
const contains = (what: string, locale: Locale | undefined) => { const t = tFor(locale); return t("内容含{{what}}", { what: t(what) }); };

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
  /** Past the cap: one of the least recently changed files. */
  capped?: true;
};
export type FolderScan = {
  files: ScannedFile[]; read: number; nameOnly: number; bytes: number; skippedDirectories: number;
  /** Readable files past the cap, not read. */
  over: number;
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
const kept = (file: ScannedFile) => !file.sensitive && !file.capped;

/**
 * 「仅本地」 (docs/plans/execution-gates-1124.md 四.0 「隐私」, 2026-11-24, the owner's safety boundary): a folder the person marked local
 * only, or a file whose path hits a PDK term (`privacy.pdkTerms`), is never opened — not read, not extracted, not listed to a model, not
 * transcribed. Only a masked entry is kept (`[仅本地]` and the extension, the modified time and the size), as evidence that it changed.
 */
export const pdkTermsOf = (store: CrosslineStore, workspaceId: string) => privacyOf(store, workspaceId).terms;
export const localOnlyFile = (folder: SourceFolder, relative: string, terms: readonly string[]) => Boolean(folder.localOnly) || pdkHit(path.join(folder.path, relative), terms);
/** A folder's name as it may be shown to a model or sent: masked when the folder is local only or its path hits a PDK term. */
export const shownFolderLabel = (folder: SourceFolder, terms: readonly string[]) => folder.localOnly || pdkHit(folder.path, terms) ? LOCAL_ONLY_MASK : folder.label;
/** A masked entry's document: its name is `[仅本地]` and the extension. */
const maskedDocument = (fileName: string) => (fileName.split("/").pop() ?? "").startsWith(LOCAL_ONLY_MASK);

/**
 * Walks a folder without following links (a junction can loop or lead anywhere), skipping what `skipFolderDirectory` names and what the
 * person excluded, then marks suspected private papers and what lies past the cap. Copies of one content are not judged here: identical
 * bytes become one stored row when read, and versions of one document are the model's call after reading (source-versions.ts) — the old
 * rule that kept the copy with the shortest name is gone (2026-11-22).
 */
export async function scanFolder(root: string, rules: Rules = {}, options: { peekText?: boolean; audio?: boolean; locale?: Locale } = {}): Promise<FolderScan> {
  const audio = { audio: Boolean(options.audio), locale: options.locale };
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
      if (folderFileAction(relative, 0, audio).action === "skip") continue;
      let info;
      try { info = await stat(path.join(root, relative)); } catch { continue; }
      const sensitive = included(relative, rules) ? undefined : sensitiveName(relative, rules.names);
      files.push({ relative, size: info.size, mtimeMs: Math.round(info.mtimeMs), action: folderFileAction(relative, info.size, audio), ...(sensitive ? { sensitive } : {}) });
    }
  }
  // The preview also checks text files' openings for keys and IDs (PDF and Word are checked when they are read, from their extracted text).
  if (options.peekText) for (const file of [...files]) {
    if (file.action.action !== "read" || file.action.kind !== "text") continue;
    const head = await opening(path.join(root, file.relative)).catch(() => "");
    const key = credentialText(head);
    if (key) { credentials.push({ relative: slash(file.relative), reason: contains(key, options.locale) }); files.splice(files.indexOf(file), 1); continue; }
    if (file.sensitive || included(file.relative, rules)) continue;
    const hit = sensitiveText(head);
    if (hit) file.sensitive = contains(hit, options.locale);
  }
  const readable = files.filter((file) => file.action.action === "read" && !file.sensitive).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of readable.slice(FOLDER_MAX_FILES)) file.capped = true;
  const toRead = readable.slice(0, FOLDER_MAX_FILES);
  return { files, read: toRead.length, nameOnly: files.filter((file) => file.action.action === "name_only" && !file.sensitive).length,
    bytes: toRead.reduce((sum, file) => sum + file.size, 0), skippedDirectories, over: Math.max(0, readable.length - FOLDER_MAX_FILES),
    truncated, credentials };
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
  /**
   * Reads a file's text (the worker's own `readSourceText`: an AI conversation export keeps only what the person said), before anything is
   * kept, so a file whose text holds an ID is never stored.
   */
  readText: (bytes: Uint8Array, kind: StoredSourceDocument["kind"], locale?: Locale, fileName?: string) => Promise<{ status: StoredSourceDocument["extractionStatus"]; text: string; note?: string }>;
  /** This computer's own folders (the machine owner, not the hosted server or a linked device): listed, and read when the interview asks. */
  onDemand?: boolean;
  /** 录音自动转写 is on: recordings are queued for transcription (`recordings.ts`) instead of being left alone. */
  audio?: boolean;
  now?: () => number;
};

/** Checks a path the person typed: absolute, an existing folder, and not one of the places `folderPathProblem` refuses. */
async function checkedPath(raw: string, deps: FolderDeps, locale?: Locale): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const t = tFor(locale);
  const problem = folderPathProblem(raw, { home: deps.home, appData: deps.dataDir, ...(locale ? { locale } : {}) });
  if (problem) return { ok: false, message: problem };
  const resolved = path.resolve(raw.trim());
  try { if (!(await stat(resolved)).isDirectory()) return { ok: false, message: t("这不是一个文件夹") }; }
  catch { return { ok: false, message: t("找不到这个文件夹") }; }
  return { ok: true, path: resolved };
}

/** Profile facts that hold the person's name, in any script. */
const NAME_SLOTS = /^(name|full_name|legal_name|chinese_name|english_name|pinyin_name|preferred_name)$/;
/** The person's names: those given with the request (the account's) and any the profile has confirmed. */
export function personNames(store: CrosslineStore, workspaceId: string, given: unknown = []): string[] {
  const facts = store.listProfileFacts(workspaceId, { identityId: "person" }).filter((fact) => NAME_SLOTS.test(fact.slot) && !fact.value.startsWith("假设")).map((fact) => fact.value); // i18n-ignore: the stored assumption marker
  return cleanFolderNames([...cleanFolderNames(given), ...facts]);
}

/** Files listed per group in the preview; the rest are counted. */
const LISTED_PER_GROUP = 300;
export type PreviewGroup = { name: string; files: number; nameOnly: number; bytes: number;
  list: Array<{ relative: string; size: number; nameOnly?: true }>; more: number };

/**
 * What authorizing a folder would read, before anything is read: grouped by top-level subfolder so the person can leave out a group or a
 * file, with suspected private papers listed apart (left out unless ticked back) and text files' openings checked for IDs.
 */
export async function previewFolder(raw: string, deps: FolderDeps, names: string[] = [], locale?: Locale) {
  const checked = await checkedPath(raw, deps, locale);
  if (!checked.ok) return { state: "blocked" as const, code: "FOLDER_REFUSED", message: checked.message };
  const scan = await scanFolder(checked.path, { names }, { peekText: true, ...(locale ? { locale } : {}) });
  const groups = new Map<string, PreviewGroup & { all: ScannedFile[] }>();
  for (const file of scan.files) {
    if (file.sensitive) continue;
    const name = folderGroup(file.relative);
    const group = groups.get(name) ?? { name, files: 0, nameOnly: 0, bytes: 0, list: [], more: 0, all: [] };
    if (file.action.action === "read") { group.files += 1; group.bytes += file.size; } else group.nameOnly += 1;
    group.all.push(file);
    groups.set(name, group);
  }
  const sensitive = scan.files.filter((file) => file.sensitive).map((file) => ({ relative: slash(file.relative), reason: file.sensitive!, size: file.size,
    ...(file.action.action === "name_only" ? { nameOnly: true as const } : {}) }));
  return { state: "preview" as const, path: checked.path, label: folderLabel(checked.path), files: scan.read, nameOnly: scan.nameOnly, bytes: scan.bytes,
    skippedDirectories: scan.skippedDirectories, over: scan.over, truncated: scan.truncated, limit: FOLDER_MAX_FILES,
    groups: [...groups.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).map(({ all, ...group }) => {
      const recent = all.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { ...group, more: Math.max(0, recent.length - LISTED_PER_GROUP), list: recent.slice(0, LISTED_PER_GROUP).map((file) => ({ relative: slash(file.relative), size: file.size,
        ...(file.action.action === "name_only" ? { nameOnly: true as const } : {}) })) };
    }),
    sensitive: sensitive.slice(0, LISTED_PER_GROUP), sensitiveCount: sensitive.length,
    credentials: scan.credentials.slice(0, LISTED_PER_GROUP), credentialCount: scan.credentials.length };
}

export async function addFolder(store: CrosslineStore, workspaceId: string, raw: string, deps: FolderDeps, rules?: { exclude?: unknown; include?: unknown; names?: unknown }) {
  const checked = await checkedPath(raw, deps, localeOf(store, workspaceId));
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
    type: "person.decided", entityId: folder.id, payload: { folderId: folder.id, label: folder.label, removed, reason, subject: "sources", decision: "folder_content_removed" } });
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
    type: "person.decided", entityId: id, payload: { folderId: id, label: folder.label, purged, subject: "sources", decision: "folder_revoked" } });
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
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const exists = await stat(folder.path).then((info) => info.isDirectory()).catch(() => false);
  if (!exists) { update(store, workspaceId, folder.id, { lastScanAt: new Date().toISOString(), lastError: t("找不到这个文件夹了（移动、改名或拔掉了磁盘？）") }); return { read: 0, waiting: 0, removed: 0 }; }
  const saved = list(store, workspaceId).find((item) => item.id === folder.id) ?? folder;
  const rules = { ...saved, names: personNames(store, workspaceId, saved.names) };
  const scan = await scanFolder(folder.path, rules, { audio: Boolean(deps.audio), locale });
  const index = readIndex(store, workspaceId, folder.id);
  const present = new Map(scan.files.map((file) => [file.relative, file]));
  const terms = pdkTermsOf(store, workspaceId);
  const privateFile = (relative: string) => localOnlyFile(saved, relative, terms);
  let masked: Set<string> | undefined;
  const isMasked = (documentId: string) => Boolean(documentId) && (masked ??= new Set(store.listSourceDocuments(workspaceId)
    .filter((doc) => maskedDocument(doc.fileName)).map((doc) => doc.id))).has(documentId);
  // Left out now (excluded, a credential, or a private paper not ticked back): what was read from it goes. Gone from disk: the entry goes,
  // the document stays. An entry that does not match the file's 「仅本地」 state goes too — content read before the folder was marked, a
  // queued recording, or a masked entry after the mark was taken off — so the file is handled again the way it now should be.
  const dropped: FolderIndexEntry[] = [];
  for (const [relative, entry] of Object.entries(index)) {
    const file = present.get(relative);
    const leftOut = excludedByRules(relative, rules.exclude) || Boolean(file?.sensitive) || Boolean(credentialName(relative))
      || Boolean(!included(relative, rules) && (sensitiveName(relative, rules.names) || entry.flagged)) || privateFile(relative) !== isMasked(entry.documentId);
    if (leftOut) { if (entry.documentId) dropped.push(entry); delete index[relative]; }
    // A recording's entry outlives 录音自动转写 being off (the scan then does not list recordings), so what was done is not redone.
    else if (!file && !(entry.audio && !deps.audio)) delete index[relative];
  }
  const removed = dropDocuments(store, workspaceId, folder, dropped, Object.values(index), deps.dataDir, "excluded");

  // New or changed recordings join the queue once they have settled (a file still being written or synced is left for the next pass).
  const now = deps.now?.() ?? Date.now();
  for (const file of scan.files) {
    if (file.action.action !== "audio" || file.sensitive || privateFile(file.relative)) continue;
    const known = index[file.relative];
    if (known?.audio && known.size === file.size && known.mtimeMs === file.mtimeMs) continue;
    if (now - file.mtimeMs < RECORDING_SETTLE_MS) continue;
    index[file.relative] = { size: file.size, mtimeMs: file.mtimeMs, documentId: "", audio: "queued" };
  }

  const changed = scan.files.filter((file) => {
    // A recording in a 「仅本地」 place is recorded like any of its files: masked, never transcribed.
    if (!kept(file) || (file.action.action === "audio" && !privateFile(file.relative))) return false;
    const known = index[file.relative];
    return !known || known.size !== file.size || known.mtimeMs !== file.mtimeMs || Boolean(known.sensitive && !known.hard && included(file.relative, rules));
  });
  // On the person's own computer an authorized folder is not imported (D3, 2026-11-22): what was there when it was authorized is only
  // listed, and the interview opens a file when it needs it (`readFolderFile`). What the person writes there afterwards is read as before —
  // it is new work, which the deliverable check compares with their tasks — and so is anything already read that changed.
  const authorizedAt = Date.parse(saved.addedAt);
  // AI conversations (D14) are the exception: a folder of Codex, Claude Code or ChatGPT exports is given to be read and digested segment
  // by segment (chat-digest.ts), which only works on what was read; listing them would leave the history unused (docs/plans/desktop-local-1122.md).
  const listOnly = (file: ScannedFile) => Boolean(deps.onDemand) && !privateFile(file.relative) && !chatHistoryName(file.relative) && !index[file.relative]?.documentId
    && !(Number.isFinite(authorizedAt) && file.mtimeMs >= authorizedAt);
  for (const file of changed.filter(listOnly)) index[file.relative] = { size: file.size, mtimeMs: file.mtimeMs, documentId: "", listed: true };
  const toRead = changed.filter((file) => !listOnly(file));
  const reading = readingContext(store, workspaceId, index);
  let done = 0;
  for (const file of toRead.slice(0, READ_PER_PASS)) {
    const entry = privateFile(file.relative) ? localOnlyEntry(store, workspaceId, saved, file, terms, reading)
      : await importFolderFile(store, workspaceId, folder, file, rules, deps, reading);
    if (!entry) continue;
    index[file.relative] = entry;
    done += 1;
  }
  store.setSetting(workspaceId, sourceFolderIndexSetting(folder.id), JSON.stringify(index));
  const autoExcluded = [
    ...scan.credentials.map((file) => ({ ...file, hard: true as const })),
    ...Object.entries(index).filter(([, entry]) => entry.sensitive && entry.hard).map(([relative, entry]) => ({ relative: slash(relative), reason: entry.sensitive!, hard: true as const })),
    ...scan.files.filter((file) => file.sensitive).map((file) => ({ relative: slash(file.relative), reason: file.sensitive! })),
    ...Object.entries(index).filter(([, entry]) => entry.sensitive && !entry.hard).map(([relative, entry]) => ({ relative: slash(relative), reason: entry.sensitive! }))
  ].slice(0, 300);
  const { lastError: _cleared, onDemand: _mode, imported: _count, ...rest } = list(store, workspaceId).find((item) => item.id === folder.id) ?? folder;
  // Copies of one content are one stored row: the entries beyond the first that point at a document already pointed at.
  const documents = Object.values(index).map((entry) => entry.documentId).filter(Boolean);
  const imported = new Set(documents).size;
  save(store, workspaceId, list(store, workspaceId).map((item) => item.id === folder.id
    ? { ...rest, lastScanAt: new Date().toISOString(), files: scan.read, nameOnly: scan.nameOnly, bytes: scan.bytes, capped: scan.over > 0 || scan.truncated,
      over: scan.over, duplicates: documents.length - imported, autoExcluded, ...(deps.onDemand ? { onDemand: true as const, imported } : {}) } : item));
  return { read: done, waiting: Math.max(0, toRead.length - done), removed };
}

type ReadingContext = { owner: string; bySha: Map<string, StoredSourceDocument>; createdHere: Set<string> };
const readingContext = (store: CrosslineStore, workspaceId: string, index: Record<string, FolderIndexEntry>): ReadingContext => ({
  owner: ownerOf(store, workspaceId), bySha: new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.sha256, doc])),
  createdHere: new Set(Object.values(index).filter((entry) => entry.created).map((entry) => entry.documentId)) });

/**
 * A 「仅本地」 file's entry: the file is never opened. Its document holds no text, a masked name (`[仅本地]` and the extension, under the
 * folder's masked name), and the modified time and size in its note; its address is not the file's, so nothing can open it through
 * the document either. Keyed by path, size and time, so the same file unchanged is the same row and a change is a new one.
 */
function localOnlyEntry(store: CrosslineStore, workspaceId: string, folder: SourceFolder, file: Pick<ScannedFile, "relative" | "size" | "mtimeMs">,
  terms: readonly string[], reading: ReadingContext): FolderIndexEntry {
  const t = tFor(localeOf(store, workspaceId));
  const sha256 = createHash("sha256").update(`local-only:${path.join(folder.path, file.relative)}:${file.size}:${file.mtimeMs}`).digest("hex");
  const id = randomUUID();
  const doc = store.saveSourceDocument({ id, ownerId: reading.owner, workspaceId, kind: "text",
    fileName: `${shownFolderLabel(folder, terms)}/${LOCAL_ONLY_MASK}${path.extname(file.relative).toLowerCase().slice(0, 12)}`,
    mediaType: "application/octet-stream", sha256, uri: `crossline-local-only:${sha256}`, extractedText: "", extractionStatus: "unsupported",
    extractionNote: t("仅本地：内容不读，只记修改时间 {{at}}、大小 {{size}} 字节", { at: new Date(file.mtimeMs).toISOString(), size: file.size }),
    createdAt: new Date().toISOString() });
  const created = doc.id === id;
  if (created) reading.createdHere.add(doc.id);
  return { size: file.size, mtimeMs: file.mtimeMs, documentId: doc.id, ...(created ? { created: true } : {}) };
}

/**
 * Reads one file of a folder into `sources` and answers its new index entry (undefined when it could not be read from disk). The checks run
 * before anything is kept: a key in the text is never kept and no tick brings it back; a text holding an ID or an account number is left
 * out unless the person ticked it back; keys anywhere else in a kept text are cut out. A file whose bytes are already stored becomes that row.
 */
async function importFolderFile(store: CrosslineStore, workspaceId: string, folder: SourceFolder, file: Pick<ScannedFile, "relative" | "size" | "mtimeMs" | "action">,
  rules: Rules, deps: FolderDeps, reading: ReadingContext): Promise<FolderIndexEntry | undefined> {
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const full = path.join(folder.path, file.relative);
  const fileName = `${folder.label}/${slash(file.relative)}`.slice(-200);
  const base = { size: file.size, mtimeMs: file.mtimeMs };
  let doc: StoredSourceDocument | undefined;
  let created = false;
  let flagged: string | undefined;
  if (file.action.action === "read") {
    let bytes: Buffer;
    try { bytes = readFileSync(full); } catch { return undefined; }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    doc = reading.bySha.get(sha256);
    if (doc) created = reading.createdHere.has(doc.id);
    else {
      const result = await deps.readText(new Uint8Array(bytes), file.action.kind, locale, file.relative).catch(() => ({ status: "failed" as const, text: "", note: t("解析失败。") }));
      // A key in its text: never kept, and no tick in the page brings it back.
      const key = credentialText(result.text);
      if (key) return { ...base, documentId: "", sensitive: contains(key, locale), hard: true };
      const hit = sensitiveText(result.text);
      // Its text holds an ID or an account number: nothing is kept, and the card lists it as left out — unless the person ticked it back.
      if (hit && !included(file.relative, rules)) return { ...base, documentId: "", sensitive: contains(hit, locale) };
      if (hit) flagged = contains(hit, locale);
      const root = path.resolve(deps.dataDir, "sources");
      const target = path.resolve(root, `${sha256}.${EXTENSION[file.action.kind]}`);
      mkdirSync(root, { recursive: true });
      writeFileSync(target, bytes);
      const id = randomUUID();
      doc = store.saveSourceDocument({ id, ownerId: reading.owner, workspaceId, kind: file.action.kind, fileName,
        mediaType: file.action.kind === "pdf" ? "application/pdf" : file.action.kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain",
        sha256, uri: pathToFileURL(target).href, extractedText: redactSecrets(result.text).text, extractionStatus: result.status,
        ...(result.note ? { extractionNote: result.note } : {}), createdAt: new Date().toISOString() });
      created = doc.id === id;
      reading.bySha.set(sha256, doc);
    }
  } else if (file.action.action === "name_only") {
    // Nothing is copied: the name, size and time are all that is kept, keyed so the same file seen again is the same row.
    const sha256 = createHash("sha256").update(`name-only:${full}:${file.size}:${file.mtimeMs}`).digest("hex");
    const id = randomUUID();
    doc = store.saveSourceDocument({ id, ownerId: reading.owner, workspaceId, kind: sourceKindFor(file.relative, "") ?? "text", fileName,
      mediaType: "application/octet-stream", sha256, uri: pathToFileURL(full).href, extractedText: "", extractionStatus: "unsupported",
      extractionNote: file.action.reason, createdAt: new Date().toISOString() });
    created = doc.id === id;
  }
  if (!doc) return undefined;
  if (created) reading.createdHere.add(doc.id);
  return { ...base, documentId: doc.id, ...(created ? { created: true } : {}), ...(flagged ? { flagged } : {}) };
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

/**
 * Who may open folder files on demand: set once by the worker (the machine owner's workspace, never on the hosted server). The interview's
 * read tools (onboarding-read-tools.ts) ask here, so a guest's interview and a hosted one never get the tools.
 */
let folderReading: { deps: FolderDeps; allowed: (workspaceId: string) => boolean } | undefined;
export function configureFolderReading(value: typeof folderReading): void { folderReading = value; }
export function folderReaderFor(workspaceId: string): FolderDeps | undefined {
  return folderReading?.allowed(workspaceId) ? { ...folderReading.deps, onDemand: true } : undefined;
}

/** A relative path the model gave, made safe: forward slashes, no drive, no leading slash, no `..`; undefined when it is none of these. */
function cleanRelative(raw: string): string | undefined {
  const relative = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(relative) || relative.startsWith("/") || relative.split("/").some((part) => part === "..")) return undefined;
  return relative;
}

/** The real path of `relative` inside the folder, or undefined when it leads outside it (`..`, a link, a junction). */
async function inside(folder: SourceFolder, relative: string): Promise<string | undefined> {
  const root = await realpath(folder.path).catch(() => undefined);
  if (!root) return undefined;
  const full = path.resolve(root, relative);
  const real = await realpath(full).catch(() => undefined);
  if (!real) return undefined;
  const within = path.relative(root, real);
  if (within.startsWith("..") || path.isAbsolute(within)) return undefined;
  if ((await lstat(full).catch(() => undefined))?.isSymbolicLink()) return undefined;
  return real;
}

/** Why a file of a folder is not shown to a model, or undefined: the same rules the walk obeys (D15: a folder's private papers are skipped). */
function leftOutOf(folder: SourceFolder, relative: string, names: string[], locale: Locale | undefined, terms: readonly string[]): string | undefined {
  const t = tFor(locale);
  if (localOnlyFile(folder, relative, terms)) return t("这是仅本地的文件夹或文件，内容不读。");
  if (relative.split("/").slice(0, -1).some(skipFolderDirectory) || excludedByRules(relative, folder.exclude)) return t("这个位置已被排除。");
  if (credentialName(relative)) return t("这是密钥或密码类文件，不读。");
  if (!included(relative, folder) && sensitiveName(relative, names)) return t("像是私人证件或单据，授权文件夹里的这类文件不读。");
  return undefined;
}

export type FolderListing = { ok: true; text: string } | { ok: false; message: string };

/**
 * One directory of an authorized folder, for the interview to browse (read-only): subfolders, then readable files with size, date and,
 * when one was already read, its document id. Credentials, private papers and what the person excluded are not listed.
 */
export async function listFolderEntries(store: CrosslineStore, workspaceId: string, folderId: string | undefined, rawDir = "", page = 0): Promise<FolderListing> {
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const folders = list(store, workspaceId);
  const terms = pdkTermsOf(store, workspaceId);
  if (!folderId) {
    return { ok: true, text: folders.length ? folders.map((folder) => t("{{id}} · {{label}} · {{files}} 个可读文件，已读入 {{imported}} 个",
      { id: folder.id, label: shownFolderLabel(folder, terms), files: folder.files ?? 0, imported: folder.imported ?? 0 })).join("\n") : t("还没有授权的文件夹。") };
  }
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return { ok: false, message: t("没有 id 为「{{id}}」的授权文件夹。", { id: folderId }) };
  const dir = cleanRelative(rawDir);
  if (dir === undefined) return { ok: false, message: t("只能浏览授权文件夹以内的位置。") };
  const real = dir ? await inside(folder, dir) : await realpath(folder.path).catch(() => undefined);
  if (!real) return { ok: false, message: t("只能浏览授权文件夹以内的位置。") };
  let listing;
  try { listing = await readdir(real, { withFileTypes: true }); } catch { return { ok: false, message: t("读不到这个位置。") }; }
  const names = personNames(store, workspaceId, folder.names);
  const index = readIndex(store, workspaceId, folder.id);
  const documentOf = new Map(Object.entries(index).map(([relative, entry]) => [slash(relative), entry.documentId]));
  const lines: string[] = [];
  for (const entry of listing.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || leftOutOf(folder, entry.isDirectory() ? `${relative}/x` : relative, names, locale, terms)) continue;
    if (entry.isDirectory()) { if (!skipFolderDirectory(entry.name)) lines.push(`${relative}/`); continue; }
    if (!entry.isFile() || folderFileAction(relative, 0).action === "skip") continue;
    const info = await stat(path.join(real, entry.name)).catch(() => undefined);
    if (!info) continue;
    const read = documentOf.get(relative);
    lines.push(`${relative} · ${Math.max(1, Math.round(info.size / 1024))} KB · ${new Date(info.mtimeMs).toISOString().slice(0, 10)}${read ? ` · ${t("已读入")}` : ""}`);
  }
  const pages = Math.max(1, Math.ceil(lines.length / LISTED_PER_PAGE));
  const at = Math.min(Math.max(0, page), pages - 1);
  const shown = lines.slice(at * LISTED_PER_PAGE, (at + 1) * LISTED_PER_PAGE);
  return { ok: true, text: shown.length ? `${t("《{{folder}}》/{{dir}}，第 {{page}}/{{pages}} 页：", { folder: shownFolderLabel(folder, terms), dir, page: at + 1, pages })}\n${shown.join("\n")}`
    : t("《{{folder}}》/{{dir}} 里没有可读的文件。", { folder: shownFolderLabel(folder, terms), dir }) };
}
/** Entries one listing call answers. */
const LISTED_PER_PAGE = 200;

/**
 * Opens one file of an authorized folder for the interview (D3): the same checks as the walk — inside the folder only, nothing excluded,
 * no credential, no private paper — then it is read into `sources` like any folder file (keys refused, IDs leave it out), so later turns,
 * quotes and planning can cite it. A file already read and unchanged is not read again.
 */
export async function readFolderFile(store: CrosslineStore, workspaceId: string, deps: FolderDeps, folderId: string, rawRelative: string):
  Promise<{ ok: true; doc: StoredSourceDocument } | { ok: false; message: string }> {
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const folder = list(store, workspaceId).find((item) => item.id === folderId);
  if (!folder) return { ok: false, message: t("没有 id 为「{{id}}」的授权文件夹。", { id: folderId }) };
  const relative = cleanRelative(rawRelative);
  const real = relative ? await inside(folder, relative) : undefined;
  if (!relative || !real) return { ok: false, message: t("只能读授权文件夹以内的文件。") };
  const names = personNames(store, workspaceId, folder.names);
  const refused = leftOutOf(folder, relative, names, locale, pdkTermsOf(store, workspaceId));
  if (refused) return { ok: false, message: refused };
  const info = await stat(real).catch(() => undefined);
  if (!info?.isFile()) return { ok: false, message: t("找不到这个文件。") };
  const action = folderFileAction(relative, info.size, { locale });
  if (action.action !== "read") return { ok: false, message: action.action === "name_only" ? action.reason : t("这种文件读不了正文。") };
  const index = readIndex(store, workspaceId, folder.id);
  const key = Object.keys(index).find((item) => slash(item) === relative) ?? relative.split("/").join(path.sep);
  const known = index[key];
  const mtimeMs = Math.round(info.mtimeMs);
  const stored = known?.documentId && known.size === info.size && known.mtimeMs === mtimeMs ? store.listSourceDocuments(workspaceId).find((doc) => doc.id === known.documentId) : undefined;
  if (stored) return { ok: true, doc: stored };
  if (known?.hard || (known?.sensitive && known.size === info.size && known.mtimeMs === mtimeMs)) return { ok: false, message: t("这个文件的内容含{{what}}，不读。", { what: known.sensitive ?? "" }) };
  const entry = await importFolderFile(store, workspaceId, folder, { relative: key, size: info.size, mtimeMs, action }, folder, deps, readingContext(store, workspaceId, index));
  if (!entry) return { ok: false, message: t("读不到这个文件。") };
  // Read the index again: a pass may have written it while the file was being read.
  const now = readIndex(store, workspaceId, folder.id);
  now[key] = entry;
  store.setSetting(workspaceId, sourceFolderIndexSetting(folder.id), JSON.stringify(now));
  if (!entry.documentId) return { ok: false, message: t("这个文件的内容含{{what}}，不读。", { what: entry.sensitive ?? "" }) };
  const doc = store.listSourceDocuments(workspaceId).find((item) => item.id === entry.documentId);
  return doc ? { ok: true, doc } : { ok: false, message: t("读不到这个文件。") };
}

/**
 * One file of an authorized folder as its bytes, for the phone (docs/plans/remote-control-1122.md §6.3): the same checks as reading it —
 * inside the folder, no link, nothing excluded, no credential, no private paper — and 20 MB at most. Nothing is read into the ledger.
 */
export async function folderFileBytes(store: CrosslineStore, workspaceId: string, folderId: string, rawRelative: string, maxBytes: number):
  Promise<{ ok: true; name: string; size: number; data: Buffer } | { ok: false; message: string }> {
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const folder = list(store, workspaceId).find((item) => item.id === folderId);
  if (!folder) return { ok: false, message: t("没有 id 为「{{id}}」的授权文件夹。", { id: folderId }) };
  const relative = cleanRelative(rawRelative);
  const real = relative ? await inside(folder, relative) : undefined;
  if (!relative || !real) return { ok: false, message: t("只能读授权文件夹以内的文件。") };
  const refused = leftOutOf(folder, relative, personNames(store, workspaceId, folder.names), locale, pdkTermsOf(store, workspaceId));
  if (refused) return { ok: false, message: refused };
  const info = await stat(real).catch(() => undefined);
  if (!info?.isFile()) return { ok: false, message: t("找不到这个文件。") };
  if (info.size > maxBytes) return { ok: false, message: t("文件超过 {{mb}} MB。", { mb: Math.round(maxBytes / 1_048_576) }) };
  const known = readIndex(store, workspaceId, folder.id)[Object.keys(readIndex(store, workspaceId, folder.id)).find((item) => slash(item) === relative) ?? ""];
  if (known?.sensitive || known?.hard) return { ok: false, message: t("这个文件的内容含{{what}}，不读。", { what: known.sensitive ?? "" }) };
  return { ok: true, name: path.basename(real), size: info.size, data: await readFile(real) };
}

/** A listed file as the screening sees it: the relative path with `/`, its size and its modification time. */
export type ListedFile = { path: string; size: number; modified: number };
/**
 * The site's answer for one folder's listed files: the paths it keeps, `"unavailable"` when it had no model answer (no model, quota), or
 * undefined when it could not be reached (the files stay listed and are offered again on the next pass).
 */
export type ScreenListed = (folder: string, files: ListedFile[]) => Promise<string[] | "unavailable" | undefined>;

/**
 * A linked device's folders (D3, docs/plans/2026-11-22-interview-and-import-redesign.md §四.4): its site cannot open a file later, so what
 * an authorized folder held when it was authorized is only listed (`syncFolder` with `onDemand`), the list — names, sizes and dates, never
 * content — is screened by the site's model, and only the files it keeps are read in, through `readFolderFile` with every check the walk
 * makes (inside the folder, nothing excluded, no credential, no private paper; keys in the text refuse the file). Without a model answer
 * the most recently changed files are kept, as the page does for a folder picked in the browser. The rest are marked `screened` and not
 * offered again. Answers how many files were read in.
 */
export async function importScreenedFiles(store: CrosslineStore, workspaceId: string, deps: FolderDeps, screen: ScreenListed): Promise<number> {
  let read = 0;
  const terms = pdkTermsOf(store, workspaceId);
  for (const folder of list(store, workspaceId)) {
    // 「仅本地」 names never go to the site's model, not even as a list.
    const files = Object.entries(readIndex(store, workspaceId, folder.id))
      .filter(([relative, entry]) => entry.listed && !entry.screened && !entry.documentId && !localOnlyFile(folder, relative, terms))
      .map(([relative, entry]) => ({ path: slash(relative), size: entry.size, modified: entry.mtimeMs })).sort((a, b) => b.modified - a.modified);
    if (!files.length) continue;
    const answer = await screen(folder.label, files).catch(() => undefined);
    if (!answer) continue;
    const offered = new Set(files.map((file) => file.path));
    const keep = (answer === "unavailable" ? files.map((file) => file.path) : answer.filter((item) => offered.has(item))).slice(0, DEVICE_FOLDER_SCREEN_LIMIT);
    for (const relative of keep) if ((await readFolderFile(store, workspaceId, deps, folder.id, relative)).ok) read += 1;
    // Read the index again: the reads above wrote it. What was offered and is still only listed was left out by the screening.
    const index = readIndex(store, workspaceId, folder.id);
    for (const [relative, entry] of Object.entries(index)) if (entry.listed && !entry.documentId && offered.has(slash(relative))) index[relative] = { ...entry, screened: true };
    store.setSetting(workspaceId, sourceFolderIndexSetting(folder.id), JSON.stringify(index));
  }
  return read;
}
