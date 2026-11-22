import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHAT_DIGEST_SCHEMA, CHAT_DIGEST_SETTING, chatDigestNote, chatHistorySegments, documentsByRef, readChatDigests, validateChatDigest,
  type ChatDigestAnswer } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { ownerOf } from "./owner";
import { localeOf, tOfWorkspace } from "./locale";
import { SOURCE_DIGEST } from "./source-versions";

/** Conversations one run summarizes at most, the characters of them together, and the characters shown of one conversation. */
const SEGMENTS_PER_RUN = 30;
const TEXT_PER_RUN = 60_000;
const TEXT_PER_SEGMENT = 4_000;
/** Runs one pass makes at most; a long export is finished over the next passes. */
const RUNS_PER_PASS = 3;
/** Id prefix of the notes (`digest-` keeps them out of the version comparison, as a recording's digest is). */
export const CHAT_NOTE_ID = "digest-chat-";

/**
 * AI conversation exports (D14): an export is stored with only what the person typed (`readSourceText`), one `## ` section per
 * conversation. Here `crossline-source-digest` writes one summary per conversation, a few dozen at a time; once every conversation has
 * one, a note of the summaries is saved beside the export, and the interview reads the note in its place (`chatDigestedIds`), opening the
 * export with `read_file` for the person's own words. A conversation the model passes over twice is written into the note without one.
 */
export function createChatDigester(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined, options: { dataDir: string }) {
  return async function digest(): Promise<{ summarized: number; notes: number } | { blocked: string }> {
    const outcome = { summarized: 0, notes: 0 };
    for (let run = 0; run < RUNS_PER_PASS; run += 1) {
      const digests = readChatDigests(store.getSetting(workspaceId, CHAT_DIGEST_SETTING));
      const docs = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done" && !doc.id.startsWith("digest-") && !digests[doc.id]?.noteDocumentId);
      const next = docs.map((doc) => ({ doc, segments: chatHistorySegments(doc.extractedText) ?? [] })).find((item) => item.segments.length);
      if (!next) return outcome;
      const entry = digests[next.doc.id] ?? { summaries: {} };
      const open = next.segments.filter((segment) => !(String(segment.index) in entry.summaries));
      if (open.length) {
        const client = getClient();
        if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
        const batch: typeof open = [];
        let size = 0;
        for (const segment of open) {
          const said = segment.said.slice(0, TEXT_PER_SEGMENT);
          if (batch.length >= SEGMENTS_PER_RUN || (batch.length && size + said.length > TEXT_PER_RUN)) break;
          batch.push({ ...segment, said });
          size += said.length;
        }
        const asked = batch.map((segment) => `s${segment.index}`);
        const context = { version: "crossline.chat-digest.v1", source: next.doc.fileName,
          segments: batch.map((segment) => ({ id: `s${segment.index}`, heading: segment.heading, said: segment.said })) };
        const result = await runCodexSkill<ChatDigestAnswer>(client, context, { skillName: SOURCE_DIGEST, cwd,
          developerInstructions: "Summarize each conversation of the person's AI chat export, as the crossline-source-digest Skill's chat-exports section "
            + "describes. Return raw JSON only.", outputSchema: CHAT_DIGEST_SCHEMA,
          prepareInput: () => context, validateOutput: (output) => validateChatDigest(output, asked), onAudit: () => {}, timeoutMs: 20 * 60_000 });
        if (!result.ok) return { blocked: result.blocker.code };
        const now = readChatDigests(store.getSetting(workspaceId, CHAT_DIGEST_SETTING));
        const saved = now[next.doc.id] ?? { summaries: {} };
        for (const item of result.output.segments) saved.summaries[item.id.slice(1)] = item.summary;
        // Passed over: asked once more on the next run, then written without a summary, so one stubborn conversation never holds the note.
        const tries = saved.tries ?? {};
        for (const id of asked.filter((id) => !result.output.segments.some((item) => item.id === id))) {
          tries[id] = (tries[id] ?? 0) + 1;
          if (tries[id]! >= 2) saved.summaries[id.slice(1)] = "";
        }
        now[next.doc.id] = { ...saved, ...(Object.keys(tries).length ? { tries } : {}) };
        store.setSetting(workspaceId, CHAT_DIGEST_SETTING, JSON.stringify(now));
        outcome.summarized += result.output.segments.length;
        continue;
      }
      // Every conversation has its summary: the note.
      const ref = [...documentsByRef(store.listSourceDocuments(workspaceId))].find(([, doc]) => doc.id === next.doc.id)?.[0] ?? next.doc.id;
      const body = chatDigestNote({ fileName: next.doc.fileName, ref }, next.segments.map((segment) => ({ heading: segment.heading,
        summary: entry.summaries[String(segment.index)] ?? "" })), localeOf(store, workspaceId));
      const note = saveNote(store, workspaceId, next.doc, body, options.dataDir);
      const now = readChatDigests(store.getSetting(workspaceId, CHAT_DIGEST_SETTING));
      now[next.doc.id] = { summaries: entry.summaries, noteDocumentId: note.id, at: new Date().toISOString() };
      store.setSetting(workspaceId, CHAT_DIGEST_SETTING, JSON.stringify(now));
      outcome.notes += 1;
    }
    return outcome;
  };
}

function saveNote(store: CrosslineStore, workspaceId: string, source: StoredSourceDocument, body: string, dataDir: string): StoredSourceDocument {
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const root = path.resolve(dataDir, "sources");
  mkdirSync(root, { recursive: true });
  const target = path.join(root, `${sha256}.md`);
  writeFileSync(target, bytes);
  const t = tOfWorkspace(store, workspaceId);
  const note = store.saveSourceDocument({ id: `${CHAT_NOTE_ID}${source.id}`, ownerId: ownerOf(store, workspaceId), workspaceId, kind: "text",
    fileName: t("{{file}}（对话摘要）.md", { file: source.fileName.replace(/\.[^./]+$/, "") }).slice(-200), mediaType: "text/markdown", sha256, uri: pathToFileURL(target).href,
    extractedText: body, extractionStatus: "done", extractionNote: t("AI 对话记录的逐段摘要，原件仍保留"), createdAt: new Date().toISOString() });
  if (source.projectId) store.assignSourceDocumentProject(workspaceId, note.id, source.projectId);
  return note;
}

/** Exports the interview reads through their note of summaries instead of in full; the export stays stored and readable by id. */
export function chatDigestedIds(store: CrosslineStore, workspaceId: string): Set<string> {
  return new Set(Object.entries(readChatDigests(store.getSetting(workspaceId, CHAT_DIGEST_SETTING))).filter(([, entry]) => entry.noteDocumentId).map(([id]) => id));
}
