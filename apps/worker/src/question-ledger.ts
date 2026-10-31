import { answersInReply, freeTextAnswers, ledgerLines, questionSimilarity, unsureAnswer, type LedgerQuestion, type ProfileGap, type TurnQuestion } from "@crossline/core";
import type { CrosslineStore, StoredSentence } from "@crossline/db";

/**
 * The interview's side of the question ledger (2026-10-19). Questions are keyed so the same question keeps its number: the app's own by
 * their gap id (`gap:<id>`, the same every round), the model's by conversation, round and id (`iq:<session>:<seq>:<id>`).
 */
const gapKey = (id: string) => `gap:${id}`;
const roundKey = (sessionId: string, seq: number, id: string) => `iq:${sessionId}:${seq}:${id}`;
/** A question the model writes this close to one already answered is that question again, whatever number it gave. */
export const REPEAT_SIMILARITY = 0.85;

const interviewQuestions = (store: CrosslineStore, workspaceId: string, sessionId: string) => store.listQuestions(workspaceId, { kind: "interview" })
  .filter((question) => question.key.startsWith("gap:") || question.key.startsWith(`iq:${sessionId}:`));

/** The answers this reply gives to questions still open, read from the cards' own form, each with the sentences it was given in. */
export function recordReplyAnswers(store: CrosslineStore, workspaceId: string, sessionId: string, reply: string, sentences: StoredSentence[], at: string): number {
  const open = interviewQuestions(store, workspaceId, sessionId).filter((question) => question.status === "open" || question.status === "pending");
  // Newest first, so a question asked again in a later round is the one answered.
  const newestFirst = [...open].reverse();
  const carded = answersInReply(reply, newestFirst.map((question) => ({ id: question.id, text: question.text })));
  // A reply in the person's own words answers what it speaks to; the cards' form, when present, is exact and wins.
  const answers = carded.length ? carded : freeTextAnswers(reply, newestFirst.map((question) => ({ id: question.id, text: question.text, options: question.options })));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = open.find((item) => item.id === answer.id)!;
    if (seen.has(question.text)) continue;
    seen.add(question.text);
    store.answerQuestion(workspaceId, answer.id, { text: answer.answer, at,
      sentences: sentences.filter((sentence) => sentence.start < answer.end && sentence.end > answer.start).map((sentence) => sentence.id) });
  }
  return seen.size;
}

/** The app's own questions as of now, kept in the ledger as waiting (`pending`); one whose cause went away is no longer asked. */
export function syncGapQuestions(store: CrosslineStore, workspaceId: string, gaps: ProfileGap[], at: string): void {
  const live = new Set(gaps.map((gap) => gapKey(gap.question.id)));
  for (const gap of gaps) store.recordQuestion(workspaceId, { kind: "interview", key: gapKey(gap.question.id), text: gap.question.text,
    options: gap.question.options.map((option) => option.label), identityId: gap.identityId, projectId: gap.projectId, status: "pending", at });
  for (const question of store.listQuestions(workspaceId, { kind: "interview", keyPrefix: "gap:", statuses: ["pending", "open"] }))
    if (!live.has(question.key)) store.dropQuestion(workspaceId, question.id, at);
}

/**
 * What the model is shown of the ledger: the questions still waiting and the latest answered ones. The app's own waiting questions
 * (`gap:`) take at most a third of the room: on the owner's real interview the fifteen places were all the app's file-belonging
 * questions, and the dialogue could not see what it had itself asked and been told (docs/onboarding-prompts.md).
 */
export function ledgerForModel(store: CrosslineStore, workspaceId: string, sessionId: string, limit = 60): string[] {
  const all = interviewQuestions(store, workspaceId, sessionId).filter((question) => question.status !== "dropped");
  const isWaiting = (question: (typeof all)[number]) => question.status === "pending" || question.status === "open";
  const appWaiting = all.filter((question) => isWaiting(question) && question.key.startsWith("gap:")).slice(-Math.ceil(limit / 3));
  const ownWaiting = all.filter((question) => isWaiting(question) && !question.key.startsWith("gap:")).slice(-Math.max(0, limit - appWaiting.length));
  const room = Math.max(0, limit - appWaiting.length - ownWaiting.length);
  const settled = room ? all.filter((question) => question.status === "answered" || question.status === "assumed").slice(-room) : [];
  return ledgerLines([...settled, ...ownWaiting, ...appWaiting].sort((a, b) => a.id - b.id));
}

export type RepeatOutcome = { questions: TurnQuestion[]; coveredGaps: Set<string>; dropped: Array<{ text: string; repeats: number; why: "answered" | "similar" }> };

/**
 * Reads the round's `repeats`: a question asking again what was answered goes (asked again is the duplicate the ledger exists to catch;
 * a question the model wrote this close to an answered one goes too, whatever number it gave), and one of the app's waiting questions
 * the model asked in its own words is marked so the app does not add it as well. A number that is not in the ledger is read as new.
 */
export function resolveRepeats(store: CrosslineStore, workspaceId: string, sessionId: string, questions: TurnQuestion[]): RepeatOutcome {
  const ledger = interviewQuestions(store, workspaceId, sessionId);
  const byId = new Map(ledger.map((question) => [question.id, question]));
  const answered = ledger.filter((question) => question.status === "answered" || question.status === "assumed");
  const coveredGaps = new Set<string>();
  const dropped: RepeatOutcome["dropped"] = [];
  // An answer that settled nothing (「不确定」) may be asked about once more, never twice: the start items take only the person's word.
  const askedAgain = (id: number) => ledger.some((item) => item.repeats === id);
  const reopenable = (item: LedgerQuestion) => item.status === "answered" && unsureAnswer(item.answer) && !askedAgain(item.id);
  const kept = questions.filter((question) => {
    const named = question.repeats ? byId.get(question.repeats) : undefined;
    if (named && (named.status === "answered" || named.status === "assumed") && !reopenable(named)) { dropped.push({ text: question.text, repeats: named.id, why: "answered" }); return false; }
    if (named?.key.startsWith("gap:")) coveredGaps.add(named.key.slice(4));
    const twin = !named && answered.find((item) => questionSimilarity(item.text, question.text) >= REPEAT_SIMILARITY && !reopenable(item));
    if (twin) { dropped.push({ text: question.text, repeats: twin.id, why: "similar" }); return false; }
    return true;
  }).map((question) => ({ ...question, repeats: question.repeats && byId.has(question.repeats) ? question.repeats : 0 }));
  return { questions: kept, coveredGaps, dropped };
}

/** Every question of a stored round, now shown and open; returns the ledger numbers in the round's order. */
export function recordRound(store: CrosslineStore, workspaceId: string, sessionId: string, seq: number, questions: TurnQuestion[], at: string): number[] {
  return questions.map((question) => store.recordQuestion(workspaceId, {
    kind: "interview", key: question.id.startsWith("gap-") ? gapKey(question.id) : roundKey(sessionId, seq, question.id), text: question.text,
    options: question.options.map((option) => option.label), identityId: question.identityId, projectId: question.projectId, status: "open",
    ...(question.repeats ? { repeats: question.repeats } : {}), at }));
}

export type { LedgerQuestion };
