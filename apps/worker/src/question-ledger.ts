import { DISCLOSURE_PLACEHOLDER, answersInReply, freeTextAnswers, ledgerLines, sensitiveReplies, unsureAnswer, type LedgerQuestion, type ProfileGap, type TurnQuestion } from "@crossline/core";
import type { CrosslineStore, StoredSentence } from "@crossline/db";

/**
 * The interview's side of the question ledger (2026-10-19). Questions are keyed so the same question keeps its number: the app's own by
 * their gap id (`gap:<id>`, the same every round), the model's by conversation, round and id (`iq:<session>:<seq>:<id>`).
 */
const gapKey = (id: string) => `gap:${id}`;
const roundKey = (sessionId: string, seq: number, id: string) => `iq:${sessionId}:${seq}:${id}`;
/** The dialogue's own answered questions shown by text alone beyond the latest ones (`ledgerForModel`). */
export const EARLIER_SHOWN = 80;

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

/**
 * What the model is shown of the ledger: the questions still waiting and the latest answered ones. The app's own waiting questions
 * (`gap:`) take at most a third of the room: on the owner's real interview the fifteen places were all the app's file-belonging
 * questions, and the dialogue could not see what it had itself asked and been told (docs/archive/onboarding-prompts.md).
 */
export function ledgerForModel(store: CrosslineStore, workspaceId: string, sessionId: string, limit = 60): string[] {
  const all = interviewQuestions(store, workspaceId, sessionId).filter((question) => question.status !== "dropped");
  const isWaiting = (question: (typeof all)[number]) => question.status === "pending" || question.status === "open";
  const appWaiting = all.filter((question) => isWaiting(question) && question.key.startsWith("gap:")).slice(-Math.ceil(limit / 3));
  const ownWaiting = all.filter((question) => isWaiting(question) && !question.key.startsWith("gap:")).slice(-Math.max(0, limit - appWaiting.length));
  const room = Math.max(0, limit - appWaiting.length - ownWaiting.length);
  const settledAll = all.filter((question) => question.status === "answered" || question.status === "assumed");
  const settled = room ? settledAll.slice(-room) : [];
  // The dialogue's older answered questions, without their answers: it rewords what it asks, and a rewording is below any bigram
  // similarity the code could treat as a repeat. Shown only the latest fifteen, a quick interview's 27th round asked round 1's
  // 「成长过程中，你欣赏过谁？」 again as 「成长过程中，你最欣赏谁？」 (0.50; 2026-11-06 walkthrough, W-239).
  const older = settledAll.slice(0, settledAll.length - settled.length).filter((question) => !question.key.startsWith("gap:"))
    .slice(-EARLIER_SHOWN).map((question) => ({ ...question, answer: "" }));
  return ledgerLines([...older, ...settled, ...ownWaiting, ...appWaiting].sort((a, b) => a.id - b.id));
}

/**
 * Whether one of the app's checklist questions has an answer on record that settles it: the item is then only waiting for the extraction
 * to write it down, and the dialogue is told so (2026-11-01 run 10: 「铲屎官这条线眼下在做的一件事」 answered at round 11 was asked again
 * by the model in its own words at round 15, the item still open).
 */
export function checklistAnswered(store: CrosslineStore, workspaceId: string, sessionId: string): (text: string) => boolean {
  const answered = interviewQuestions(store, workspaceId, sessionId)
    .filter((question) => (question.status === "answered" && !unsureAnswer(question.answer)) || question.status === "assumed");
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
