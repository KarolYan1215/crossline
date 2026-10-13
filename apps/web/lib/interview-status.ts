import "server-only";
import { ONBOARDING_STAGES, gapCoveredBy, readyToStart as startReady, startMissing as startOpen, type AccessContext, type ChecklistItem } from "@crossline/core";
import { interviewChecklistFor, interviewGapsFor } from "@crossline/db";
import { identityLines } from "./lines";
import { getStore, planToday } from "./crossline";
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
  const stageCount = ONBOARDING_STAGES.length;
  const today = planToday(ctx);
  const lines = identityLines(ctx).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] }));
  const checklist = interviewChecklistFor(store, ctx.workspaceId, lines, { unfiledFiles: unfiledFiles(ctx, today).length, today });
  const open = checklist.filter((item) => !item.done);
  const readyToStart = startReady(checklist), startMissing = startOpen(checklist);
  if (!session) return { started: false, complete: false, awaitingPerson: false, parked: false, readyToStart, startMissing, stage: "", stageIndex: 0, stageCount,
    questions: [], openQuestions: 0, checklist, sessionId: "" };
  const messages = store.listOnboardingMessages(ctx.workspaceId, session.id);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const answered = messages.at(-1)?.role === "user";
  const content = (lastAssistant?.content ?? {}) as AssistantContent;
  const stage = content.stage ?? String((session.coverage as { stage?: string }).stage ?? "");
  const complete = !open.length;
  const parked = readyToStart && !complete;
  // The open round, minus questions about a file (the file's own question covers it) and minus what was already answered.
  const round = (answered || content.nextAction === "ready_for_milestones" ? [] : content.questions ?? []) as InterviewQuestion[];
  const owned = questionsOwnedElsewhere(ctx, round);
  const pending = readPending(ctx, session.id, lastAssistant?.seq ?? 0);
  const inRound = new Set(round.map((question) => question.id));
  const gaps = answered ? [] : interviewGapsFor(store, ctx.workspaceId, lines, today)
    .filter((gap) => gap.code !== "FILE_UNFILED" && !inRound.has(gap.question.id) && !gapCoveredBy(gap, round)).map((gap) => gap.question as InterviewQuestion);
  const questions = [...round.filter((question) => !owned.has(question.id) && !question.id.startsWith("gap-file-")), ...gaps]
    .filter((question) => !pending.answers[question.id]);
  return { started: true, complete, awaitingPerson: open.length > 0 && open.every((item) => item.owner === "person"), parked, readyToStart, startMissing,
    stage, stageIndex: Math.max(0, ONBOARDING_STAGES.indexOf(stage as (typeof ONBOARDING_STAGES)[number])) + 1, stageCount,
    questions, openQuestions: questions.length, checklist, sessionId: session.id };
}

const lineOf = (question: InterviewQuestion, option: { label: string } | undefined, other: string) =>
  `【${question.text}】${[option ? `选择：${option.label}` : "", other.trim() ? `补充：${other.trim()}` : ""].filter(Boolean).join("。")}`;

/**
 * One interview question answered on 待决事项. Answers wait until every waiting question is answered, then go to the interview as one
 * reply in the words the interview screen sends (so the app's own questions are read straight out of it), and the next round follows.
 */
export async function answerInterviewQuestion(ctx: AccessContext, questionId: string, optionId: string, other: string,
  send: (sessionId: string, text: string) => Promise<void>): Promise<{ ok: true; sent: boolean } | { ok: false; code: string }> {
  const status = interviewStatus(ctx);
  const question = status.questions.find((item) => item.id === questionId);
  if (!question) return { ok: false, code: "INTERVIEW_QUESTION_NOT_OPEN" };
  const option = question.options.find((item) => item.id === optionId);
  if (!option && !other.trim()) return { ok: false, code: "INTERVIEW_ANSWER_EMPTY" };
  const store = getStore();
  const pending = readPending(ctx, status.sessionId, lastAssistantSeq(store.listOnboardingMessages(ctx.workspaceId, status.sessionId)));
  pending.answers[questionId] = lineOf(question, option, other);
  if (status.questions.some((item) => item.id !== questionId)) {
    store.setSetting(ctx.workspaceId, PENDING_ANSWERS, JSON.stringify(pending));
    return { ok: true, sent: false };
  }
  store.setSetting(ctx.workspaceId, PENDING_ANSWERS, "null");
  await send(status.sessionId, Object.values(pending.answers).join("\n"));
  return { ok: true, sent: true };
}

/** Answers given on 待决事项 and not yet sent: they go in front of the person's next reply in the interview itself. */
export function takePendingAnswers(ctx: AccessContext, sessionId: string): string {
  const store = getStore();
  const pending = readPending(ctx, sessionId, lastAssistantSeq(store.listOnboardingMessages(ctx.workspaceId, sessionId)));
  if (!Object.keys(pending.answers).length) return "";
  store.setSetting(ctx.workspaceId, PENDING_ANSWERS, "null");
  return Object.values(pending.answers).join("\n");
}

/** Question ids already answered on 待决事项, so the interview screen does not show them again. */
export function pendingAnswerIds(ctx: AccessContext, sessionId: string): string[] {
  return Object.keys(readPending(ctx, sessionId, lastAssistantSeq(getStore().listOnboardingMessages(ctx.workspaceId, sessionId))).answers);
}
