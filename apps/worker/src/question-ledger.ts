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
/**
 * About the same line a question is a repeat at a lower similarity: the model rewords what it asks each round, and the 2026-10-31
 * walkthrough had one person's savings asked six times at about 0.5 bigram similarity, each worded a little differently.
 */
export const SAME_LINE_SIMILARITY = 0.6;
/** However it is worded, one question is put to the person at most this many times; the rest is left to an assumption. */
export const MAX_ASKINGS = 2;

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
  // Same line and same project (two projects' deadlines are worded alike and are two questions).
  const alike = (a: { text: string; identityId: string; projectId: string }, b: { text: string; identityId: string; projectId: string }) => {
    if (a.projectId && b.projectId && a.projectId !== b.projectId) return false;
    const similarity = questionSimilarity(a.text, b.text);
    return similarity >= REPEAT_SIMILARITY
      || (Boolean(a.identityId) && a.identityId === b.identityId && a.projectId === b.projectId && similarity >= SAME_LINE_SIMILARITY);
  };
  // What the model asked before, answered or not: the model's own questions only (the app's are keyed by gap and asked by its own rules).
  const askedBefore = ledger.filter((item) => item.status !== "dropped" && !item.key.startsWith("gap:"));
  const kept: TurnQuestion[] = [];
  for (const question of questions) {
    const named = question.repeats ? byId.get(question.repeats) : undefined;
    if (named && (named.status === "answered" || named.status === "assumed") && !reopenable(named)) { dropped.push({ text: question.text, repeats: named.id, why: "answered" }); continue; }
    if (named?.key.startsWith("gap:")) coveredGaps.add(named.key.slice(4));
    const twin = !named && answered.find((item) => alike(item, question) && !reopenable(item));
    if (twin) { dropped.push({ text: question.text, repeats: twin.id, why: "similar" }); continue; }
    // The same thing asked twice already (answered in prose the cards could not read, or skipped) is not asked a third time.
    // One hop further: each rewording is close to the last one, not always to the first.
    const near = askedBefore.filter((item) => item.id === named?.id || alike(item, question));
    const earlier = askedBefore.filter((item) => near.includes(item) || near.some((other) => alike(other, item)));
    if (earlier.length >= MAX_ASKINGS) { dropped.push({ text: question.text, repeats: earlier.at(-1)!.id, why: "similar" }); continue; }
    // Two questions of one round that ask the same thing: the first stays.
    if (kept.some((other) => alike(other, question))) continue;
    kept.push({ ...question, repeats: question.repeats && byId.has(question.repeats) ? question.repeats : 0 });
  }
  return { questions: kept.map(withDistinctOptions), coveredGaps, dropped };
}

/** A question's options with repeats left out (2026-10-31: one card offered the same choice twice). */
export function withDistinctOptions(question: TurnQuestion): TurnQuestion {
  const seen = new Set<string>();
  const options = question.options.filter((option) => {
    const key = option.label.replace(/[\s，,。.、；;：:（）()「」]/g, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return options.length === question.options.length ? question : { ...question, options };
}

/** Every question of a stored round, now shown and open; returns the ledger numbers in the round's order. */
export function recordRound(store: CrosslineStore, workspaceId: string, sessionId: string, seq: number, questions: TurnQuestion[], at: string): number[] {
  return questions.map((question) => store.recordQuestion(workspaceId, {
    kind: "interview", key: question.id.startsWith("gap-") ? gapKey(question.id) : roundKey(sessionId, seq, question.id), text: question.text,
    options: question.options.map((option) => option.label), identityId: question.identityId, projectId: question.projectId, status: "open",
    ...(question.repeats ? { repeats: question.repeats } : {}), at }));
}

export type { LedgerQuestion };
