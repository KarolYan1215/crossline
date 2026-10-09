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
export type DateBatch = { id: string; documentCount: number; items: DateBatchItem[]; questions: string[]; dropped: number };
export type DiligenceReport = {
  id: string; identityId: string; question: string; status: "queued" | "running" | "done" | "failed"; runAt: string; note?: string;
  findings: Array<{ id: string; claim: string; sourceIds: string[]; confidence: string; staleWhen: string }>;
  proposals: Array<{ id: string; title: string; why: string; kind: string; dueDate: string; findingIds: string[]; status: "pending" | "accepted" | "rejected" }>;
  sources: Array<{ id: string; title: string; publisher: string; finalUrl: string; accessedOn: string }>;
};
export type OnboardingState = {
  /** Questions of the open batch left out because 待决事项 asks them (which project a file belongs to). */
  movedToAsks?: number;
  /** Questions the app itself still needs answered (a target grade, a line resting on guesses, a TBD date), with options to pick from. */
  gaps: Question[];
  diligence: DiligenceReport[];
  dateBatch: DateBatch | null;
  identities: Identity[];
  session: { id: string; state: "active" | "complete"; coverage: { coverage?: AssistantTurn["coverage"]; stage?: string } } | null;
  /** A new account sets its lines before the conversation starts. */
  setupLines: boolean;
  /** A line's own interview, when the page was opened for one. */
  focusLine: { id: string; label: string } | null;
  lines: Array<{ id: string; label: string; rank: number | null; hard: boolean; goals: string[] }>;
  lineProfiles: Record<string, { description: string; goalCandidates: string[] }>;
  profile: import("./portrait-panel").ProfileModelView | null;
  availabilityProposed: boolean;
  messages: Message[];
  projects: Project[];
  facts: Fact[];
  documents: DocumentRow[];
};

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
