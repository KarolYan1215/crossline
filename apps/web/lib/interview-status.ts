import "server-only";
import { ONBOARDING_STAGES, type AccessContext, type ChecklistItem } from "@crossline/core";
import { interviewChecklistFor } from "@crossline/db";
import { identityLines } from "./lines";
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
  /** Every item of the completion list is done (`interviewChecklist`) — not the model's say-so. */
  complete: boolean;
  /** The interview has nothing more to ask; what is left is the person's to click. */
  awaitingPerson: boolean;
  stage: string; stageIndex: number; stageCount: number;
  /** Questions of the current batch still waiting for the person, the app's own ones left out. */
  openQuestions: number;
  checklist: ChecklistItem[];
};

/**
 * Whether the main interview is finished, judged by the completion list built from the ledger — the portrait as much as the work —
 * plus where the conversation stands: its stage and the questions of the open batch.
 */
export function interviewStatus(ctx: AccessContext): InterviewStatus {
  const store = getStore();
  const session = store.getLatestOnboardingSession(ctx.workspaceId);
  const stageCount = ONBOARDING_STAGES.length;
  const checklist = interviewChecklistFor(store, ctx.workspaceId, identityLines(ctx).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [] })),
    { unfiledFiles: unfiledFiles(ctx, planToday(ctx)).length });
  const open = checklist.filter((item) => !item.done);
  if (!session) return { started: false, complete: false, awaitingPerson: false, stage: "", stageIndex: 0, stageCount, openQuestions: 0, checklist };
  const messages = store.listOnboardingMessages(ctx.workspaceId, session.id);
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const answered = messages.at(-1)?.role === "user";
  const content = (lastAssistant?.content ?? {}) as AssistantContent;
  const stage = content.stage ?? String((session.coverage as { stage?: string }).stage ?? "");
  const questions = answered || content.nextAction === "ready_for_milestones" ? [] : content.questions ?? [];
  const owned = questionsOwnedElsewhere(ctx, questions);
  return { started: true, complete: !open.length, awaitingPerson: open.length > 0 && open.every((item) => item.owner === "person"),
    stage, stageIndex: Math.max(0, ONBOARDING_STAGES.indexOf(stage as (typeof ONBOARDING_STAGES)[number])) + 1, stageCount,
    openQuestions: questions.filter((question) => !owned.has(question.id)).length, checklist };
}
