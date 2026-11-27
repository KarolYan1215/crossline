import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SOURCE_SIMHASH_SETTING, SOURCE_VERSIONS_SCHEMA, SOURCE_VERSIONS_SETTING, documentsByRef, nearDuplicatePairs, olderVersionNote, readSourceVersions, simhash,
  sourceModifiedSetting, validateSourceVersions, versionPairKey, type SourceVersionAnswer
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { ownerOf } from "./owner";
import { localeOf, tOfWorkspace } from "./locale";

export const SOURCE_DIGEST = "crossline:crossline-capture-digest:source";
/** Candidate pairs one run asks about, and the characters of each file it shows. */
const PAIRS_PER_RUN = 6;
const TEXT_PER_FILE = 6_000;
/** Prefix of the notes this pass writes, so a note is never itself compared with the files. */
export const VERSION_NOTE_ID = "version-note-";

/**
 * Older versions of one document (D11, docs/plans/2026-11-22-interview-and-import-redesign.md §四.3.4). Code fingerprints every read file
 * (`simhash`) and circles close pairs; the model (`crossline-capture-digest:source`) decides whether each pair is one document in two versions and
 * which is the latest, from modification times and the versions' own signals (dates, version numbers, 「终稿」, a section only one has).
 * For a confirmed pair the older file stays stored as it is and a note — summary plus what differs from the latest — is written beside
 * it; the interview reads the note in its place (`supersededDocumentIds`) and can still open the original by its id.
 */
export function createVersionJudge(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined, options: { dataDir: string }) {
  return async function judge(): Promise<{ asked: number; superseded: number } | { blocked: string }> {
    const docs = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done" && !doc.id.startsWith(VERSION_NOTE_ID) && !doc.id.startsWith("digest-"));
    const hashes = readHashes(store, workspaceId);
    let changed = false;
    for (const doc of docs) if (!(doc.id in hashes)) { hashes[doc.id] = simhash(doc.extractedText) ?? ""; changed = true; }
    const live = new Set(docs.map((doc) => doc.id));
    for (const id of Object.keys(hashes)) if (!live.has(id)) { delete hashes[id]; changed = true; }
    if (changed) store.setSetting(workspaceId, SOURCE_SIMHASH_SETTING, JSON.stringify(hashes));

    const versions = readSourceVersions(store.getSetting(workspaceId, SOURCE_VERSIONS_SETTING));
    const checked = new Set(versions.checked);
    const candidates = nearDuplicatePairs(docs.filter((doc) => hashes[doc.id] && !versions.superseded[doc.id]).map((doc) => ({ id: doc.id, hash: hashes[doc.id]! })))
      .filter((pair) => !checked.has(versionPairKey(pair.a, pair.b))).slice(0, PAIRS_PER_RUN);
    if (!candidates.length) return { asked: 0, superseded: 0 };
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const modified = (doc: StoredSourceDocument) => { const ms = Number(store.getSetting(workspaceId, sourceModifiedSetting(doc.id)) ?? ""); return ms > 0 ? new Date(ms).toISOString() : undefined; };
    const file = (doc: StoredSourceDocument) => ({ id: doc.id, fileName: doc.fileName, uploadedAt: doc.createdAt, ...(modified(doc) ? { modifiedAt: modified(doc)! } : {}),
      characters: doc.extractedText.length, opening: doc.extractedText.slice(0, TEXT_PER_FILE), ending: doc.extractedText.length > TEXT_PER_FILE ? doc.extractedText.slice(-1_500) : "" });
    const asked = candidates.map((pair) => ({ a: pair.a, b: pair.b }));
    const context = { version: "crossline.source-versions.v1", pairs: candidates.map((pair) => ({ a: file(byId.get(pair.a)!), b: file(byId.get(pair.b)!) })) };
    const result = await runCodexSkill<SourceVersionAnswer>(client, context, { skillName: SOURCE_DIGEST, cwd,
      developerInstructions: "For each pair, decide whether the two files are versions of one document and, if so, which is the latest; summarize the older one "
        + "and say what the latest changed. Return raw JSON only.", outputSchema: SOURCE_VERSIONS_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateSourceVersions(output, asked), onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };

    // Read again: a file may have been removed while the model ran.
    const now = readSourceVersions(store.getSetting(workspaceId, SOURCE_VERSIONS_SETTING));
    const refs = documentsByRef(store.listSourceDocuments(workspaceId));
    const refOf = new Map([...refs].map(([ref, doc]) => [doc.id, ref]));
    const locale = localeOf(store, workspaceId);
    const at = new Date().toISOString();
    let superseded = 0;
    for (const pair of result.output.pairs) {
      if (!pair.sameDocument) continue;
      const latest = byId.get(pair.latestId), older = byId.get(pair.latestId === pair.a ? pair.b : pair.a);
      if (!latest || !older || !refOf.has(older.id) || !refOf.has(latest.id)) continue;
      const body = olderVersionNote({ fileName: older.fileName, ref: refOf.get(older.id)! }, { fileName: latest.fileName, ref: refOf.get(latest.id)! },
        { summary: pair.olderSummary, differences: pair.differences }, locale);
      const note = saveNote(store, workspaceId, older, body, options.dataDir);
      now.superseded[older.id] = { latestId: latest.id, noteDocumentId: note.id, summary: pair.olderSummary, differences: pair.differences, at };
      // A file that was the latest of an earlier pair and is now older: what pointed at it points at the newest.
      for (const entry of Object.values(now.superseded)) if (entry.latestId === older.id) entry.latestId = latest.id;
      superseded += 1;
    }
    now.checked = [...new Set([...now.checked, ...asked.map((pair) => versionPairKey(pair.a, pair.b))])].slice(-2000);
    store.setSetting(workspaceId, SOURCE_VERSIONS_SETTING, JSON.stringify(now));
    return { asked: asked.length, superseded };
  };
}

function readHashes(store: CrosslineStore, workspaceId: string): Record<string, string> {
  try { return JSON.parse(store.getSetting(workspaceId, SOURCE_SIMHASH_SETTING) ?? "{}") as Record<string, string>; } catch { return {}; }
}

function saveNote(store: CrosslineStore, workspaceId: string, older: StoredSourceDocument, body: string, dataDir: string): StoredSourceDocument {
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = path.resolve(dataDir, "sources");
  mkdirSync(root, { recursive: true });
  const target = path.join(root, `${sha256}.md`);
  writeFileSync(target, bytes);
  const t = tOfWorkspace(store, workspaceId);
  const note = store.saveSourceDocument({ id: `${VERSION_NOTE_ID}${older.id}`, ownerId: ownerOf(store, workspaceId), workspaceId, kind: "text",
    fileName: t("{{file}}（旧版摘要）.md", { file: older.fileName.replace(/\.[^./]+$/, "") }).slice(-200), mediaType: "text/markdown", sha256, uri: pathToFileURL(target).href,
    extractedText: body, extractionStatus: "done", extractionNote: t("旧版文件的摘要与差异，原件仍保留"), createdAt: new Date().toISOString() });
  if (older.projectId) store.assignSourceDocumentProject(workspaceId, note.id, older.projectId);
  return note;
}

/**
 * Older versions the interview reads through their note instead of in full. A note whose original was removed is not listed; an older
 * file removed leaves its note behind as a plain file, which the person can delete.
 */
export function supersededDocumentIds(store: CrosslineStore, workspaceId: string): Set<string> {
  return new Set(Object.keys(readSourceVersions(store.getSetting(workspaceId, SOURCE_VERSIONS_SETTING)).superseded));
}
