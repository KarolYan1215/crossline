/** What `GET /api/onboarding/state` returns — the shapes the screen reads, not the store's full rows. */
export type Identity = { id: string; label: string };
export type Project = { id: string; identityId: string; name: string; summary: string; status: string };
export type Fact = {
  identityId: string; projectId: string; slot: string; value: string;
  status: "confirmed" | "inferred"; sourceRef: string; sourceQuote: string;
};
export type DocumentRow = {
  id: string; fileName: string; kind: string; projectId?: string;
  extractionStatus: "pending" | "done" | "failed" | "unsupported"; extractionNote?: string;
  /** Read from an authorized folder (shown in the folder's card, not in the list of uploads). */
  fromFolder?: boolean;
};
export type Question = {
  id: string; text: string; kind: "single" | "multi" | "free";
  options: Array<{ id: string; label: string; detail: string }>;
  allowOther: boolean; identityId: string; projectId: string;
};
export type AssistantTurn = {
  reply: string; questions: Question[]; nextAction: "ask" | "ready_for_milestones"; stage?: string;
  coverage: Array<{ identityId: string; filled: string[]; missing: string[] }>;
};
export type Message = { seq: number; role: "assistant" | "user"; content: unknown; createdAt: string };
export type DateBatchItem = {
  id: string; kind: "date" | "recurring"; title: string; project: string; confidence: "high" | "medium" | "low";
  when: string; quote: string; sourceRef: string; note: string; checked: boolean; blocks: number;
};
export type DateBatch = { id: string; documentCount: number; items: DateBatchItem[]; questions: string[]; dropped: string[] };
export type DiligenceReport = {
  id: string; identityId: string; question: string; status: "queued" | "running" | "done" | "failed"; runAt: string; note?: string;
  findings: Array<{ id: string; claim: string; sourceIds: string[]; confidence: string; staleWhen: string }>;
  proposals: Array<{ id: string; title: string; why: string; kind: string; dueDate: string; findingIds: string[]; status: "pending" | "accepted" | "rejected" }>;
  sources: Array<{ id: string; title: string; publisher: string; finalUrl: string; accessedOn: string }>;
};
export type OnboardingState = {
  /** The five start items stand (main interview; always true in a line's own interview): every page opens. */
  readyToStart: boolean;
  /** The worker's own first milestone drafts: being designed, or that run ended with none. */
  firstDrafts?: "none" | "running" | "stalled";
  /** Why the last round did not finish (`onboarding.lastFailure:<session>`), or null. */
  lastFailure?: { code: string; message: string; detail?: string; at: string } | null;
  /**
   * What the background extraction still owes the conversation: replies and files not yet recorded, and its last failure while it keeps
   * failing (`extractBacklog`). Absent on a state read before it existed.
   */
  organizing?: { replies: number; files: number; failing?: { code: string; message: string; retryAt?: string } };
  /** Whether the person confirmed what was recorded before using the app (or their account was in use before that existed). */
  startConfirmed?: boolean;
  /** What they confirm, once the start standard stands and the extraction has caught up (`startSummary`). */
  startSummary?: import("../../lib/start-confirm").StartSummary;
  /** How many start items there are (they are per line, so not a fixed five). */
  startTotal: number;
  /** The start items still open, in checklist order. */
  startMissing: Array<{ id: string; label: string; detail: string; owner: "interview" | "person" }>;
  /** The app's own questions not in the open round (`profileGaps`), answered in the same reply. */
  extraQuestions: Question[];
  /** Questions of the open round the person already answered on 待决事项 (those answers go in front of the next reply). */
  answeredElsewhere?: string[];
  diligence: DiligenceReport[];
  dateBatch: DateBatch | null;
  identities: Identity[];
  session: { id: string; state: "active" | "complete"; coverage: { coverage?: AssistantTurn["coverage"]; stage?: string } } | null;
  /** A new account sets its lines before the conversation starts. */
  setupLines: boolean;
  /** A line's own interview, when the page was opened for one. */
  focusLine: { id: string; label: string } | null;
  lines: Array<{ id: string; label: string; rank: number | null; hard: boolean; goals: string[]; goalParts: string[] }>;
  /** Per line: the interview's description and attribute candidates (`goalCandidates` only on lines interviewed before attributes existed). */
  lineProfiles: Record<string, import("@crossline/core").StoredLineProfile>;
  profile: import("./portrait-panel").ProfileModelView | null;
  availabilityProposed: boolean;
  /** How the interview talks (`ONBOARDING_TONE_SETTING`), and whether the person has chosen yet. */
  tone: import("@crossline/core").OnboardingTone;
  toneChosen: boolean;
  /** The right column's week and project axis. */
  week: import("../../lib/onboarding-board").WeekSkeleton;
  timeline: import("../../lib/onboarding-board").ProjectTimeline;
  messages: Message[];
  projects: Project[];
  facts: Fact[];
  documents: DocumentRow[];
};

/**
 * The first reply when the person starts the interview from the materials step with files already read: the interview reads them before
 * asking anything (decided 2026-10-12). `scripts/onboarding-eval.ts` sends the same words.
 */
export const MATERIALS_FIRST_REPLY = "材料已添加，请先从材料里读出能读的，再问还缺的。";
/** The first reply when the person starts without any file. */
export const NO_MATERIALS_REPLY = "没有材料，直接开始访谈。";

/** One question's pending answer on the screen. */
export type Answer = { picked: string[]; other: string };

/**
 * Turns the answers on screen into the single message the person "says". Option labels are written out in
 * full on purpose: the interview grounds every fact it learns in a verbatim quote of what the person said,
 * and a bare option id would give it nothing to quote.
 */
export function composeAnswers(questions: Question[], answers: Record<string, Answer>, freeText: string): string {
  const parts: string[] = [];
  for (const question of questions) {
    const answer = answers[question.id];
    if (!answer || (!answer.picked.length && !answer.other.trim())) continue;
    const labels = answer.picked.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
    const line = [labels.length ? `选择：${labels.join("；")}` : "", answer.other.trim() ? `补充：${answer.other.trim()}` : ""].filter(Boolean).join("。");
    parts.push(`【${question.text}】${line}`);
  }
  if (freeText.trim()) parts.push(freeText.trim());
  return parts.join("\n");
}
