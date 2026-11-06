import type { CrosslineStore } from "./index";

/**
 * Where the interview's background extraction stands (2026-10-19, P2 of the redesign). The dialogue answers the person at once; the
 * extraction reads the same replies and files as numbered sentences and writes facts, dates and attributes afterwards, so the worker
 * that runs it and the pages that say 「整理中」 read one record:
 *
 *   - per conversation, the last reply extracted (`upTo`, a message seq) and the failures since the last success with when to try again;
 *   - per workspace, the files waiting to be extracted (`docs`: file id → the first sentence id it was extracted at, 0 while queued). A
 *     file read again gets new sentence ids, so a stored id that no longer matches means it waits again (-1: it had no text).
 */
export const EXTRACT_STATE_SETTING = "onboarding.extract";
export const EXTRACT_DOCS_SETTING = "onboarding.extract.docs";
/**
 * Where the next run starts reading a file longer than one run reads (W-228): the character offset of its first sentence not read yet. A
 * file is done only once its last part was read; it used to be marked done after its first 14,000 characters, and a syllabus's schedule
 * table at the end was never read.
 */
export const EXTRACT_OFFSETS_SETTING = "onboarding.extract.offsets";
/** Set by a turn that re-reads every file; the next run takes it, and its dates replace the batch nobody answered. */
export const EXTRACT_REREAD_SETTING = "onboarding.extract.reread";
/**
 * Set when the dialogue says the interview can end (2026-10-19): the extraction then finalizes every deep section and writes the
 * synthesis, as it does for a completed interview. Without it the energy section, the last stage now that details is gone, was never
 * past and never final, so the synthesis was never written and the checklist asked the person for 「一句话画像、核心矛盾」. The value
 * counts the runs made for it; a run is made for it at most `FINISH_RUNS_MAX` times when nothing else waits.
 */
export const EXTRACT_FINISHING_SETTING = "onboarding.extract.finishing";
export const FINISH_RUNS_MAX = 2;
export function readFinishing(store: CrosslineStore, workspaceId: string, sessionId: string): { runs: number } | undefined {
  const raw = store.getSetting(workspaceId, `${EXTRACT_FINISHING_SETTING}:${sessionId}`);
  if (!raw) return undefined;
  try { return { runs: Number((JSON.parse(raw) as { runs?: number }).runs ?? 0) }; } catch { return { runs: 0 }; }
}
export function markFinishing(store: CrosslineStore, workspaceId: string, sessionId: string, runs = 0): void {
  store.setSetting(workspaceId, `${EXTRACT_FINISHING_SETTING}:${sessionId}`, JSON.stringify({ runs }));
}
/** Minutes to wait after the first, second and third failure in a row (and every later one). */
export const EXTRACT_BACKOFF_MINUTES = [1, 5, 30] as const;

export type ExtractState = { upTo: number; failures: number; retryAt?: string; lastError?: { code: string; message: string; at: string }; ranAt?: string };
/**
 * What the extraction still owes a conversation. `frontReplies` counts the waiting replies that answer a round of the front stages (or
 * the opening): only those can carry a start-standard fact, so only they hold 「开始使用」 (2026-10-19 walkthrough: on the sponsor model a
 * run took 5–7 minutes and the deep stages' replies kept the button away for the whole interview after the standard stood).
 */
export type ExtractBacklog = { replies: number; frontReplies: number; files: number; failing?: { code: string; message: string; retryAt?: string } };
const DEEP = new Set(["situation", "compass", "energy"]);

const stateKey = (sessionId: string) => `${EXTRACT_STATE_SETTING}:${sessionId}`;
const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

export function readExtractState(store: CrosslineStore, workspaceId: string, sessionId: string): ExtractState {
  return { upTo: 0, failures: 0, ...parse<Partial<ExtractState>>(store.getSetting(workspaceId, stateKey(sessionId)), {}) };
}
export function writeExtractState(store: CrosslineStore, workspaceId: string, sessionId: string, state: ExtractState): void {
  store.setSetting(workspaceId, stateKey(sessionId), JSON.stringify(state));
  // A workspace the extraction has worked in needs no backfill: a later restart must not skip a reply still waiting to be extracted.
  if (!store.getSetting(workspaceId, EXTRACT_BACKFILL_SETTING)) store.setSetting(workspaceId, EXTRACT_BACKFILL_SETTING, new Date().toISOString());
}

export function readExtractDocs(store: CrosslineStore, workspaceId: string): Record<string, number> {
  return parse<Record<string, number>>(store.getSetting(workspaceId, EXTRACT_DOCS_SETTING), {});
}
export function writeExtractDocs(store: CrosslineStore, workspaceId: string, docs: Record<string, number>): void {
  store.setSetting(workspaceId, EXTRACT_DOCS_SETTING, JSON.stringify(docs));
}
/** Files a dialogue turn just showed (or all of them, on a re-read): they wait for the extraction. Synchronous, so no write is lost. */
export function queueExtractDocs(store: CrosslineStore, workspaceId: string, documentIds: string[], options: { fromStart?: boolean } = {}): void {
  if (!documentIds.length) return;
  const docs = readExtractDocs(store, workspaceId);
  for (const id of documentIds) docs[id] = 0;
  writeExtractDocs(store, workspaceId, docs);
  // A re-read starts each file over; a file shown again while its later parts wait keeps its place.
  const offsets = readExtractOffsets(store, workspaceId);
  if (options.fromStart && documentIds.some((id) => id in offsets)) { for (const id of documentIds) delete offsets[id]; writeExtractOffsets(store, workspaceId, offsets); }
}
export function readExtractOffsets(store: CrosslineStore, workspaceId: string): Record<string, number> {
  return parse<Record<string, number>>(store.getSetting(workspaceId, EXTRACT_OFFSETS_SETTING), {});
}
export function writeExtractOffsets(store: CrosslineStore, workspaceId: string, offsets: Record<string, number>): void {
  store.setSetting(workspaceId, EXTRACT_OFFSETS_SETTING, JSON.stringify(offsets));
}

/** The first current sentence id of a file, or undefined when it has none (removed, or never read). */
export function firstSentenceOf(store: CrosslineStore, workspaceId: string, documentId: string): number | undefined {
  return store.sentencesOf(workspaceId, "document", documentId)[0]?.id;
}

/** Files waiting: queued, or extracted at sentences the file no longer has. A removed file waits for nothing. */
export function pendingExtractDocs(store: CrosslineStore, workspaceId: string): string[] {
  const docs = readExtractDocs(store, workspaceId);
  const live = new Map(store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done").map((doc) => [doc.id, doc]));
  return Object.entries(docs).filter(([id, at]) => {
    const doc = live.get(id);
    if (!doc) return false;
    const first = firstSentenceOf(store, workspaceId, id);
    // 0: queued; -1: read, and it had no text to extract.
    return at === 0 || (first !== undefined && first !== at);
  }).map(([id]) => id);
}

/** What the extraction still owes a conversation: replies after its watermark, files waiting, and its last failure while it is failing. */
export function extractBacklog(store: CrosslineStore, workspaceId: string, sessionId: string): ExtractBacklog {
  const state = readExtractState(store, workspaceId, sessionId);
  const messages = store.listOnboardingMessages(workspaceId, sessionId);
  const waiting = messages.filter((message) => message.role === "user" && message.seq > state.upTo);
  // The stage of the round a reply answers: the latest assistant round before it (none: the opening).
  const answers = (seq: number) => String(((messages.filter((message) => message.role === "assistant" && message.seq < seq).at(-1)?.content ?? {}) as { stage?: string }).stage ?? "");
  const frontReplies = waiting.filter((message) => !DEEP.has(answers(message.seq))).length;
  const files = sessionId.startsWith("line-") ? 0 : pendingExtractDocs(store, workspaceId).length;
  return { replies: waiting.length, frontReplies, files, ...(state.failures && state.lastError ? { failing: { code: state.lastError.code, message: state.lastError.message,
    ...(state.retryAt ? { retryAt: state.retryAt } : {}) } } : {}) };
}

/** Marks the workspace once the watermarks below are set (`backfillExtractWatermarks`). */
export const EXTRACT_BACKFILL_SETTING = "onboarding.extract.backfill.v1";
/**
 * Conversations that existed before the extraction did were recorded by the old single turn: their watermark starts at their last reply,
 * or the first tick after the change would extract every interview again from the start (and rewrite every confirmed portrait). Once per
 * workspace; returns how many conversations it set.
 */
export function backfillExtractWatermarks(store: CrosslineStore, workspaceId: string): number {
  if (store.getSetting(workspaceId, EXTRACT_BACKFILL_SETTING)) return 0;
  let set = 0;
  for (const session of store.listOnboardingSessions(workspaceId)) {
    // The notes conversation was never the old single turn's: every note in it still waits to be read.
    if (session.id === NOTES_SESSION || store.getSetting(workspaceId, stateKey(session.id))) continue;
    const last = store.listOnboardingMessages(workspaceId, session.id).filter((message) => message.role === "user").at(-1)?.seq ?? 0;
    store.setSetting(workspaceId, stateKey(session.id), JSON.stringify({ upTo: last, failures: 0 } satisfies ExtractState));
    set += 1;
  }
  store.setSetting(workspaceId, EXTRACT_BACKFILL_SETTING, new Date().toISOString());
  return set;
}

/**
 * Everything else the person writes, read for facts (2026-11-03, the owner: 「检查目前系统是否能从任意用户输入中提取信息并记录进账本」).
 * Words that land nowhere else — a line in the input box that became no action, 「记一下」, the note beside an answer no option takes, a
 * progress report, the 「完成情况」 note, the words on a waiting answer or on the return page, and a 「告诉系统」 the worker could not take —
 * are kept as replies of one more conversation, `notes`, that no dialogue ever answers. The interview's extraction reads it like any
 * conversation (numbered sentences, citations, facts, projects and dates into the date batch, where a time the calendar already holds is
 * merged), so a fact said anywhere ends up where every later plan reads it, with the words it rests on.
 */
export const NOTES_SESSION = "notes";
export type PersonNoteSource = { kind: "conversation" | "note" | "ask" | "progress" | "outcome" | "waiting" | "return" | "profile"; id: string };
export type PersonNote = { text: string; source: PersonNoteSource;
  /** What the words were said about (the ask's question, the task's name): the extraction reads it as the question they answer. */
  about: string };
/** Shorter than this (letters and digits) says nothing to record; longer is cut. */
export const NOTE_MIN_CHARS = 6;
export const NOTE_MAX_CHARS = 2000;

/** Whether words may hold something to record: enough of them, and not one bare question (a question asks; it states nothing). */
export function noteWorthReading(text: string): boolean {
  const trimmed = text.trim();
  if ((trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length < NOTE_MIN_CHARS) return false;
  return !(/[?？]$/.test(trimmed) && !/[。.!！;；\n]/.test(trimmed.slice(0, -1)));
}

/** Keeps one note for the extraction, once per source; false when it is too short to say anything or the source was already kept. */
export function recordPersonNote(store: CrosslineStore, workspaceId: string, ownerId: string, note: PersonNote, at = new Date().toISOString()): boolean {
  const text = note.text.trim().slice(0, NOTE_MAX_CHARS);
  if (!noteWorthReading(text)) return false;
  const kept = store.listOnboardingMessages(workspaceId, NOTES_SESSION);
  const same = (content: unknown) => { const source = (content as { source?: PersonNoteSource }).source; return source?.kind === note.source.kind && source.id === note.source.id; };
  if (kept.some((message) => same(message.content))) return false;
  if (!store.getOnboardingSession(workspaceId, NOTES_SESSION)) {
    store.saveOnboardingSession({ id: NOTES_SESSION, ownerId, workspaceId, state: "active", coverage: {}, createdAt: at, updatedAt: at });
    // Its own watermark from the start, written directly: `writeExtractState` would mark the workspace's backfill as done.
    if (!store.getSetting(workspaceId, stateKey(NOTES_SESSION))) store.setSetting(workspaceId, stateKey(NOTES_SESSION), JSON.stringify({ upTo: 0, failures: 0 } satisfies ExtractState));
  }
  store.appendOnboardingMessage({ sessionId: NOTES_SESSION, workspaceId, role: "user", createdAt: at,
    content: { text, about: note.about.trim().slice(0, 200), source: note.source } satisfies PersonNote });
  return true;
}
