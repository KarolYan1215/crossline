import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DIGEST_CAPTURES_PER_RECORDING, DIGEST_MIN_CHARS, DISCARDED_KINDS, RECORDING_CAPTURE_PREFIX, RECORDING_DIGESTED_EVENT, RECORDING_DIGEST_SCHEMA,
  RECORDING_TRANSCRIBED_EVENT, digestDocument, digestText, spokenText, validateRecordingDigest, type RecordingDigestAnswer, type RecordingTranscribed
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredSourceDocument } from "@crossline/db";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";

export const RECORDING_DIGESTER = "crossline:crossline-recording-digest";
/** Recordings one run reads at most, and the text of them together; a pass makes at most `RUNS_PER_PASS` runs. */
const PER_RUN = 4;
const TEXT_PER_RUN = 60_000;
const RUNS_PER_PASS = 3;

/**
 * After transcription (docs/phone-recording.md 「录音之后」): each recording's transcript is read once by `crossline-recording-digest`,
 * which sorts out small talk, videos and noise and, for what is kept, writes a summary document and pulls out commitments, facts and days.
 * The ledger gets: a `recording.digested` event per recording (what it was, what came of it); a 「… 摘要.md」 document that the interview
 * and planning read instead of the transcript; an inferred profile fact per fact or day, citing the recording, which the interview can
 * confirm; and a capture per commitment of the person's, analysed like anything typed in, whose proposal waits for the person
 * (`RECORDING_CAPTURE_PREFIX`). A transcript with almost no words is noise by rule and costs no model run.
 */
export type DigestOutcome = { digested: number; kept: number; captures: number; facts: number } | { blocked: string };

/** Transcripts with no digest yet, oldest first. */
export function transcriptsAwaitingDigest(store: CrosslineStore, workspaceId: string): Array<{ doc: StoredSourceDocument; recording: RecordingTranscribed }> {
  const done = new Set(store.listEvents(workspaceId, { type: RECORDING_DIGESTED_EVENT }).map((event) => event.entityId));
  const docs = new Map(store.listSourceDocuments(workspaceId).map((doc) => [doc.id, doc]));
  return store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).map((event) => event.payload as RecordingTranscribed)
    .filter((recording) => !done.has(recording.documentId) && docs.has(recording.documentId))
    .map((recording) => ({ doc: docs.get(recording.documentId)!, recording }));
}

/** The documents that are raw recording transcripts: the interview reads their digests instead. */
export function transcriptDocumentIds(store: CrosslineStore, workspaceId: string): Set<string> {
  return new Set(store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT }).map((event) => String((event.payload as RecordingTranscribed).documentId ?? "")));
}

const startedAtOf = (doc: StoredSourceDocument) => /约 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) 开始/.exec(doc.extractedText)?.[1] ?? doc.createdAt.slice(0, 16).replace("T", " ");

export function createRecordingDigester(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  options: { dataDir: string; timeZone: string; now?: () => Date }) {
  const now = options.now ?? (() => new Date());
  const owner = () => ownerOf(store, workspaceId);
  const record = (docId: string, payload: Record<string, unknown>) => store.appendEvent({ ownerId: owner(), workspaceId, idempotencyKey: `${RECORDING_DIGESTED_EVENT}:${docId}`,
    type: RECORDING_DIGESTED_EVENT, entityId: docId, payload });

  return async function digest(): Promise<DigestOutcome> {
    const outcome = { digested: 0, kept: 0, captures: 0, facts: 0 };
    let pending = transcriptsAwaitingDigest(store, workspaceId);
    // Almost no words: noise, decided here without a model.
    for (const item of pending) if (spokenText(item.doc.extractedText).replace(/\s/g, "").length < DIGEST_MIN_CHARS) {
      record(item.doc.id, { kind: "noise", by: "rule", fileName: item.recording.fileName });
      outcome.digested += 1;
    }
    pending = transcriptsAwaitingDigest(store, workspaceId);
    if (!pending.length) return outcome;
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    let profiles: Record<string, { description?: string }> = {};
    try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") ?? {}; } catch { /* none yet */ }
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, description: profiles[line.id]?.description ?? "" }));
    const projects = store.listProjects(workspaceId).map((project) => ({ id: project.id, name: project.name, lineId: project.identityId }));
    const facts = store.listProfileFacts(workspaceId).filter((fact) => !fact.value.startsWith("假设")).slice(-80)
      .map((fact) => `${fact.identityId}/${fact.projectId || "-"}：${fact.slot} = ${fact.value.slice(0, 120)}`);
    const madeCaptures: string[] = [];

    for (let run = 0; run < RUNS_PER_PASS && pending.length; run += 1) {
      const batch: typeof pending = [];
      let size = 0;
      for (const item of pending) {
        const text = digestText(item.doc.extractedText);
        if (batch.length >= PER_RUN || (batch.length && size + text.length > TEXT_PER_RUN)) break;
        batch.push(item); size += text.length;
      }
      pending = pending.slice(batch.length);
      const transcripts = new Map(batch.map((item) => [item.doc.id, item.doc.extractedText]));
      const context = { version: "crossline.recording-digest.v1", today: now().toISOString().slice(0, 10), timeZone: options.timeZone, lines, projects, facts,
        recordings: batch.map((item) => ({ id: item.doc.id, fileName: item.recording.fileName, startedAt: startedAtOf(item.doc),
          minutes: Math.max(1, Math.round(item.recording.seconds / 60)), text: digestText(item.doc.extractedText) })) };
      const result = await runCodexSkill<RecordingDigestAnswer>(client, context, { skillName: RECORDING_DIGESTER, cwd,
        developerInstructions: "Digest the person's recordings as the Skill describes. Return raw JSON only.", outputSchema: RECORDING_DIGEST_SCHEMA,
        prepareInput: () => context,
        validateOutput: (output) => validateRecordingDigest(output, { transcripts, lineIds: lines.map((line) => line.id), projectIds: projects.map((project) => project.id) }),
        onAudit: () => {}, timeoutMs: 60 * 60_000 });
      if (!result.ok) return outcome.digested ? outcome : { blocked: result.blocker.code };

      for (const item of result.output.recordings) {
        const source = batch.find((entry) => entry.doc.id === item.id)!;
        const at = now().toISOString();
        if (DISCARDED_KINDS.includes(item.kind)) {
          record(item.id, { kind: item.kind, title: item.title, fileName: source.recording.fileName });
          outcome.digested += 1;
          continue;
        }
        // The summary as a document beside the transcript, filed under the same project.
        const body = digestDocument(item, { fileName: source.recording.fileName, startedAt: startedAtOf(source.doc), minutes: Math.max(1, Math.round(source.recording.seconds / 60)) });
        const bytes = Buffer.from(body, "utf8");
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const root = path.resolve(options.dataDir, "sources");
        mkdirSync(root, { recursive: true });
        const target = path.join(root, `${sha256}.md`);
        writeFileSync(target, bytes);
        const digestDoc = store.saveSourceDocument({ id: `digest-${item.id}`, ownerId: owner(), workspaceId, kind: "text",
          fileName: source.doc.fileName.replace(/ 转写\.txt$/, " 摘要.md"), mediaType: "text/markdown", sha256, uri: pathToFileURL(target).href,
          extractedText: body, extractionStatus: "done", extractionNote: "由录音转写整理（录音整理）", createdAt: at });
        if (item.projectId) for (const id of [item.id, digestDoc.id]) store.assignSourceDocumentProject(workspaceId, id, item.projectId);

        for (const fact of item.facts) {
          store.upsertProfileFact({ workspaceId, identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot, value: fact.value,
            status: "inferred", sourceRef: `recording:${item.id}`, sourceQuote: fact.quote, updatedAt: at });
          outcome.facts += 1;
        }
        // A day heard is a fact to confirm, not a calendar entry: a wrong one on the calendar misleads, an unconfirmed fact only waits.
        for (const day of item.dates) {
          const slot = `date_heard_${createHash("sha256").update(`${day.date}${day.title}`).digest("hex").slice(0, 8)}`;
          store.upsertProfileFact({ workspaceId, identityId: item.lineIds[0] ?? "person", projectId: item.projectId, slot, value: `${day.date}${day.time ? ` ${day.time}` : ""} ${day.title}`,
            status: "inferred", sourceRef: `recording:${item.id}`, sourceQuote: day.quote, updatedAt: at });
          outcome.facts += 1;
        }
        const captures: string[] = [];
        for (const [index, commitment] of item.commitments.filter((c) => c.by === "person").slice(0, DIGEST_CAPTURES_PER_RECORDING).entries()) {
          const id = `${RECORDING_CAPTURE_PREFIX}${item.id}-${index}`;
          store.capture({ id, ownerId: owner(), workspaceId, title: commitment.text,
            context: `本人在录音「${item.title}」（${startedAtOf(source.doc)}）里说：「${commitment.quote}」${commitment.due ? `；提到的期限：${commitment.due}` : ""}。来源：${digestDoc.fileName}` },
            `recording.capture:${item.id}:${index}`);
          captures.push(id);
        }
        madeCaptures.push(...captures);
        record(item.id, { kind: item.kind, title: item.title, fileName: source.recording.fileName, lineIds: item.lineIds, projectId: item.projectId,
          digestDocumentId: digestDoc.id, captures, facts: item.facts.length + item.dates.length });
        outcome.digested += 1; outcome.kept += 1; outcome.captures += captures.length;
      }
    }
    if (madeCaptures.length) sayToPerson(store, workspaceId, `从录音里听到本人答应要做的 ${madeCaptures.length} 件事，已记为收集；分析成提议后，需本人在待确认里确认。`,
      "recording_captures", `recording-captures:${madeCaptures.join(",")}`, [{ label: "去看看", href: "/approvals" }], now());
    return outcome;
  };
}
