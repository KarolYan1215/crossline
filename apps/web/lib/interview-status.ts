import "server-only";
import { ONBOARDING_STAGES, type AccessContext } from "@crossline/core";
import { getStore, planToday } from "./crossline";
import { unfiledFiles } from "./file-belonging";

type Question = { id: string; text: string; options?: Array<{ label?: string; detail?: string }> };
type AssistantContent = { questions?: Question[]; nextAction?: string; stage?: string };

const squash = (text: string) => text.replace(/[\s_\-·.:：《》「」()（）]+/g, "").toLowerCase();
/** A file's name as a question would mention it: without its extension, and long enough not to match by accident. */
const stemOf = (fileName: string) => squash(fileName.replace(/\.[A-Za-z0-9]{1,5}$/, ""));

/**
 * Which project an uploaded file belongs to is asked in one place only — the `source_project` ask on 待决事项 (decided 2026-10-08; the
 * interview had asked the same thing in its own batch). An interview question that names such a file — one the app is asking about, or
 * one already filed — is the app's, and is left out of the batch the person answers.
 */
export function questionsOwnedElsewhere(ctx: AccessContext, questions: Question[]): Set<string> {
  const store = getStore();
  const cleared = new Set(store.listEvents(ctx.workspaceId, { type: "source.project_cleared" }).map((event) => event.entityId));
  const asked = new Set(unfiledFiles(ctx, planToday(ctx)).map((file) => file.id));
  // Files whose project is settled (filed, by evidence or by the person, or declined) or that 待决事项 asks about.
  const owned = store.listSourceDocuments(ctx.workspaceId).filter((doc) => doc.projectId || cleared.has(doc.id) || asked.has(doc.id))
    .map((doc) => stemOf(doc.fileName)).filter((stem) => stem.length >= 8);
  const out = new Set<string>();
  for (const question of questions) {
    const text = squash([question.text, ...(question.options ?? []).flatMap((option) => [option.label ?? "", option.detail ?? ""])].join(" "));
    // A file is named when its whole stem, or its first twelve characters, appear in the question (「《TENTATIVE Lecture Plan》」).
    if (/文件|材料|file/iu.test(question.text) && owned.some((stem) => text.includes(stem) || text.includes(stem.slice(0, 12)))) out.add(question.id);
  }
  return out;
}

export type InterviewStatus = {
  /** No interview was ever started (an account set up before the interview existed, or a fresh one). */
  started: boolean;
  /** The interview said it has what it needs (`nextAction: "ready_for_milestones"`) and the session is closed. */
  complete: boolean;
  stage: string; stageIndex: number; stageCount: number;
  /** Questions of the current batch still waiting for the person, the app's own ones left out. */
  openQuestions: number;
  /** What the interview itself listed as still missing, per line. */
  missing: string[];
};

/**
 * Whether the main interview is finished, judged from what the interview itself recorded: its last answer's `nextAction` (still `ask`
 * means it has more to ask) and the session's state, plus the coverage it keeps of what is filled and what is missing per line.
 */
export function interviewStatus(ctx: AccessContext): InterviewStatus {
  const store = getStore();
  const session = store.getLatestOnboardingSession(ctx.workspaceId);
  const stageCount = ONBOARDING_STAGES.length;
  if (!session) return { started: false, complete: false, stage: "", stageIndex: 0, stageCount, openQuestions: 0, missing: [] };
  const messages = store.listOnboardingMessages(ctx.workspaceId, session.id);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const answered = messages.at(-1)?.role === "user";
  const content = (lastAssistant?.content ?? {}) as AssistantContent;
  const complete = session.state === "complete" || content.nextAction === "ready_for_milestones";
  const stage = content.stage ?? String((session.coverage as { stage?: string }).stage ?? "");
  const questions = complete || answered ? [] : content.questions ?? [];
  const owned = questionsOwnedElsewhere(ctx, questions);
  const coverage = ((session.coverage as { coverage?: Array<{ missing?: string[] }> }).coverage ?? []);
  return { started: true, complete, stage, stageIndex: Math.max(0, ONBOARDING_STAGES.indexOf(stage as (typeof ONBOARDING_STAGES)[number])) + 1, stageCount,
    openQuestions: questions.filter((question) => !owned.has(question.id)).length, missing: coverage.flatMap((line) => line.missing ?? []) };
}
