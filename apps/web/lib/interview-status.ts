import "server-only";
import { INTERVIEW_FLOW_STAGES, flowOf, answerLine, gapCoveredBy, questionKind, readyToStart as startReady, screenQuestions, screenedNote, startMissing as startOpen, type AccessContext, type ChecklistItem,
  type ScreenReason } from "@crossline/core";
import { interviewChecklistFor, interviewGapsFor, questionScreenFor } from "@crossline/db";
import { identityLines } from "./lines";
import { getStore, planToday } from "./crossline";
import { interviewLocale, readLocale } from "@crossline/db";
import { unfiledFiles } from "./file-belonging";

type Question = { id: string; text: string; options?: Array<{ label?: string; detail?: string }> };
type AssistantContent = { questions?: Question[]; nextAction?: string; stage?: string };

const squash = (text: string) => text.replace(/[\s_\-·.:：《》「」()（）]+/g, "").toLowerCase();
/** A file's name as a question would mention it: without its extension, and long enough not to match by accident. */
const stemOf = (fileName: string) => squash(fileName.replace(/\.[A-Za-z0-9]{1,5}$/, ""));

/**
 * The model's own questions that name a file whose project is settled or asked about by the app (`gap-file-*` in the interview, the
 * `source_project` ask once parked): the app's question is the one kept, so the same thing is never asked twice.
 */
export function questionsOwnedElsewhere(ctx: AccessContext, questions: Question[]): Set<string> {
  const store = getStore();
  const cleared = new Set(store.listEvents(ctx.workspaceId, { type: "source.project_cleared" }).map((event) => event.entityId));
  const asked = new Set(unfiledFiles(ctx, planToday(ctx)).map((file) => file.id));
  // Files whose project is settled (filed, by evidence or by the person, or declined) or that the app asks about.
  const owned = store.listSourceDocuments(ctx.workspaceId).filter((doc) => doc.projectId || cleared.has(doc.id) || asked.has(doc.id))
    .map((doc) => stemOf(doc.fileName)).filter((stem) => stem.length >= 8);
  const out = new Set<string>();
  for (const question of questions) {
    if (question.id.startsWith("gap-file-")) continue;
    const text = squash([question.text, ...(question.options ?? []).flatMap((option) => [option.label ?? "", option.detail ?? ""])].join(" "));
    // A file is named when its whole stem, or its first twelve characters, appear in the question (「《TENTATIVE Lecture Plan》」).
    if (/文件|材料|file/iu.test(question.text) && owned.some((stem) => text.includes(stem) || text.includes(stem.slice(0, 12)))) out.add(question.id);
  }
  return out;
}

/** Answers given on 待决事项 while parked, sent to the interview together once the round's questions are all answered. */
export const PENDING_ANSWERS = "onboarding.pendingAnswers";

export type InterviewQuestion = { id: string; text: string; kind: "single" | "multi" | "free";
  options: Array<{ id: string; label: string; detail: string }>; allowOther: boolean; identityId: string; projectId: string };
type Pending = { sessionId: string; afterSeq: number; answers: Record<string, string> };

export type InterviewStatus = {
  /** No interview was ever started (an account set up before the interview existed, or a fresh one). */
  started: boolean;
  /** Every item of the completion list is done (`interviewChecklist`) — not the model's say-so. */
  complete: boolean;
  /** The interview has nothing more to ask; what is left is the person's to click. */
  awaitingPerson: boolean;
  /**
   * 已能使用、画像还没完成：访谈的问题同时列在待决事项。The start standard stands (`readyToStart`) and the checklist is not complete, so
   * the person uses the app while the portrait goes on (decided 2026-10-12; the early-exit button is gone). Before the start
   * standard stands every page leads back to the interview, which asks its questions round by round.
   */
  parked: boolean;
  /** The five start items all stand (`readyToStart`): the person may use every page. */
  readyToStart: boolean;
  /** The start items still open, in checklist order. */
  startMissing: ChecklistItem[];
  stage: string; stageIndex: number; stageCount: number;
  /** Questions still waiting for the person: the open round's (questions about a file left out) and the app's own not yet in a round. */
  questions: InterviewQuestion[];
  /** The open round's questions the app keeps from the person (`screenQuestions`), named to the interview when the round is sent. */
  screened: Array<{ question: InterviewQuestion; reason: ScreenReason }>;
  openQuestions: number;
  /** The system's own completion record: never shown to the person. */
  checklist: ChecklistItem[];
  sessionId: string;
};

const lastAssistantSeq = (messages: Array<{ role: string; seq: number }>) => [...messages].reverse().find((message) => message.role === "assistant")?.seq ?? 0;

function readPending(ctx: AccessContext, sessionId: string, afterSeq: number): Pending {
  try {
    const pending = JSON.parse(getStore().getSetting(ctx.workspaceId, PENDING_ANSWERS) ?? "null") as Pending | null;
    if (pending && pending.sessionId === sessionId && pending.afterSeq === afterSeq) return pending;
  } catch { /* none */ }
  return { sessionId, afterSeq, answers: {} };
}

/**
 * Whether the main interview is finished, judged by the completion list built from the ledger — the portrait as much as the work —
 * plus where the conversation stands: its stage, the questions waiting, and whether the start standard already stands.
 */
export function interviewStatus(ctx: AccessContext): InterviewStatus {
  const store = getStore();
  const session = store.getLatestOnboardingSession(ctx.workspaceId);
  const stages = INTERVIEW_FLOW_STAGES[flowOf(session?.coverage)];
  const stageCount = stages.length;
  const today = planToday(ctx);
  const lines = identityLines(ctx).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  const checklist = interviewChecklistFor(store, ctx.workspaceId, lines, { unfiledFiles: unfiledFiles(ctx, today).length, today });
  const open = checklist.filter((item) => !item.done && !item.deferred);
  const readyToStart = startReady(checklist), startMissing = startOpen(checklist);
  if (!session) return { started: false, complete: false, awaitingPerson: false, parked: false, readyToStart, startMissing, stage: "", stageIndex: 0, stageCount,
    questions: [], screened: [], openQuestions: 0, checklist, sessionId: "" };
  const messages = store.listOnboardingMessages(ctx.workspaceId, session.id);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const answered = messages.at(-1)?.role === "user";
  const content = (lastAssistant?.content ?? {}) as AssistantContent;
  const stage = content.stage ?? String((session.coverage as { stage?: string }).stage ?? "");
  const complete = !open.length;
  const parked = readyToStart && !complete;
  // The open round, minus questions about a file (the file's own question covers it) and minus what was already answered.
  // A round stored before the screen existed is screened on read, so a question that is not the person's never holds the round up.
  const stored = (answered || content.nextAction === "ready_for_milestones" ? [] : content.questions ?? []) as InterviewQuestion[];
  const { keep, screened } = screenQuestions(stored.map((question) => ({ ...question, kind: questionKind(question) })), questionScreenFor(store, ctx.workspaceId));
  const round = keep;
  const owned = questionsOwnedElsewhere(ctx, round);
  const pending = readPending(ctx, session.id, lastAssistant?.seq ?? 0);
  const inRound = new Set(round.map((question) => question.id));
  const allGaps = answered ? [] : interviewGapsFor(store, ctx.workspaceId, lines, today);
  // Whether the portrait fits is asked on the portrait page (2026-10-28): neither the app's own questions nor 待决事项 put it any more.
  const gaps = allGaps.filter((gap) => gap.code !== "FILE_UNFILED" && gap.code !== "PORTRAIT_UNCONFIRMED" && !inRound.has(gap.question.id) && !gapCoveredBy(gap, round, allGaps))
    .map((gap) => gap.question as InterviewQuestion);
  const seen = new Set<string>();
  const questions = [...round.filter((question) => !owned.has(question.id) && !question.id.startsWith("gap-file-") && question.id !== "gap-portrait"), ...gaps]
    .filter((question) => !pending.answers[question.id] && !seen.has(question.id) && Boolean(seen.add(question.id)));
  return { started: true, complete, awaitingPerson: open.length > 0 && open.every((item) => item.owner === "person"), parked, readyToStart, startMissing,
    stage, stageIndex: Math.max(0, stages.indexOf(stage as (typeof stages)[number])) + 1, stageCount,
    questions, screened, openQuestions: questions.length, checklist, sessionId: session.id };
}

/**
 * The answer in the words the interview screen sends (`composeAnswers`, core `answerLine`), in the interview's own language (it keeps the
 * one it started in): several options joined, the person's own words after 补充 / Added.
 */
const lineOf = (ctx: AccessContext, question: InterviewQuestion, options: Array<{ label: string }>, other: string) =>
  answerLine(question.text, options.map((option) => option.label), other, interviewLocale(getStore(), ctx.workspaceId) ?? readLocale(getStore(), ctx.workspaceId));

/**
 * The answers that still count: one given to a question the screen now keeps from the person (a room, class times on record, a
 * calendar's recurrence answered as a single choice) is dropped — it was not theirs to answer, and a forced single choice over two
 * events is a wrong answer (the owner's decision, 2026-10-15).
 */
const validAnswers = (answers: Record<string, string>, status: InterviewStatus) => {
  const screened = new Set(status.screened.map((item) => item.question.id));
  return Object.entries(answers).filter(([id]) => !screened.has(id)).map(([, line]) => line);
};

/** The round as one reply: the answers that count, then a line naming the questions the app kept from the person. */
const roundReply = (answers: Record<string, string>, status: InterviewStatus) =>
  [...validAnswers(answers, status), screenedNote(status.screened)].filter(Boolean).join("\n");

/**
 * One interview question answered on 待决事项. Answers wait until every waiting question is answered, then go to the interview as one
 * reply in the words the interview screen sends (so the app's own questions are read straight out of it), and the next round follows.
 */
export async function answerInterviewQuestion(ctx: AccessContext, questionId: string, optionIds: string[], other: string,
  send: (sessionId: string, text: string) => Promise<void>): Promise<{ ok: true; sent: boolean } | { ok: false; code: string }> {
  const status = interviewStatus(ctx);
  const question = status.questions.find((item) => item.id === questionId);
  if (!question) return { ok: false, code: "INTERVIEW_QUESTION_NOT_OPEN" };
  const options = question.options.filter((item) => optionIds.includes(item.id));
  if (options.length > 1 && question.kind !== "multi") return { ok: false, code: "ASK_SINGLE_CHOICE" };
  if (!options.length && !other.trim()) return { ok: false, code: "INTERVIEW_ANSWER_EMPTY" };
  const store = getStore();
  const pending = readPending(ctx, status.sessionId, lastAssistantSeq(store.listOnboardingMessages(ctx.workspaceId, status.sessionId)));
  pending.answers[questionId] = lineOf(ctx, question, options, other);
  if (status.questions.some((item) => item.id !== questionId)) {
    store.setSetting(ctx.workspaceId, PENDING_ANSWERS, JSON.stringify(pending));
    return { ok: true, sent: false };
  }
  store.setSetting(ctx.workspaceId, PENDING_ANSWERS, "null");
  await send(status.sessionId, roundReply(pending.answers, status));
  return { ok: true, sent: true };
}

/**
 * Answers waiting on 待决事项 for a round with nothing left to answer — the rest were questions no longer asked (an answered TBD date, a
 * portrait already confirmed, a question the screen keeps from the person) — go to the interview now. Without this the real account's
 * five answers waited for three dead questions no answer could clear (2026-10-15). Run on the web's attention timer.
 */
export async function flushPendingAnswers(ctx: AccessContext, send: (sessionId: string, text: string) => Promise<void>): Promise<boolean> {
  const status = interviewStatus(ctx);
  if (!status.started || !status.sessionId || status.questions.length) return false;
  const store = getStore();
  const messages = store.listOnboardingMessages(ctx.workspaceId, status.sessionId);
  if (messages.at(-1)?.role !== "assistant") return false;
  const pending = readPending(ctx, status.sessionId, lastAssistantSeq(messages));
  if (!Object.keys(pending.answers).length) return false;
  store.setSetting(ctx.workspaceId, PENDING_ANSWERS, "null");
  // Nothing left that counts: no reply is sent and no interview round is started for it.
  if (!validAnswers(pending.answers, status).length) return false;
  await send(status.sessionId, roundReply(pending.answers, status));
  return true;
}

/** Answers given on 待决事项 and not yet sent: they go in front of the person's next reply in the interview itself. */
export function takePendingAnswers(ctx: AccessContext, sessionId: string): string {
  const store = getStore();
  const pending = readPending(ctx, sessionId, lastAssistantSeq(store.listOnboardingMessages(ctx.workspaceId, sessionId)));
  if (!Object.keys(pending.answers).length) return "";
  store.setSetting(ctx.workspaceId, PENDING_ANSWERS, "null");
  return validAnswers(pending.answers, interviewStatus(ctx)).join("\n");
}

/** Question ids already answered on 待决事项, so the interview screen does not show them again. */
export function pendingAnswerIds(ctx: AccessContext, sessionId: string): string[] {
  return Object.keys(readPending(ctx, sessionId, lastAssistantSeq(getStore().listOnboardingMessages(ctx.workspaceId, sessionId))).answers);
}
