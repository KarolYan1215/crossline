import { DISCLOSURE_PLACEHOLDER, answersInReply, freeTextAnswers, sensitiveReplies, type AskedInReply, type LedgerQuestion, type ProfileGap, type TurnQuestion } from "@crossline/core";
import type { CrosslineStore, StoredSentence } from "@crossline/db";

/**
 * The interview's side of the question ledger (2026-10-19). Questions are keyed so the same question keeps its number: the app's own by
 * their gap id (`gap:<id>`, the same every round), the model's by conversation, round and id (`iq:<session>:<seq>:<id>`).
 */
const gapKey = (id: string) => `gap:${id}`;
const roundKey = (sessionId: string, seq: number, id: string) => `iq:${sessionId}:${seq}:${id}`;

const interviewQuestions = (store: CrosslineStore, workspaceId: string, sessionId: string) => withoutDisclosedAnswers(store, workspaceId, sessionId,
  store.listQuestions(workspaceId, { kind: "interview" }).filter((question) => question.key.startsWith("gap:") || question.key.startsWith(`iq:${sessionId}:`)));

/**
 * The ledger with every answer given in a reply a disclosure sits in (`sensitiveReplies`) replaced by the placeholder (2026-11-15): the
 * ledger is shown to the dialogue every round and read by `read_ledger`, so an answer quoting the disclosure would carry it back. An answer
 * is the reply's by the sentences it was given in, or else by the moment it was recorded (the reply's own).
 */
function withoutDisclosedAnswers<T extends LedgerQuestion>(store: CrosslineStore, workspaceId: string, sessionId: string, questions: T[]): T[] {
  const messages = store.listOnboardingMessages(workspaceId, sessionId);
  const hidden = sensitiveReplies(messages);
  if (!hidden.size) return questions;
  const replies = messages.filter((message) => message.role === "user" && hidden.has(`reply-${message.seq}`));
  const sentences = new Set(replies.flatMap((message) => store.ensureEvidence(workspaceId, "reply", `${sessionId}#${message.seq}`,
    String((message.content as { text?: string }).text ?? "")).map((sentence) => sentence.id)));
  const times = new Set(replies.map((message) => message.createdAt));
  return questions.map((question) => question.answer && (question.answerSentences.some((id) => sentences.has(id)) || times.has(question.answeredAt ?? ""))
    ? { ...question, answer: DISCLOSURE_PLACEHOLDER, answerSentences: [] } : question);
}
/** The interview's ledger as a round's questions are checked against it (`checkQuestions`): every question but the dropped ones. */
export const interviewLedger = (store: CrosslineStore, workspaceId: string, sessionId: string): LedgerQuestion[] =>
  interviewQuestions(store, workspaceId, sessionId).filter((question) => question.status !== "dropped");

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

/** The ledger key of a question the reply itself asked (`mark_round.asked`): `main-<n>` within its round. */
const mainKey = (sessionId: string, seq: number, index: number) => roundKey(sessionId, seq, `main-${index + 1}`);
const isMain = (sessionId: string) => (key: string) => key.startsWith(`iq:${sessionId}:`) && /:main-\d+$/u.test(key);

/**
 * The questions the round's reply asked, as the model declared them (2026-11-25, 「访谈账本驱动」): open in the ledger like a card's, so the
 * next round's snapshot lists them with their meaning and the person's answer. Returns the ledger numbers in order.
 */
export function recordAsked(store: CrosslineStore, workspaceId: string, sessionId: string, seq: number, asked: AskedInReply[], at: string): number[] {
  return asked.map((item, index) => store.recordQuestion(workspaceId, { kind: "interview", key: mainKey(sessionId, seq, index), text: item.text,
    status: "open", ...(item.repeats ? { repeats: item.repeats } : {}), at }));
}

/**
 * The person's reply as the answer to the questions the last reply asked and that are still open: the reply follows the question it was
 * written under, so it is that question's answer whole (the card lines aside, which answer the cards). Written before the next round's
 * snapshot is read, never left to the thread's memory.
 */
export function answerMainQuestions(store: CrosslineStore, workspaceId: string, sessionId: string, reply: string, sentences: StoredSentence[], at: string): number {
  const said = reply.split("\n").filter((line) => !/^\s*【[^】\n]+】/u.test(line)).join("\n").trim();
  if (!said) return 0;
  const open = interviewQuestions(store, workspaceId, sessionId).filter((question) => question.status === "open" && isMain(sessionId)(question.key));
  for (const question of open) store.answerQuestion(workspaceId, question.id, { text: said.slice(0, MAIN_ANSWER_CHARS), at,
    sentences: sentences.map((sentence) => sentence.id) });
  return open.length;
}
/** What of the reply the ledger keeps as a main question's answer (the snapshot shows less; the reply itself stays in the conversation). */
export const MAIN_ANSWER_CHARS = 400;

/**
 * Whether one of the app's checklist questions has an answer the extraction has not read yet (`since`: when the first unread reply came):
 * the item is then only waiting to be written down, and the dialogue is told so (2026-11-01 run 10: 「铲屎官这条线眼下在做的一件事」
 * answered at round 11 was asked again by the model in its own words at round 15, the item still open). Once the extraction has read the
 * answer and the item is still open, the answer settled nothing (「不确定」, a skip) and the question is offered again. Whether an answer
 * settles the item is the extraction's judgement; the word list that guessed it from the answer (`unsureAnswer`, IR-022) is gone.
 */
export function checklistAnswered(store: CrosslineStore, workspaceId: string, sessionId: string, since: string | undefined): (text: string) => boolean {
  const answered = interviewQuestions(store, workspaceId, sessionId)
    .filter((question) => (question.status === "answered" && since !== undefined && (question.answeredAt ?? "") >= since) || question.status === "assumed");
  return (text) => answered.some((question) => question.text === text || question.text.startsWith(text));
}

/**
 * The lines the person answered a question about in replies the extraction has not read yet (`since`: when the first such reply came).
 * A line's start item stays open until the extraction writes the answer down, and on a slow model that is rounds later: the 2026-11-01
 * run 8 asked one father what his daughter's line was working on at round 19, eight rounds after he said it, because three extraction
 * runs were still behind. While a line has such an answer, its checklist questions wait.
 */
export function linesAnsweredUnread(store: CrosslineStore, workspaceId: string, sessionId: string, since: string | undefined): Set<string> {
  if (!since) return new Set();
  return new Set(interviewQuestions(store, workspaceId, sessionId)
    .filter((question) => question.status === "answered" && question.identityId && question.identityId !== "person"
      && (question.answeredAt ?? "") >= since)
    .map((question) => question.identityId));
}

/** Every question of a stored round, now shown and open; returns the ledger numbers in the round's order. */
export function recordRound(store: CrosslineStore, workspaceId: string, sessionId: string, seq: number, questions: TurnQuestion[], at: string): number[] {
  return questions.map((question) => store.recordQuestion(workspaceId, {
    kind: "interview", key: question.id.startsWith("gap-") ? gapKey(question.id) : roundKey(sessionId, seq, question.id), text: question.text,
    options: question.options.map((option) => option.label), identityId: question.identityId, projectId: question.projectId, status: "open",
    ...(question.repeats ? { repeats: question.repeats } : {}), at }));
}

export type { LedgerQuestion };
