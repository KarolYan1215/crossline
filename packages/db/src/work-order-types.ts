import type { ChecklistAnswer } from "@crossline/core";

export type StoredCapture = {
  id: string; ownerId: string; workspaceId: string; title: string; context: string;
  state: "captured" | "analyzing" | "awaiting_plan_approval" | "blocked" | "promoted" | "discarded";
  attempt: number;
  audit: { threadId?: string; turnId?: string; contextVersion?: string;
    /** How many times the validator sent the answer back to be fixed. A schema that needs this every
     * run is a schema problem, and it only reads as one if the count is on the record. */
    repairs?: number;
    blocker?: { code: string; message: string } };
};

export type CapacityCommitment = {
  id: string;
  ownerId: string;
  workspaceId: string;
  title: string;
  minimumMinutes: number;
  sourceTaskId?: string;
};

export type StoredWorkOrder = {
  id: string;
  ownerId: string;
  workspaceId: string;
  identityId: string;
  projectId: string;
  milestoneId: string;
  intent: string;
  state: string;
  riskTier: "routine" | "milestone" | "high_risk";
  recurrence?: { fullMinutes: number; minimumMinutes: number };
  tombstone?: { reason: string; createdAt: string };
  estimate: {
    p25Minutes: number; p50Minutes: number; p85Minutes: number;
    // `legacy_task` marks a number carried over from a v1 row: real, but never a prior anyone authored.
    // `manual` marks one a person typed in directly, bypassing analysis entirely.
  source: "identity_prior" | "llm_prior" | "personal_history" | "legacy_task" | "manual";
    observationCount: number; confidence: "low" | "medium" | "high";
  };
  payload: unknown;
};

/** A normalized step plan as the step planner returns it (packages/core `StepPlan`); kept structural so db does not import core. */
export type StepPlanInput = {
  archetypeId: string; quantity: { basis: string; amount: number; unit: string }; rationale: string;
  steps: Array<{ id: string; role: string; title: string; deliverable: string; doneCriterion: string; share: number;
    estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number }; dependsOn: string[]; notBefore: string; dueBy: string;
    schedulable: boolean; executor: "human" | "agent" | "mixed"; tickOutcome: string; covers?: string[]; why?: string;
    aiAssist?: { tool: string; how: string; minutesSaved: number };
    /** A concrete first move of at most five minutes for a person's step ("" for the assistant's steps and waits). */
    firstAction?: string;
    /** What the step produces (`STEP_TYPES`), the needs it uses, and on a provide step the need it asks for (packages/core/src/steps.ts). */
    product?: "material" | "output" | "ability" | "action"; uses?: string[]; provides?: string;
    /** The planner's readings (core `PlannedStep`, 2026-11-22): going to an event at its own time; physical exercise. */
    attends?: boolean; workout?: boolean;
    /** The model's reading that the step leaves the machine or commits the person (core `external-action.ts`); absent on plans before 2026-11-25. */
    external?: boolean }>;
  /** Material only the person has, asked for before anything that uses it (provide steps). */
  needs?: Array<{ id: string; what: string; why: string; basis?: string; kind?: "personal" | "reference" }>;
  /** The content units read from the person's material, and what only the person can answer (packages/core/src/steps.ts). */
  units?: Array<{ id: string; title: string; docId: string; quote: string }>;
  /** `assume`/`neededBy`/`ask`/`ifWrong` since 2026-11-20 (core `StepQuestion`); absent on plans stored before. */
  questions?: Array<{ id: string; text: string; why: string; options: string[]; assume?: string; neededBy?: string; ask?: boolean;
    ifWrong?: { waste: number; harm: "none" | "quality" | "deadline" | "external"; fixable: "before_step" | "after_submit" | "never" } }>;
  /** The planner's judgement of the task's long-term importance; absent on plans made before it was asked for. */
  importance?: { longTerm: boolean; why: string };
  /** The planner's judgement of how close the work is to what the person knows (core `familiarity.ts`); absent on plans made before it. */
  familiarity?: { level: "near" | "mid" | "far"; why: string };
};
export type StoredTaskStep = StepPlanInput["steps"][number] & {
  workOrderId: string; seq: number; status: "planned" | "done" | "skipped"; progressQuarter: number; updatedAt: string;
};
export type StoredStepPlan = {
  workOrderId: string; version: number; archetypeId: string; quantity: StepPlanInput["quantity"]; rationale: string; plannedAt: string;
  units: NonNullable<StepPlanInput["units"]>; questions: NonNullable<StepPlanInput["questions"]>;
  importance?: StepPlanInput["importance"];
  familiarity?: StepPlanInput["familiarity"];
  needs?: StepPlanInput["needs"];
  steps: StoredTaskStep[];
};

export type EvidenceClaimInput ={ kind: "file" | "link" | "record" | "telemetry"; uri: string; description: string };

export type StoredEvidenceClaim = EvidenceClaimInput & {
  id: string; ownerId: string; workspaceId: string; workOrderId: string;
  reviewStatus: "submitted" | "accepted" | "rejected"; createdAt: string;
};

export type StoredMaterial = {
  id: string; ownerId: string; workspaceId: string; workOrderId: string;
  uri: string; mediaType: string; sourceRefs: string[]; createdAt: string;
};

export type StoredCaptureAttachment = {
  id: string; ownerId: string; workspaceId: string; captureId: string;
  uri: string; mediaType: string; fileName: string; createdAt: string;
};

/**
 * What makes a milestone this person's own: where they start, what "done" is in their words, the date it has
 * to land by, who else is involved, and which things the profile said that justify it. Kept beside the
 * milestone, keyed by its id, so a revision of the milestone does not lose it.
 */
/**
 * Something the person is waiting for from someone else — 「师兄 10/8 左右给真实测量数据」. The work it holds
 * up (`blocks`) is not scheduled before `expectedAt`; at `followUpAt` the person is asked whether it came.
 * It is never inferred to have arrived: only the person's answer moves it.
 */
export type StoredWaitingItem = {
  id: string; ownerId: string; workspaceId: string;
  title: string; who: string;
  /** `YYYY-MM-DD`: when it is expected. */
  expectedAt: string;
  /** The source said 「左右」/「大概」: the date is a guess, not a promise. */
  approximate: boolean;
  /** `YYYY-MM-DD`: when to ask. Starts as `expectedAt`; moved by 「还没，推迟到…」. */
  followUpAt: string;
  state: "open" | "arrived" | "cancelled";
  /** Work orders that cannot start until it arrives. */
  blocks: string[];
  /** `recording`: what someone else promised the person in a recording (the digest, docs/phone-recording.md). */
  source: "analysis" | "manual" | "assistant" | "backplan" | "datepair" | "recording" | "opportunity";
  createdAt: string; updatedAt: string;
};

export type StoredExecution = {
  id: string; ownerId: string; workspaceId: string; workOrderId: string;
  startedAt: string; endedAt?: string;
  // Interrupted minutes are held apart from wall-clock so duration learning never counts them as work.
  pauseMinutes: number;
  durationObserved: boolean;
  outcome?: "completed" | "completed_without_evidence" | "blocked";
  interruptions: Array<{ pausedAt: string; resumedAt?: string; reason: string }>;
  /** Answers to the WorkOrder's own `evidenceChecklist`, submitted alongside `evidence` at
   * `human.completed` — see 工作块 E. Belongs to this completion, not to any one evidence claim, so it
   * lives here rather than as a column on `evidence_claims`. Absent when the order had no checklist or
   * the person answered none of it. */
  checklistAnswers?: ChecklistAnswer[];
  /** A 拟计时 draft the person confirmed (`recordInferredSession`); absent for a timer or a reported session. */
  source?: "inferred_confirmed";
};

export type StoredPlanVersion = {
  id: string; ownerId: string; workspaceId: string; version: number;
  /** `current` since migration 14 (one row, updated in place); the others only on rows written before it. */
  status: "current" | "draft" | "approved" | "superseded"; payload: unknown;
};

/**
 * One real completion's active minutes, recorded the moment a WorkOrder reaches `accepted`, plus the
 * identity-pack's static prior frozen at that same instant. The frozen baseline is what lets a later
 * backtest ask "did calibration actually beat a zero-personal-data guess?" without the comparison being
 * circular — reading it back off a WorkOrder's own `estimate` would already be calibrated by then.
 */
export type StoredDurationObservation = {
  id: string; ownerId: string; workspaceId: string; workOrderId: string; executionId: string;
  identityId: string; family: string;
  observedMinutes: number; wallClockMinutes: number; pauseMinutes: number; interruptionDominant: boolean;
  baselineP25Minutes: number; baselineP50Minutes: number; baselineP85Minutes: number;
  /** What the analysis estimated for this order; null when the estimate was not a model's (typed by hand, a seed). */
  llmP50Minutes: number | null; llmP85Minutes: number | null;
  /** `timer` (start/stop), `one_tap` (chosen at completion), `activity` (the screen record's suggestion, confirmed). */
  actualSource: "timer" | "one_tap" | "activity";
  contextVersion: string;
  /** Not a real duration (abandoned, sent back): counted, never fitted. */
  censored: boolean;
  observedAt: string; createdAt: string;
};

/** One piece of evidence of a money record as `record_evidence` keeps it (docs/mail-bookkeeping.md §4.3). */
export type RecordEvidenceRow = { recordId: string; source: string; sourceKey: string; sourceRef: string; role: string; kind: string; amount: number; currency: string;
  merchant: string; merchantKey: string; refs: string[]; last4: string; instrument: string; occurredOn: string; senderKey: string };
