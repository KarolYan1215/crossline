import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { chunkText, ftsMatchExpression, searchTerms, SEGMENTER_VERSION, segmentText, type LedgerQuestion, byproductArtifactId, advanceWorkOrder, validateAnalysisProposal, validateAnalysisContext, validateMilestoneGateResult, requiredContractRequirements, validateSuccessCriteria,
  currentMineVersion, mineSkillSettingKey, readMineSkill, acceptanceStandardLines,
  type MilestoneGateResult, type SuccessCriterion, type WorkOrderEvent, type WorkOrderState,
  type MilestoneTemplateKind, type EvidenceQuestionTemplate, type MilestoneTemplateSource,
  type ChecklistAnswer, type DomainRecordInput, type StoredDomainRecord } from "@crossline/core";
import { handOffArtifacts } from "./artifacts";

type LedgerEventInput = {
  ownerId: string;
  workspaceId: string;
  idempotencyKey: string;
  type: string;
  entityId: string;
  payload: unknown;
};

type LedgerEvent = LedgerEventInput & { eventId: string; createdAt: string };

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

export type StoredMilestone = {
  id: string;
  ownerId: string;
  workspaceId: string;
  identityId: string;
  projectId?: string;
  title: string;
  version: number;
  status: "draft" | "approved" | "archived";
  // What would count as reaching it. Without this the gate can only say "looks good".
  successCriteria: SuccessCriterion[];
  verifiability: "measurable" | "judgement_only" | "unstated";
  /** Which `MilestoneTemplate` (if any) this milestone's criteria were built from — absent for a
   * milestone written before templates existed, or one deliberately free-formed. */
  templateId?: string;
  /** Deterministic, computed by `computeMilestoneConfidence` at save time — not a model self-rating.
   * Absent for a pre-template milestone, same reason `templateId` is absent rather than defaulted. */
  confidence?: "low" | "medium" | "high";
  /** Pre-generated completion-time questions, Codex-`ask` style — see 工作块 E. Copied from the chosen
   * template's `evidenceQuestionDefaults` when `templateId` is set, or from the architect Skill's own
   * output for a free-form proposal; empty for a manually-authored milestone with no template. A
   * WorkOrder bound to this milestone copies this bank onto its own `evidenceChecklist` once, at
   * `plan.approved` (`transitionWorkOrder`). */
  evidenceQuestionBank?: EvidenceQuestionTemplate[];
};

export type StoredMilestoneTemplate = {
  id: string;
  kind: MilestoneTemplateKind;
  identityId: string;
  titleHint: string;
  successCriteriaDefaults: SuccessCriterion[];
  evidenceQuestionDefaults: EvidenceQuestionTemplate[];
  source: MilestoneTemplateSource;
  createdAt: string;
};

export type CrosslineSnapshot = {
  schemaVersion: 2;
  exportedAt: string;
  workspaceId: string;
  events: LedgerEvent[];
  milestones: StoredMilestone[];
  capacityCommitments: CapacityCommitment[];
  workOrders: StoredWorkOrder[];
  milestoneRelations: StoredMilestoneRelation[];
  planVersions: StoredPlanVersion[];
  energyObservations: StoredEnergyObservation[];
  tables: Record<string, Array<Record<string, string | number | null>>>;
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
    firstAction?: string }>;
  /** The content units read from the person's material, and what only the person can answer (packages/core/src/steps.ts). */
  units?: Array<{ id: string; title: string; docId: string; quote: string }>;
  questions?: Array<{ id: string; text: string; why: string; options: string[] }>;
  /** The planner's judgement of the task's long-term importance; absent on plans made before it was asked for. */
  importance?: { longTerm: boolean; why: string };
};
export type StoredTaskStep = StepPlanInput["steps"][number] & {
  workOrderId: string; seq: number; status: "planned" | "done" | "skipped"; progressQuarter: number; updatedAt: string;
};
export type StoredStepPlan = {
  workOrderId: string; version: number; archetypeId: string; quantity: StepPlanInput["quantity"]; rationale: string; plannedAt: string;
  units: NonNullable<StepPlanInput["units"]>; questions: NonNullable<StepPlanInput["questions"]>;
  importance?: StepPlanInput["importance"];
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

export type StoredAssistantThread = {
  id: string; ownerId: string; workspaceId: string;
  codexThreadId?: string; workOrderId?: string; createdAt: string; updatedAt: string;
};

export type StoredAssistantAttachment = {
  id: string; ownerId: string; workspaceId: string; threadId: string;
  uri: string; mediaType: string; fileName: string; createdAt: string;
};

/**
 * A project is one thing the person is actually working on inside an identity (a paper, a product, a
 * channel). Until now a project was a bare string on a milestone, `${identity}-default` for nearly all
 * of them, so a person with two research projects had no way to say so. Named `workspace_projects`
 * because a table called `projects` was retired in migration 4 and the restore path refuses that name.
 */
export type StoredProject = {
  id: string; ownerId: string; workspaceId: string; identityId: string; name: string;
  status: "active" | "paused" | "done" | "archived"; summary: string; createdAt: string; updatedAt: string;
};

/** A file the person gave us, with the text pulled out of it: the only form in which a model ever sees it. */
export type StoredSourceDocument = {
  id: string; ownerId: string; workspaceId: string; projectId?: string;
  /** The `src-N` number, fixed at upload (migration 16); set by the store, never by a caller. */
  refNo?: number;
  kind: "pdf" | "docx" | "image" | "audio" | "text";
  fileName: string; mediaType: string; sha256: string; uri: string;
  extractedText: string; extractionStatus: "pending" | "done" | "failed" | "unsupported";
  extractionNote?: string; createdAt: string;
};

/**
 * One passage of a document's text in the full-text index (migration 19, docs/context-selection.md): what the model's `read_chunk` returns
 * and a search hit points at. `heading` is 「文件名 · 项目 · 线」, indexed with the text, so a query naming the course finds its files.
 */
export type DocChunk = { id: number; documentId: string; ord: number; start: number; heading: string; body: string;
  fileName: string; projectId?: string; identityId?: string };
export type DocChunkHit = DocChunk & { score: number };

export type StoredOnboardingSession = {
  id: string; ownerId: string; workspaceId: string; codexThreadId?: string;
  state: "active" | "complete"; coverage: Record<string, unknown>; createdAt: string; updatedAt: string;
};
export type StoredOnboardingMessage = {
  sessionId: string; workspaceId: string; seq: number; role: "assistant" | "user";
  content: unknown; createdAt: string;
};

/** One thing known about the person, with where it came from. `inferred` means nobody has confirmed it. */
export type StoredProfileFact = {
  workspaceId: string; identityId: string; projectId: string; slot: string; value: string;
  status: "confirmed" | "inferred"; sourceRef: string; sourceQuote: string; updatedAt: string;
  /**
   * The numbered sentences (`evidence_sentences`) the fact rests on; `sourceQuote` is their text, filled by the system. Empty for a
   * fact no sentence stands behind (an inference, a fact another Skill wrote from text it was given).
   */
  sourceSentences?: number[];
  /** How often an answer that took effect cited it, and when last (migration 20); present only once it has been used. */
  useCount?: number; lastUsedAt?: string;
};
/** One numbered sentence of a reply or a file (`segmentText`). Ids are per workspace and never reused or renumbered. */
export type StoredSentence = {
  id: number; sourceKind: "reply" | "document"; sourceId: string; ord: number; start: number; end: number; text: string; retired: boolean;
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
  source: "analysis" | "manual" | "assistant" | "backplan" | "datepair" | "recording";
  createdAt: string; updatedAt: string;
};

export type StoredMilestoneAnchor = {
  workspaceId: string; milestoneId: string; stage: number; deadline: string; baseline: string; target: string;
  stakeholders: string[]; sourceFactIds: string[]; dependsOn: string[]; updatedAt: string;
  /**
   * Artifact ids (`StoredArtifactPlan`) this milestone produces for other lines and the ones it uses from them; the cross-line relations
   * are derived from these. Always present when read; left out of a save, the stored ones are kept.
   */
  outputs?: string[]; inputs?: string[];
};

/**
 * One stretch of the same window in the foreground. The title is the person's own and stays on this machine: it is not
 * returned by `listActivitySegments`, not exported, and blanked after the retention period. `recentActivityEntries` is the
 * only way to read it, and it exists so the person can see exactly what is kept.
 */
export type StoredActivitySegment = {
  workspaceId: string; start: string; end: string; app: string; category: string; idle: boolean;
};
export type RecentActivityEntry = StoredActivitySegment & { title: string };

/** What one Skill run cost, as the runtime reported it. Kept so "what does this cost me" has an answer. */
export type StoredModelUsage = {
  workspaceId: string; skill: string; tier: string; model: string; effort: string; spendMode: string; threadId: string;
  ok: boolean; errorCode: string; repairs: number; turns: number; inputTokens: number; cachedInputTokens: number;
  outputTokens: number; reasoningTokens: number; totalTokens: number; durationMs: number; at: string;
  /** What the run was for when it is not the Skill's own business (`non_core`); absent reads as ''. */
  purpose?: string;
};
export type ModelUsageSummary = {
  skill: string; model: string; runs: number; failed: number; repairs: number;
  inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; averageSeconds: number;
  /** The slowest single run in the window — what a time limit has to clear, which an average hides. */
  longestSeconds: number;
};

export type StoredPreference = {
  workspaceId: string; id: string;
  source: "correction" | "retrospective" | "estimate" | "importance" | "standard_confirmed" | "relation_rejected" | "postpone";
  /** A line id, `task:<id>`, `archetype:<id>` or `all`. */
  scope: string; text: string;
  /** How much it counts: a stated correction 1, a measured pattern more, a single manual edit less. */
  weight: number; refId: string; createdAt: string; deletedAt: string | null;
  /** How often an answer that took effect cited it, and when last (migration 20); present only once it has been used. */
  useCount?: number; lastUsedAt?: string;
  /** Lapsed unused (`expireUnused`): kept and shown, never given to a model, restorable. */
  invalidatedAt?: string;
  /** The person kept it (restored a lapsed one): it never lapses again. */
  confirmedAt?: string;
};

/**
 * One lesson from past runs (migration 20, docs/token-economy.md §2): drawn by rule from the ledger or imported once from Codex's memories,
 * for a line and a task archetype (either empty for every one). `source` is the rule (`rule:review_note` …) or `codex-memory`.
 */
export type StoredLesson = {
  workspaceId: string; id: string; lineId: string | null; archetypeId: string | null; kind: "failure" | "preference" | "knowledge";
  text: string; source: string; sourceRef: string; keywords: string; createdAt: string; useCount: number; lastUsedAt: string | null;
  invalidatedAt: string | null;
};
/** Something a model was given and cited (`usedRefs`), counted when its answer takes effect. */
export type UsedRef = { kind: "fact"; identityId: string; projectId: string; slot: string } | { kind: "pref"; id: string } | { kind: "lesson"; id: string };
/** Preferences the person stated (not read off an edit): they come first in a context. */
export const STATED_PREFERENCE_SOURCES: ReadonlySet<string> = new Set(["correction", "retrospective", "standard_confirmed", "relation_rejected"]);
/** Preferences read off an edit, which lapse after `PREFERENCE_LAPSE_DAYS` unused (decided 2026-10-21). */
export const LAPSING_PREFERENCE_SOURCES: ReadonlySet<string> = new Set(["estimate", "importance", "postpone"]);
export const PREFERENCE_LAPSE_DAYS = 30;
export const LESSON_LAPSE_DAYS = 60;

export type StoredDiligenceReport = {
  id: string; ownerId: string; workspaceId: string; scope: string; question: string;
  findings: unknown; proposals: unknown; sources: unknown;
  status: "queued" | "running" | "done" | "failed"; note?: string; runAt: string;
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
};

export type StoredPlanVersion = {
  id: string; ownerId: string; workspaceId: string; version: number;
  /** `current` since migration 14 (one row, updated in place); the others only on rows written before it. */
  status: "current" | "draft" | "approved" | "superseded"; payload: unknown;
};

/** The one input box's conversation of a day (docs/one-input.md). */
export type StoredConversation = { id: string; workspaceId: string; day: string; codexThreadId?: string; createdAt: string; updatedAt: string };
/** person = typed by the person; assistant = the turn's answer (its card in `payload`); nudge = a message the system started. */
export type ConversationRole = "person" | "assistant" | "nudge";
export type StoredConversationMessage = {
  id: string; workspaceId: string; conversationId: string; role: ConversationRole; text: string; payload: Record<string, unknown>; createdAt: string;
};

export type StoredMilestoneRelation = {
  id: string; ownerId: string; workspaceId: string;
  fromMilestoneId: string; toMilestoneId: string;
  kind: "enables" | "reuses" | "informs" | "constrains" | "recurring_feedback";
  // `refuted` is the flywheel's only negative feedback: a relation that turned out not to hold
  // stops producing candidates instead of quietly staying on the graph.
  status: "candidate" | "approved" | "archived" | "refuted";
  // A relation with no evidence may only ever be a candidate, and a candidate decides nothing.
  evidence: Array<{ uri: string; source: string; observedAt: string }>;
  counterexample: Array<{ note: string; observedAt: string }>;
  costMinutes: number | null;
  lastValidatedAt: string | null;
  /** What this relation claims. An arrow with no stated claim cannot be reviewed or refuted. */
  explanation: string | null;
  /** What would show the claim is wrong — the relation's own falsifier, like `staleWhen` on a finding. */
  refutedWhen: string | null;
  /**
   * For a relation derived from the artifact plan: the artifact handed over, the measurable transfer promised (and, once checked, what
   * was delivered), the day it is checked (the downstream deadline) and what the downstream line would lose without it. All null on
   * relations from before the artifact plan (the nightly flywheel's, the old relations run's).
   */
  artifactId: string | null;
  transfer: { metric: string; expected: number; unit: string; hoursSaved: number; lagDays: number; measured: number | null } | null;
  checkOn: string | null;
  counterfactual: string | null;
};

type RelationExtras = "evidence" | "counterexample" | "costMinutes" | "lastValidatedAt" | "explanation" | "refutedWhen"
  | "artifactId" | "transfer" | "checkOn" | "counterfactual";

export type StoredEnergyObservation = {
  id: string; ownerId: string; workspaceId: string;
  source: "self_report" | "execution_history" | "time_pattern" | "local_activity" | "camera_aggregate";
  level: "low" | "medium" | "high" | "uncalibrated";
  confidence: "low" | "medium" | "high";
  aggregate: Record<string, number>;
  observedAt: string;
};

export type StoredPrincipal = { id: string; betterAuthUserId: string; createdAt: string };
export type StoredInvite = {
  id: string; workspaceId: string; email: string; reason: string; status: "pending" | "approved" | "rejected" | "redeemed";
  createdAt: string; codeHash?: string; decidedAt?: string; redeemedAt?: string; redeemedWorkspaceId?: string;
};
export type StoredWorkspace = { id: string; name: string; createdAt: string };
export type StoredWorkspaceMember = {
  principalId: string; workspaceId: string; role: "viewer" | "member" | "owner"; createdAt: string;
};
export type StoredDeviceLease = {
  id: string; principalId: string; workspaceId: string; deviceId: string;
  issuedAt: string; expiresAt: string; revokedAt?: string;
};

/** Reads the lease's own timestamps to judge whether it is currently usable — no I/O, so a caller (a
 * future command-authorization check, an admin "devices" list) can apply it without a fresh store read. */
export function isDeviceLeaseValid(lease: StoredDeviceLease, now: Date): boolean {
  if (lease.revokedAt) return false;
  return now.getTime() < Date.parse(lease.expiresAt);
}

/**
 * Records that the owner, while already signed in through a normal session, confirmed a specific
 * Tailscale login as really them. `nodeKey` is optional — `tailscale serve` forwards only
 * `Tailscale-User-Login`/`-Name`/`-Profile-Pic` to a proxied backend, no node identifier, so there is
 * nothing honest to put there from an HTTP header alone. This binding is a recorded fact, not an
 * authentication mechanism: nothing here bypasses or shortcuts Better Auth's own session check, by design.
 */
export type StoredTailscaleBinding = {
  id: string; principalId: string; workspaceId: string; tailscaleLogin: string;
  nodeKey?: string; createdAt: string;
};
export type StoredAuditEvent = {
  id: string; principalId: string; workspaceId: string; role: string; authMethod: string;
  requestId: string; idempotencyKey?: string;
  codexThreadId?: string; codexTurnId?: string; codexCallId?: string;
  action: string; payload: unknown; createdAt: string;
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

export type StoredBackgroundFact = { key: string; value: string; why: string; sourceQuote: string; updatedAt: string };

/**
 * Tables that once existed and never carried a row.
 *
 * Dropped at migration 4. Named here because a snapshot taken before that still lists them, and a
 * restore has to step over an empty one rather than refuse the whole backup — while still refusing
 * if one somehow has rows, because skipping those would be losing data quietly.
 */
/** Tables derived from others and rebuilt from them (migration 19's passages): not exported, skipped on restore, rebuilt after it. */
const DERIVED_TABLES: readonly string[] = ["doc_chunks"];

const RETIRED_TABLES = ["outbox", "identities", "projects", "milestone_versions", "insight_proposals", "skill_versions"] as const;

/** Columns a migration dropped, by table. Same reason as `RETIRED_TABLES`: old snapshots still list them. */
const RETIRED_COLUMNS: Record<string, readonly string[]> = { energy_observations: ["expires_at"] };

/** A replayed time can never precede what it follows: a resume before its pause, an end before its start. */
function notBefore(at: string, floor: string | undefined): string {
  return floor && Date.parse(at) < Date.parse(floor) ? floor : at;
}

/**
 * The person's own actions — what they said in the input box or the interview, timing or confirming work, an answered question, a
 * capture or discard, a milestone or line edit, a step's progress, an energy self-report — never anything the system did. One row per
 * action, as `at`, for workspace `@ws` from `@since`.
 */
const PERSON_EVENTS = ["ask.answered", "block.confirmed", "execution.confirmed", "execution.paused", "execution.resumed", "capture.created",
  "capture.discarded", "milestone.revised", "milestone.retrospective", "approval.revoked", "risk.accepted", "ask.snoozed", "return.answered",
  // Setting up: a line or its goal changed, a batch of dates decided, a file filed. Missing these, someone in the middle of the interview
  // read as days away, and the engagement tier held back the planning their answers were for.
  "line.created", "line.updated", "line.ranked", "lines.set_up", "dates.decided", "source.project_assigned",
  // Decisions about skills the person makes on Skill 库 (2026-10-20): a script's leave, a workflow's risks accepted, a site logged in.
  "skill.scripts_allowed", "skill.scripts_revoked", "skill.grown.consented", "skill.grown.logged_in"];
const PERSON_ACTIVITY_SQL = `
  SELECT created_at AS at FROM conversation_messages WHERE workspace_id = @ws AND role = 'person' AND created_at >= @since
  UNION ALL SELECT created_at FROM onboarding_messages WHERE workspace_id = @ws AND role = 'user' AND created_at >= @since
  UNION ALL SELECT started_at FROM executions WHERE workspace_id = @ws AND started_at >= @since
  UNION ALL SELECT ended_at FROM executions WHERE workspace_id = @ws AND ended_at IS NOT NULL AND ended_at >= @since
  UNION ALL SELECT observed_at FROM energy_observations WHERE workspace_id = @ws AND source = 'self_report' AND observed_at >= @since
  UNION ALL SELECT created_at FROM events WHERE workspace_id = @ws AND created_at >= @since
    AND (type IN (${PERSON_EVENTS.map((type) => `'${type}'`).join(",")})
      OR (type = 'task.step_progress' AND json_extract(payload_json, '$.source') IN ('user', 'person', 'confirm'))
      -- An undoable change made on a page (availability, shares, weights, a lock, a due day…) and an undo (2026-10-20: these were not
      -- counted, so a plan edit on one side read as no activity and the ledger sync could copy the other side over it). Ops the worker
      -- writes for itself carry bySystem; the daily merge's older ones are known by their inverse.
      OR (type = 'op.applied' AND json_extract(payload_json, '$.bySystem') IS NULL
        AND COALESCE(json_extract(payload_json, '$.inverse.kind'), '') <> 'task.unmerge')
      OR type = 'op.undone'
      -- A public skill the person added by its link (the scout's own finds carry no via).
      OR (type LIKE 'skill.public.%' AND json_extract(payload_json, '$.via') = 'link'))`;

/** A stored id list (`source_sentences`), tolerant of a hand-edited or empty value. */
function sentenceIds(raw: unknown): number[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" && raw ? raw : "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id) && id > 0) : [];
  } catch { return []; }
}
const questionRow = (row: Record<string, string | number | null>): LedgerQuestion => ({ id: Number(row.id), kind: row.kind as LedgerQuestion["kind"],
  key: String(row.key), text: String(row.text), options: (() => { try { return JSON.parse(String(row.options_json ?? "[]")) as string[]; } catch { return []; } })(),
  identityId: String(row.identity_id ?? ""), projectId: String(row.project_id ?? ""), status: row.status as LedgerQuestion["status"], answer: String(row.answer ?? ""),
  answerSentences: sentenceIds(row.answer_sentences), ...(typeof row.repeats === "number" ? { repeats: row.repeats } : {}), askedAt: String(row.asked_at),
  ...(row.answered_at ? { answeredAt: String(row.answered_at) } : {}) });
const sentenceRow = (row: Record<string, string | number>): StoredSentence => ({ id: Number(row.id), sourceKind: row.source_kind as StoredSentence["sourceKind"],
  sourceId: String(row.source_id), ord: Number(row.ord), start: Number(row.start_at), end: Number(row.end_at), text: String(row.text), retired: Number(row.retired) === 1 });

export class CrosslineStore {
  readonly #db: Database.Database;
  /** The ledger file (`:memory:` in tests); the data directory is the folder it sits in. */
  readonly file: string;

  constructor(path: string) {
    this.file = path;
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    // Deliberately no `busy_timeout` and no `journal_size_limit` here. Both looked necessary and
    // measured out as non-problems: better-sqlite3 already defaults the busy timeout to 5000ms, and
    // the 4 MB WAL beside this 352 KB database is not a missing checkpoint — it is the automatic
    // checkpoint threshold doing its job, with the file reused rather than truncated. Four megabytes
    // costs nothing, and a `journal_size_limit` equal to the threshold would not have shrunk it.
    const previousVersion = Number(this.#db.pragma("user_version", { simple: true }));
    const hasLegacyTasks = this.#hasTable("tasks");
    if (hasLegacyTasks && path !== ":memory:" && existsSync(path)) {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(path, previousVersion === 1 ? `${path}.v1.bak` : `${path}.pre-r2.bak`);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, key)
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, audit_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_attachments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        capture_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        file_name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, capture_id, uri)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(id, version)
      );
      CREATE TABLE IF NOT EXISTS milestone_relations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
        status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived')), updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL, project_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
        intent TEXT NOT NULL, state TEXT NOT NULL, risk_tier TEXT NOT NULL,
        estimate_json TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        pause_minutes INTEGER NOT NULL DEFAULT 0, outcome TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_claims (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, kind TEXT NOT NULL, uri TEXT NOT NULL,
        review_status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        source_refs_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, work_order_id, uri)
      );
      CREATE TABLE IF NOT EXISTS plan_versions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        version INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS energy_observations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        source TEXT NOT NULL, level TEXT NOT NULL, confidence TEXT NOT NULL,
        aggregate_json TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_bindings (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL, external_id TEXT NOT NULL, etag TEXT, sync_cursor TEXT,
        mode TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, provider, external_id)
      );
      CREATE TABLE IF NOT EXISTS capacity_commitments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, minimum_minutes INTEGER NOT NULL,
        source_task_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY, better_auth_user_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('viewer','member','owner')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(principal_id, workspace_id)
      );
      CREATE INDEX IF NOT EXISTS workspace_members_workspace ON workspace_members(workspace_id);
      CREATE TABLE IF NOT EXISTS tailscale_bindings (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        tailscale_login TEXT NOT NULL, node_key TEXT, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, tailscale_login)
      );
      CREATE TABLE IF NOT EXISTS device_leases (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        device_id TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
        UNIQUE(workspace_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS device_leases_workspace ON device_leases(workspace_id, device_id);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        role TEXT NOT NULL, auth_method TEXT NOT NULL, request_id TEXT NOT NULL,
        idempotency_key TEXT, codex_thread_id TEXT, codex_turn_id TEXT, codex_call_id TEXT,
        action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_workspace ON audit_events(workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS duration_observations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        identity_id TEXT NOT NULL, family TEXT NOT NULL,
        observed_minutes INTEGER NOT NULL, wall_clock_minutes INTEGER NOT NULL, pause_minutes INTEGER NOT NULL,
        interruption_dominant INTEGER NOT NULL DEFAULT 0,
        baseline_p25_minutes INTEGER NOT NULL, baseline_p50_minutes INTEGER NOT NULL, baseline_p85_minutes INTEGER NOT NULL,
        observed_at TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, execution_id)
      );
      CREATE INDEX IF NOT EXISTS duration_observations_bucket ON duration_observations(workspace_id, identity_id, family, observed_at);
      CREATE TABLE IF NOT EXISTS assistant_threads (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        codex_thread_id TEXT, work_order_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assistant_threads_workspace ON assistant_threads(workspace_id, updated_at);
      CREATE TABLE IF NOT EXISTS assistant_attachments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        file_name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, thread_id, uri)
      );
      CREATE INDEX IF NOT EXISTS assistant_attachments_thread ON assistant_attachments(workspace_id, thread_id);
      CREATE TABLE IF NOT EXISTS milestone_templates (
        id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('deliverable','threshold','validation','recurring_cadence','decision')),
        identity_id TEXT NOT NULL, title_hint TEXT NOT NULL,
        success_criteria_defaults_json TEXT NOT NULL, evidence_question_defaults_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('builtin','user','assistant')), created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS milestone_templates_identity ON milestone_templates(workspace_id, identity_id);
      CREATE TABLE IF NOT EXISTS workspace_projects (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, identity_id TEXT NOT NULL,
        name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','done','archived')),
        summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS workspace_projects_identity ON workspace_projects(workspace_id, identity_id);
      CREATE TABLE IF NOT EXISTS source_documents (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('pdf','docx','image','audio','text')),
        file_name TEXT NOT NULL, media_type TEXT NOT NULL, sha256 TEXT NOT NULL, uri TEXT NOT NULL,
        extracted_text TEXT NOT NULL DEFAULT '',
        extraction_status TEXT NOT NULL CHECK(extraction_status IN ('pending','done','failed','unsupported')),
        extraction_note TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, sha256)
      );
      CREATE TABLE IF NOT EXISTS onboarding_sessions (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, codex_thread_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('active','complete')), coverage_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS onboarding_messages (
        session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('assistant','user')), content_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS profile_facts (
        workspace_id TEXT NOT NULL, identity_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '',
        slot TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','inferred')),
        source_ref TEXT NOT NULL, source_quote TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, identity_id, project_id, slot)
      );
      CREATE TABLE IF NOT EXISTS waiting_items (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', expected_at TEXT NOT NULL, approximate INTEGER NOT NULL DEFAULT 0,
        follow_up_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','arrived','cancelled')),
        blocks_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS waiting_items_open ON waiting_items (workspace_id, state, follow_up_at);
      CREATE TABLE IF NOT EXISTS activity_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        app TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, idle INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS activity_segments_by_time ON activity_segments (workspace_id, end_at);
      CREATE TABLE IF NOT EXISTS model_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, skill TEXT NOT NULL, tier TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '', spend_mode TEXT NOT NULL DEFAULT 'normal',
        thread_id TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '', repairs INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_usage_by_time ON model_usage (workspace_id, at);
      CREATE TABLE IF NOT EXISTS milestone_anchors (
        workspace_id TEXT NOT NULL, milestone_id TEXT NOT NULL, stage INTEGER NOT NULL, deadline TEXT NOT NULL,
        baseline TEXT NOT NULL, target TEXT NOT NULL, stakeholders_json TEXT NOT NULL DEFAULT '[]',
        source_fact_ids_json TEXT NOT NULL DEFAULT '[]', depends_on_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, milestone_id)
      );
      CREATE TABLE IF NOT EXISTS diligence_reports (
        id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        question TEXT NOT NULL, findings_json TEXT NOT NULL DEFAULT '[]', proposals_json TEXT NOT NULL DEFAULT '[]',
        sources_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')), note TEXT, run_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, id)
      );
      -- A task's step graph (packages/core/src/steps.ts). The plan row says which archetype and how big; each step is scheduled on
      -- its own and carries its part of the task's progress. Replanning replaces the steps that are not done yet.
      CREATE TABLE IF NOT EXISTS task_step_plans (
        workspace_id TEXT NOT NULL, work_order_id TEXT NOT NULL, version INTEGER NOT NULL, archetype_id TEXT NOT NULL,
        quantity_json TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '', planned_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, work_order_id)
      );
      CREATE TABLE IF NOT EXISTS task_steps (
        workspace_id TEXT NOT NULL, work_order_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
        title TEXT NOT NULL, deliverable TEXT NOT NULL DEFAULT '', done_criterion TEXT NOT NULL DEFAULT '', share REAL NOT NULL,
        p25_minutes INTEGER NOT NULL, p50_minutes INTEGER NOT NULL, p85_minutes INTEGER NOT NULL, depends_on_json TEXT NOT NULL DEFAULT '[]',
        not_before TEXT NOT NULL DEFAULT '', due_by TEXT NOT NULL DEFAULT '', schedulable INTEGER NOT NULL DEFAULT 1,
        executor TEXT NOT NULL DEFAULT 'human', tick_outcome TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','done','skipped')), progress_quarter INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, work_order_id, id)
      );
      -- What the system has learned about how this person wants things done (decided 2026-10-07): a correction told to the assistant,
      -- a milestone retrospective, an estimate or importance the person changed, a standard confirmed by hand, a relation turned down.
      -- Every later analysis, step plan and milestone design is given the live ones; the person can delete any of them in Settings.
      CREATE TABLE IF NOT EXISTS preference_entries (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1, ref_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, deleted_at TEXT,
        PRIMARY KEY(workspace_id, id)
      );
      -- Task archetypes the curator drew from this person's tasks and a public standard; offered to the step planner beside the
      -- built-in eighteen until the person retires one.
      CREATE TABLE IF NOT EXISTS learned_archetypes (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, archetype_json TEXT NOT NULL, basis_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, retired_at TEXT,
        PRIMARY KEY(workspace_id, id)
      );
    `);
    if (hasLegacyTasks) this.#migrateLegacyTasks();
    this.#runMigrations(path);
    this.#markPromotedCaptures();
  }

  /**
   * Applies every migration the database has not seen, in order, one transaction each.
   *
   * What this replaces was a run of `PRAGMA table_info` probes, and it was broken in a way that could
   * not be noticed: several probed for one column and then added two. Die between the two `exec`
   * calls and the guard column exists while the second does not, so the condition is false forever —
   * a permanently half-migrated database with nothing to detect it. `user_version` was written
   * unconditionally at the end and gated nothing.
   *
   * That was survivable while one person had one database. It is not survivable once anyone else runs
   * this, because a schema change then executes against databases nobody can inspect — which is the
   * real thing standing between this and being shippable, far more than any query or index.
   *
   * Rules: append only, never edit a shipped step, and keep each one idempotent anyway so a
   * half-applied step from the old regime can still be stepped over.
   */
  /** Each row the query returns (shaped like the retired `plan_changes`) becomes a `plan.change_archived` event; the migration and the restore share it. */
  #archivePlanChangeRows(query: string, params: unknown[] = []): void {
    this.#db.prepare(`
      INSERT OR IGNORE INTO events (event_id, owner_id, workspace_id, idempotency_key, type, entity_id, payload_json, created_at)
      SELECT lower(hex(randomblob(16))), owner_id, workspace_id, 'plan-change-archived:' || id, 'plan.change_archived', plan_version_id,
        json_object('id', id, 'planVersionId', plan_version_id, 'kind', kind, 'triggerEventId', trigger_event_id,
          'explanation', explanation, 'before', json(before_json), 'after', json(after_json), 'status', status),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM (${query})`).run(...params);
  }

  /** Keeps each workspace's newest plan row as the one current plan; older rows become `plan.version_archived` events. */
  #collapsePlanVersions(workspaceId?: string): void {
    const scope = workspaceId ? "WHERE workspace_id = ?" : "";
    const params = workspaceId ? [workspaceId] : [];
    const older = `SELECT * FROM plan_versions p ${scope ? `${scope} AND` : "WHERE"} id <> (SELECT id FROM plan_versions q
      WHERE q.workspace_id = p.workspace_id ORDER BY version DESC, created_at DESC LIMIT 1)`;
    this.#db.prepare(`
      INSERT OR IGNORE INTO events (event_id, owner_id, workspace_id, idempotency_key, type, entity_id, payload_json, created_at)
      SELECT lower(hex(randomblob(16))), owner_id, workspace_id, 'plan-version-archived:' || id, 'plan.version_archived', id,
        json_object('id', id, 'version', version, 'status', status, 'payload', json(payload_json), 'createdAt', created_at),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM (${older})`).run(...params);
    this.#db.prepare(`DELETE FROM plan_versions WHERE id IN (SELECT id FROM (${older}))`).run(...params);
    this.#db.prepare(`UPDATE plan_versions SET status = 'current' ${scope}`).run(...params);
  }

  #runMigrations(path: string): void {
    const has = (table: string, column: string) =>
      (this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);

    const migrations: Array<{ version: number; up: () => void }> = [
      // Everything through v2 is what the probe-based code used to do, restated as ordered steps. A
      // database that already ran the probes lands here at user_version 2 and skips all of it.
      { version: 3, up: () => {
        if (!has("milestones", "project_id")) this.#db.exec("ALTER TABLE milestones ADD COLUMN project_id TEXT");
        if (!has("captures", "attempt")) this.#db.exec("ALTER TABLE captures ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
        // Existing milestones predate success criteria. They are marked `unstated` rather than given
        // invented criteria — the gate refuses them until a human writes what would count.
        if (!has("milestones", "success_criteria_json")) this.#db.exec("ALTER TABLE milestones ADD COLUMN success_criteria_json TEXT NOT NULL DEFAULT '[]'");
        if (!has("milestones", "verifiability")) this.#db.exec("ALTER TABLE milestones ADD COLUMN verifiability TEXT NOT NULL DEFAULT 'unstated'");
        if (!has("work_orders", "recurrence_json")) this.#db.exec("ALTER TABLE work_orders ADD COLUMN recurrence_json TEXT");
        if (!has("work_orders", "tombstone_json")) this.#db.exec("ALTER TABLE work_orders ADD COLUMN tombstone_json TEXT");
        // SQLite cannot widen a CHECK in place, so the relation table is rebuilt once to admit
        // `refuted` and to carry the evidence a relation needs before it may influence anything.
        if (!has("milestone_relations", "evidence_json")) {
          this.#db.exec(`
            CREATE TABLE milestone_relations_v2 (
              id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
              from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
              status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived','refuted')),
              evidence_json TEXT NOT NULL DEFAULT '[]',
              counterexample_json TEXT NOT NULL DEFAULT '[]',
              cost_minutes REAL,
              last_validated_at TEXT,
              updated_at TEXT NOT NULL
            );
            INSERT INTO milestone_relations_v2
              (id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at)
              SELECT id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at
              FROM milestone_relations;
            DROP TABLE milestone_relations;
            ALTER TABLE milestone_relations_v2 RENAME TO milestone_relations;
          `);
        }
        // A relation used to be two milestone ids and a kind — an arrow with no stated claim, which
        // nobody can review and nothing can refute. `explanation` is what it asserts, `refuted_when`
        // is what would show it wrong. Existing rows keep NULL rather than an invented reason.
        if (!has("milestone_relations", "explanation")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN explanation TEXT");
        if (!has("milestone_relations", "refuted_when")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN refuted_when TEXT");
      } },

      // Six tables nothing has ever written, and one column nothing has ever read. They were carried
      // into every backup, every snapshot and every restore drill, and reading the schema suggested
      // capabilities that do not exist. `expires_at` is left over from the energy expiry model that
      // was deliberately removed.
      { version: 4, up: () => {
        for (const table of RETIRED_TABLES) {
          const rows = this.#hasTable(table)
            ? (this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
            : 0;
          // Never drop data. These are empty everywhere they have been looked at, but a row here would
          // mean the assumption was wrong, and finding that out by deleting it is not acceptable.
          if (rows > 0) throw new Error("MIGRATION_RETIRED_TABLE_NOT_EMPTY");
          this.#db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
        if (has("energy_observations", "expires_at")) this.#db.exec("ALTER TABLE energy_observations DROP COLUMN expires_at");

        // Every table's only index was the implicit one on its PRIMARY KEY, so each `WHERE
        // workspace_id = ?` was a full scan — fine at 146 events, not fine after a year of daily use,
        // and nothing here ever deletes a row.
        this.#db.exec(`
          CREATE INDEX IF NOT EXISTS events_workspace_type ON events(workspace_id, type);
          CREATE INDEX IF NOT EXISTS events_workspace_entity ON events(workspace_id, entity_id);
          CREATE INDEX IF NOT EXISTS work_orders_workspace_state ON work_orders(workspace_id, state);
          CREATE INDEX IF NOT EXISTS captures_workspace_state ON captures(workspace_id, state);
          CREATE INDEX IF NOT EXISTS executions_workspace_order ON executions(workspace_id, work_order_id);
          CREATE INDEX IF NOT EXISTS evidence_workspace_order ON evidence_claims(workspace_id, work_order_id);
          CREATE INDEX IF NOT EXISTS materials_workspace_order ON materials(workspace_id, work_order_id);
          CREATE INDEX IF NOT EXISTS milestones_workspace ON milestones(workspace_id, id);
        `);
        // Since migration 14 a new database has no `plan_changes`; only an old one gets its index here.
        if (this.#hasTable("plan_changes")) this.#db.exec("CREATE INDEX IF NOT EXISTS plan_changes_version ON plan_changes(plan_version_id)");
      } },

      // Migration 4 dropped the six tables and the base DDL created them straight back on the next
      // open, so the live ledger sat at version 4 with every one of them present. Found by
      // `pnpm doctor:ledger` on the real database, not by a test — the round-trip tests all compare
      // against `tableNames()`, which agreed with itself either way. The DDL no longer creates them;
      // this drops them once more for a database that already recorded version 4.
      { version: 5, up: () => {
        for (const table of RETIRED_TABLES) {
          if (!this.#hasTable(table)) continue;
          const rows = (this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
          if (rows > 0) throw new Error("MIGRATION_RETIRED_TABLE_NOT_EMPTY");
          this.#db.exec(`DROP TABLE ${table}`);
        }
      } },

      // `node_key TEXT NOT NULL` was written against a guess about what `tailscale serve` forwards to a
      // proxied backend. Verified against Tailscale's own docs before wiring up stage six's "trust this
      // Tailscale identity" binding: Serve forwards exactly three identity headers on tailnet traffic —
      // `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic` — and no node
      // identifier at all. A column the app can never honestly populate is worse than one that admits it
      // does not have the value; this table has never been written to (`tailscale_bindings` is on the
      // retired-table-emptiness check list precisely because nothing has used it yet), so the rebuild
      // carries zero rows and the uniqueness constraint narrows to `(workspace_id, tailscale_login)` —
      // one binding per Tailscale account per workspace, since there is no node id left to distinguish by.
      { version: 6, up: () => {
        if (!has("tailscale_bindings", "node_key") || this.#columnIsNotNull("tailscale_bindings", "node_key")) {
          const rows = (this.#db.prepare("SELECT COUNT(*) AS count FROM tailscale_bindings").get() as { count: number }).count;
          if (rows > 0) throw new Error("MIGRATION_TAILSCALE_BINDINGS_NOT_EMPTY");
          this.#db.exec(`
            DROP TABLE tailscale_bindings;
            CREATE TABLE tailscale_bindings (
              id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
              tailscale_login TEXT NOT NULL, node_key TEXT, created_at TEXT NOT NULL,
              UNIQUE(workspace_id, tailscale_login)
            );
          `);
        }
      } },

      // `ensureSeeded()` (apps/web/lib/crossline.ts) seeds these four tables with fixed literal ids
      // ("personal-plan-v1", "research-starter", "research-startup", "research-starter-work-order") —
      // the same id for every workspace, on purpose, so re-seeding an already-seeded workspace is a
      // no-op. That only works if the id is scoped to the workspace: none of these four primary/unique
      // keys included `workspace_id`, so the ledger's *first* workspace to ever use one of these ids
      // owns it forever, and `ON CONFLICT DO UPDATE` (deliberately, elsewhere, to stop a write from
      // reassigning ownership) never reassigns `workspace_id` either — every other workspace's seed
      // attempt silently rewrites the first workspace's row and still finds nothing under its own id.
      // Confirmed on the real ledger: a second real account's `milestones`/`milestone_relations`/
      // `plan_versions` all read back empty, and `/plan`/`/approvals` threw `PLAN_VERSION_NOT_FOUND`.
      // Real rows exist here, so — unlike v6's tailscale_bindings, which this otherwise mirrors — this
      // must copy forward rather than refuse on non-empty.
      { version: 7, up: () => {
        // Each table's extra columns arrived together in migration 3's ALTERs, so one representative
        // column's presence stands for all of them. A database can reach this migration without ever
        // having actually run migration 3's ALTERs — a hand-built fixture pinned straight to a later
        // `user_version` to test a *different* migration in isolation, same as `tailscale-binding.test.ts`
        // already does for migration 6 — so this cannot assume the columns are always there.
        const milestonesHasExtra = has("milestones", "project_id");
        this.#db.exec(`
          CREATE TABLE milestones_v2 (
            id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            identity_id TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
            updated_at TEXT NOT NULL, project_id TEXT,
            success_criteria_json TEXT NOT NULL DEFAULT '[]', verifiability TEXT NOT NULL DEFAULT 'unstated',
            PRIMARY KEY(workspace_id, id, version)
          );
        `);
        this.#db.exec(milestonesHasExtra
          ? `INSERT INTO milestones_v2 (id, owner_id, workspace_id, identity_id, title, version, status,
               updated_at, project_id, success_criteria_json, verifiability)
             SELECT id, owner_id, workspace_id, identity_id, title, version, status,
               updated_at, project_id, success_criteria_json, verifiability FROM milestones;`
          : `INSERT INTO milestones_v2 (id, owner_id, workspace_id, identity_id, title, version, status, updated_at)
             SELECT id, owner_id, workspace_id, identity_id, title, version, status, updated_at FROM milestones;`);
        this.#db.exec("DROP TABLE milestones; ALTER TABLE milestones_v2 RENAME TO milestones;");

        this.#db.exec(`
          CREATE TABLE plan_versions_v2 (
            id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            version INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, id)
          );
          INSERT INTO plan_versions_v2 (id, owner_id, workspace_id, version, status, payload_json, created_at)
            SELECT id, owner_id, workspace_id, version, status, payload_json, created_at FROM plan_versions;
          DROP TABLE plan_versions;
          ALTER TABLE plan_versions_v2 RENAME TO plan_versions;
        `);

        const relationsHasExtra = has("milestone_relations", "evidence_json");
        const relationsHasExplanation = has("milestone_relations", "explanation");
        this.#db.exec(`
          CREATE TABLE milestone_relations_v3 (
            id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
            status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived','refuted')),
            evidence_json TEXT NOT NULL DEFAULT '[]', counterexample_json TEXT NOT NULL DEFAULT '[]',
            cost_minutes REAL, last_validated_at TEXT, updated_at TEXT NOT NULL,
            explanation TEXT, refuted_when TEXT,
            PRIMARY KEY(workspace_id, id)
          );
        `);
        this.#db.exec(relationsHasExtra
          ? `INSERT INTO milestone_relations_v3 (id, owner_id, workspace_id, from_milestone_id, to_milestone_id,
               kind, status, evidence_json, counterexample_json, cost_minutes, last_validated_at, updated_at
               ${relationsHasExplanation ? ", explanation, refuted_when" : ""})
             SELECT id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status,
               evidence_json, counterexample_json, cost_minutes, last_validated_at, updated_at
               ${relationsHasExplanation ? ", explanation, refuted_when" : ""} FROM milestone_relations;`
          : `INSERT INTO milestone_relations_v3 (id, owner_id, workspace_id, from_milestone_id, to_milestone_id,
               kind, status, updated_at)
             SELECT id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at
               FROM milestone_relations;`);
        this.#db.exec("DROP TABLE milestone_relations; ALTER TABLE milestone_relations_v3 RENAME TO milestone_relations;");

        const workOrdersHasExtra = has("work_orders", "recurrence_json");
        this.#db.exec(`
          CREATE TABLE work_orders_v2 (
            id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            identity_id TEXT NOT NULL, project_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
            intent TEXT NOT NULL, state TEXT NOT NULL, risk_tier TEXT NOT NULL,
            estimate_json TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
            recurrence_json TEXT, tombstone_json TEXT,
            PRIMARY KEY(workspace_id, id)
          );
        `);
        this.#db.exec(workOrdersHasExtra
          ? `INSERT INTO work_orders_v2 (id, owner_id, workspace_id, identity_id, project_id, milestone_id,
               intent, state, risk_tier, estimate_json, payload_json, updated_at, recurrence_json, tombstone_json)
             SELECT id, owner_id, workspace_id, identity_id, project_id, milestone_id,
               intent, state, risk_tier, estimate_json, payload_json, updated_at, recurrence_json, tombstone_json
               FROM work_orders;`
          : `INSERT INTO work_orders_v2 (id, owner_id, workspace_id, identity_id, project_id, milestone_id,
               intent, state, risk_tier, estimate_json, payload_json, updated_at)
             SELECT id, owner_id, workspace_id, identity_id, project_id, milestone_id,
               intent, state, risk_tier, estimate_json, payload_json, updated_at FROM work_orders;`);
        this.#db.exec("DROP TABLE work_orders; ALTER TABLE work_orders_v2 RENAME TO work_orders;");
      } },

      // Plain nullable columns, not a rebuild: neither changes a CHECK constraint or the primary key,
      // so an in-place ALTER is enough (unlike migration 7's milestones_v2, which had to widen the key
      // itself). Both are absent, not defaulted, for every milestone written before templates existed —
      // `computeMilestoneConfidence` reads that absence as `"low"`, the same number that codebase today
      // reports for every milestone with no template to compare against.
      { version: 8, up: () => {
        if (!has("milestones", "template_id")) this.#db.exec("ALTER TABLE milestones ADD COLUMN template_id TEXT");
        if (!has("milestones", "confidence")) this.#db.exec("ALTER TABLE milestones ADD COLUMN confidence TEXT");
      } },

      // Another plain nullable column, same reasoning as migration 8. `checklistAnswers` (work block E's
      // completion-time questions) deliberately does NOT get a column of its own on `evidence_claims` —
      // it belongs to the submission as a whole, not to any one evidence item, so it lives in the
      // execution row's own `payload_json` next to `interruptions`/`durationObserved`, which already
      // holds per-completion data with no schema of its own.
      { version: 9, up: () => {
        if (!has("milestones", "evidence_question_bank_json")) {
          this.#db.exec("ALTER TABLE milestones ADD COLUMN evidence_question_bank_json TEXT");
        }
      } },

      // What the calibration learns from is the model's own error, so each observation keeps the estimate the
      // analysis wrote (not only the identity pack's prior), where the minutes came from, and under which
      // analysis context version it was estimated. Old rows are backfilled from their work order, which still
      // holds the original estimate — they are not thrown away.
      { version: 10, up: () => {
        if (!has("duration_observations", "llm_p50_minutes")) this.#db.exec("ALTER TABLE duration_observations ADD COLUMN llm_p50_minutes INTEGER");
        if (!has("duration_observations", "llm_p85_minutes")) this.#db.exec("ALTER TABLE duration_observations ADD COLUMN llm_p85_minutes INTEGER");
        if (!has("duration_observations", "actual_source")) this.#db.exec("ALTER TABLE duration_observations ADD COLUMN actual_source TEXT NOT NULL DEFAULT 'timer'");
        if (!has("duration_observations", "context_version")) this.#db.exec("ALTER TABLE duration_observations ADD COLUMN context_version TEXT NOT NULL DEFAULT ''");
        if (!has("duration_observations", "censored")) this.#db.exec("ALTER TABLE duration_observations ADD COLUMN censored INTEGER NOT NULL DEFAULT 0");
        this.#db.exec(`
          UPDATE duration_observations SET
            llm_p50_minutes = (SELECT CAST(json_extract(w.estimate_json, '$.p50Minutes') AS INTEGER) FROM work_orders w
              WHERE w.id = duration_observations.work_order_id AND w.workspace_id = duration_observations.workspace_id
                AND json_extract(w.estimate_json, '$.source') = 'llm_prior'),
            llm_p85_minutes = (SELECT CAST(json_extract(w.estimate_json, '$.p85Minutes') AS INTEGER) FROM work_orders w
              WHERE w.id = duration_observations.work_order_id AND w.workspace_id = duration_observations.workspace_id
                AND json_extract(w.estimate_json, '$.source') = 'llm_prior'),
            context_version = COALESCE((SELECT json_extract(w.payload_json, '$.contextVersion') FROM work_orders w
              WHERE w.id = duration_observations.work_order_id AND w.workspace_id = duration_observations.workspace_id), '')
          WHERE llm_p50_minutes IS NULL`);
      } },
      // A step plan now carries what it rests on (decided 2026-10-09): the content units read from the person's files, the questions
      // only the person can answer, and per step what it covers and why. Kept as JSON beside the columns the scheduler reads.
      { version: 11, up: () => {
        if (!has("task_step_plans", "detail_json")) this.#db.exec("ALTER TABLE task_step_plans ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}'");
        if (!has("task_steps", "detail_json")) this.#db.exec("ALTER TABLE task_steps ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}'");
      } },
      // The one input box (docs/one-input.md): a conversation per day, kept in the ledger so another device resumes it and a backup
      // carries it. A message's card (the actions it proposed and what became of each) lives in its payload.
      { version: 12, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, day TEXT NOT NULL, codex_thread_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workspace_id, day));
          CREATE TABLE IF NOT EXISTS conversation_messages (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
            text TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS conversation_messages_by_conversation ON conversation_messages(workspace_id, conversation_id, created_at);`);
      } },
      // Artifact-first joint planning (docs/flywheel-and-views.md §5): a milestone names the artifacts it produces for and uses from other
      // lines, and a relation derived from those references keeps the artifact, the promised transfer, the check day and the
      // counterfactual. Plain columns: old anchors read as producing and using nothing, old relations as carrying no artifact.
      { version: 13, up: () => {
        if (!has("milestone_anchors", "outputs_json")) this.#db.exec("ALTER TABLE milestone_anchors ADD COLUMN outputs_json TEXT NOT NULL DEFAULT '[]'");
        if (!has("milestone_anchors", "inputs_json")) this.#db.exec("ALTER TABLE milestone_anchors ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]'");
        if (!has("milestone_relations", "artifact_id")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN artifact_id TEXT");
        if (!has("milestone_relations", "transfer_json")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN transfer_json TEXT");
        if (!has("milestone_relations", "check_on")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN check_on TEXT");
        if (!has("milestone_relations", "counterfactual")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN counterfactual TEXT");
      } },
      // The plan takes effect by default (docs/loop-and-scout.md §1): one current row that calendar sync updates in place, no plan
      // versions to approve and no differences to settle. Nothing is thrown away: each difference becomes a `plan.change_archived`
      // event and each older version a `plan.version_archived` event before the table and the rows go.
      { version: 14, up: () => {
        if (this.#hasTable("plan_changes")) {
          this.#archivePlanChangeRows("SELECT * FROM plan_changes");
          this.#db.exec("DROP TABLE plan_changes");
        }
        this.#collapsePlanVersions();
      } },
      // Invite codes for the hosted beta (2026-10-18): who applied, the owner's decision, the code's hash (never the code), and which
      // account redeemed it. `workspace_id` is the applicant's, so deleting an account deletes its application with it.
      { version: 15, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS beta_invites (
            id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL, code_hash TEXT, created_at TEXT NOT NULL, decided_at TEXT, redeemed_at TEXT, redeemed_workspace_id TEXT);
          CREATE INDEX IF NOT EXISTS beta_invites_by_workspace ON beta_invites(workspace_id, created_at);
          CREATE UNIQUE INDEX IF NOT EXISTS beta_invites_by_code ON beta_invites(code_hash) WHERE code_hash IS NOT NULL;`);
      } },
      // Numbered evidence (2026-10-19): the person's replies and files cut into sentences with ids the model cites instead of copying
      // words (`evidence_sentences`), the sentences each fact rests on (`profile_facts.source_sentences`), and a document number fixed at
      // upload (`source_documents.ref_no`): `src-N` used to be a position, so removing one file renumbered every later one and the facts
      // and dates citing them pointed at the wrong file. Existing documents keep the number their position gives them today.
      { version: 16, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS evidence_sentences (
            workspace_id TEXT NOT NULL, id INTEGER NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('reply','document')),
            source_id TEXT NOT NULL, source_hash TEXT NOT NULL, ord INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
            text TEXT NOT NULL, segmenter TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, id));
          CREATE INDEX IF NOT EXISTS evidence_by_source ON evidence_sentences(workspace_id, source_kind, source_id, retired, ord);
          CREATE TABLE IF NOT EXISTS workspace_counters (workspace_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
            PRIMARY KEY(workspace_id, name));`);
        if (!has("profile_facts", "source_sentences")) this.#db.exec("ALTER TABLE profile_facts ADD COLUMN source_sentences TEXT NOT NULL DEFAULT '[]'");
        if (!has("source_documents", "ref_no")) {
          this.#db.exec("ALTER TABLE source_documents ADD COLUMN ref_no INTEGER");
          this.#numberDocuments();
        }
      } },
      // The question ledger (2026-10-19): every question put to the person — the interview's, the app's own, 待决, a step plan's — once,
      // numbered per workspace, with its answer and the sentences it was given in, so a model is shown what was already asked.
      { version: 17, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS question_ledger (
            workspace_id TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('interview','ask')), key TEXT NOT NULL,
            text TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]', identity_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK(status IN ('pending','open','answered','assumed','dropped')), answer TEXT NOT NULL DEFAULT '',
            answer_sentences TEXT NOT NULL DEFAULT '[]', repeats INTEGER, asked_at TEXT NOT NULL, answered_at TEXT, updated_at TEXT NOT NULL,
            PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, key));
          CREATE INDEX IF NOT EXISTS question_ledger_by_status ON question_ledger(workspace_id, status, updated_at);`);
      } },
      // Records (2026-10-19, docs/domain-lines.md): a wealth line's bookkeeping and a wellness line's measurements, one row per real event
      // (`dedupe_key`: the same mail, shortcut or confirmation never writes twice). `deleted_at` keeps a removed record out of every sum
      // while the deletion stays undoable.
      { version: 18, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS domain_records (
            workspace_id TEXT NOT NULL, id TEXT NOT NULL, domain TEXT NOT NULL CHECK(domain IN ('wellness','wealth')), kind TEXT NOT NULL,
            at TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL,
            created_at TEXT NOT NULL, deleted_at TEXT,
            PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, dedupe_key));
          CREATE INDEX IF NOT EXISTS domain_records_by_day ON domain_records(workspace_id, domain, at);`);
      } },
      // The files' text as passages in a full-text index (2026-10-20, docs/context-selection.md): each about 800 characters with a heading
      // 「文件名 · 项目 · 线」, in an FTS5 trigram table kept by triggers, so a task's context holds the passages that match it instead of
      // every file cut blind. Derived from `source_documents` and rebuilt from it here, on restore, and whenever a file is read, re-read,
      // filed or removed; never exported. `id` is an INTEGER PRIMARY KEY so the external-content index survives a VACUUM.
      { version: 19, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS doc_chunks (
            id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, ord INTEGER NOT NULL, start_at INTEGER NOT NULL,
            heading TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(workspace_id, document_id, ord));
          CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(heading, body, content='doc_chunks', content_rowid='id', tokenize='trigram');
          CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
            INSERT INTO doc_chunks_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body); END;
          CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
            INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body); END;
          CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
            INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body);
            INSERT INTO doc_chunks_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body); END;`);
        this.#indexDocuments();
      } },
      // What the ledger learned from past runs, in place of Codex's own memories (docs/token-economy.md §2, 2026-10-21): lessons drawn by
      // rule from what already happened (a rejected result's note, the gate's 「部分」, a step far over its cautious estimate, an error
      // repeated in a week, the Codex memories once imported), keyed by line and archetype; and how often each fact, preference and lesson
      // was actually used by an answer that took effect, so context is chosen by use and what is never used lapses. Not derived: exported.
      { version: 20, up: () => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS run_lessons (
            workspace_id TEXT NOT NULL, id TEXT NOT NULL, line_id TEXT, archetype_id TEXT,
            kind TEXT NOT NULL CHECK(kind IN ('failure','preference','knowledge')), text TEXT NOT NULL, source TEXT NOT NULL,
            source_ref TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
            use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, invalidated_at TEXT,
            PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, source, source_ref));
          CREATE INDEX IF NOT EXISTS run_lessons_by_line ON run_lessons(workspace_id, line_id, archetype_id);`);
        if (!has("profile_facts", "use_count")) this.#db.exec("ALTER TABLE profile_facts ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
        if (!has("profile_facts", "last_used_at")) this.#db.exec("ALTER TABLE profile_facts ADD COLUMN last_used_at TEXT");
        if (!has("preference_entries", "use_count")) this.#db.exec("ALTER TABLE preference_entries ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
        if (!has("preference_entries", "last_used_at")) this.#db.exec("ALTER TABLE preference_entries ADD COLUMN last_used_at TEXT");
        if (!has("preference_entries", "invalidated_at")) this.#db.exec("ALTER TABLE preference_entries ADD COLUMN invalidated_at TEXT");
        if (!has("preference_entries", "confirmed_at")) this.#db.exec("ALTER TABLE preference_entries ADD COLUMN confirmed_at TEXT");
      } },
      // What a run was for, beside which Skill ran (2026-10-21, docs/token-economy.md §2.3): `non_core` for the background work nobody
      // waits on that the quota saver holds to a share of the week (public skills' monthly search and reviews, line-skill compiling,
      // research, the nightly flywheel, portrait rewrites, archetype curation, energy advice). One Skill serves both kinds (the reviewer
      // judges public skills and planners' answers), so the Skill's name cannot say it. Older rows read as '' (not non-core).
      { version: 21, up: () => {
        if (!has("model_usage", "purpose")) this.#db.exec("ALTER TABLE model_usage ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
      } }
    ];

    const current = Number(this.#db.pragma("user_version", { simple: true }));
    const pending = migrations.filter((migration) => migration.version > current);
    if (!pending.length) return;
    // A copy before the first change, not only on the legacy-tasks path where the old code took one.
    // Every rebuild until now ran against the live file with no way back.
    if (path !== ":memory:" && existsSync(path)) {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(path, `${path}.v${current}.bak`);
    }
    for (const migration of pending) {
      this.#db.transaction(() => {
        migration.up();
        this.#db.pragma(`user_version = ${migration.version}`);
      })();
    }
  }

  #hasTable(name: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  #columnIsNotNull(table: string, column: string): boolean {
    const info = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    return info.some((item) => item.name === column && item.notnull === 1);
  }

  #migrateLegacyTasks(): void {
    const legacyTasks = this.#db.prepare(
      "SELECT * FROM tasks WHERE identity_id <> 'health'"
    ).all() as Array<Record<string, string | number | null>>;
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO work_orders (
        id, owner_id, workspace_id, identity_id, project_id, milestone_id,
        intent, state, risk_tier, estimate_json, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT OR IGNORE INTO capacity_commitments (
          id, owner_id, workspace_id, title, minimum_minutes, source_task_id, updated_at
        )
        SELECT id, owner_id, workspace_id, title, expected_minutes, id, updated_at
        FROM tasks WHERE identity_id = 'health'
      `).run();
      for (const row of legacyTasks) {
        const p50 = Number(row.expected_minutes);
        insert.run(
          String(row.id), String(row.owner_id), String(row.workspace_id), String(row.identity_id),
          `${String(row.identity_id)}-legacy`, String(row.milestone_id ?? "legacy-unassigned"),
          String(row.title), row.status === "completed" ? "accepted" : "captured",
          row.milestone_id ? "milestone" : "routine",
          // The legacy row held one number. Spreading it into a p25/p85 band and calling that an
          // identity prior invented both the interval and its provenance.
          JSON.stringify({
            p25Minutes: p50, p50Minutes: p50, p85Minutes: p50,
            source: "legacy_task", observationCount: 0, confidence: "low"
          }),
          JSON.stringify({ legacyTaskId: String(row.id), migratedFromSchema: 1 }), String(row.updated_at)
        );
      }
      this.#db.exec("DROP INDEX IF EXISTS tasks_workspace_status; DROP TABLE tasks");
    })();
  }

  // Databases written before the promoted marker left the capture row frozen at the WorkOrder's state,
  // so the same id existed twice and could resurface as analysable. Every promoted id has a WorkOrder.
  #markPromotedCaptures(): void {
    this.#db.prepare(`
      UPDATE captures SET state = 'promoted'
      WHERE state <> 'promoted' AND EXISTS (
        SELECT 1 FROM work_orders w WHERE w.id = captures.id AND w.workspace_id = captures.workspace_id
      )
    `).run();
  }

  /**
   * The database's migration level (`PRAGMA user_version`), advanced by the migration runner.
   *
   * Not the same number as `CrosslineSnapshot.schemaVersion`, which versions the export format and
   * moves only when the snapshot shape changes. They were both 2 for a while, which was a coincidence.
   */
  schemaVersion(): number {
    return Number(this.#db.pragma("user_version", { simple: true }));
  }

  capture(input: Omit<StoredCapture, "state" | "audit" | "attempt">, idempotencyKey: string): string {
    return this.#db.transaction(() => {
      const event = this.appendEvent({ ...input, idempotencyKey, type: "capture.created", entityId: input.id,
        payload: { title: input.title, context: input.context, mode: "manual" } });
      if (event.inserted) this.#db.prepare(
        "INSERT INTO captures (id, owner_id, workspace_id, title, context, state, audit_json, attempt) VALUES (?, ?, ?, ?, ?, 'captured', '{}', 0)"
      ).run(input.id, input.ownerId, input.workspaceId, input.title, input.context);
      return input.id;
    })();
  }

  /**
   * Throws away a raw capture the person does not want, keeping the text and their reason.
   *
   * A capture had no exit at all: the only thing the board offered was 分析, so a duplicate, a mistake
   * or a note that turned out not to be a task sat there forever. Analysing it to get rid of it costs
   * a real Codex turn and leaves a work order to discard afterwards. A capture already promoted is out
   * of scope — the WorkOrder is the live thing then, and it has its own 丢弃.
   */
  discardCapture(workspaceId: string, id: string, reason: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const capture = this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!capture) throw new Error("CAPTURE_NOT_FOUND");
      if (capture.state === "discarded") return { changed: false };
      if (capture.state === "promoted") throw new Error("CAPTURE_ALREADY_PROMOTED");
      if (capture.state === "analyzing") throw new Error("CAPTURE_IS_ANALYZING");
      // The reason is optional: a duplicate or a slip needs no explanation, and asking for one made discarding cost more than keeping.
      // Keyed per attempt, because a restored capture can be discarded again and a fixed key would silently no-op the second time.
      const attempt = this.listEvents(workspaceId, { type: "capture.discarded", entityId: id }).length;
      this.appendEvent({
        ownerId: capture.ownerId, workspaceId, idempotencyKey: attempt ? `capture-discarded:${id}:${attempt}` : `capture-discarded:${id}`,
        type: "capture.discarded", entityId: id, payload: { reason: reason.trim().slice(0, 200), from: capture.state }
      });
      this.#db.prepare("UPDATE captures SET state = 'discarded' WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
      return { changed: true };
    })();
  }

  /** Takes a discarded capture back to the state it was discarded from (an undo, or 恢复 in the archive drawer). */
  restoreCapture(workspaceId: string, id: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const capture = this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!capture) throw new Error("CAPTURE_NOT_FOUND");
      if (capture.state !== "discarded") return { changed: false };
      const discards = this.listEvents(workspaceId, { type: "capture.discarded", entityId: id });
      const from = (discards.at(-1)?.payload as { from?: string } | undefined)?.from;
      const to = from === "captured" ? "captured" : "blocked";
      this.appendEvent({ ownerId: capture.ownerId, workspaceId, idempotencyKey: `capture-restored:${id}:${discards.length}`,
        type: "capture.restored", entityId: id, payload: { to } });
      this.#db.prepare("UPDATE captures SET state = ? WHERE workspace_id = ? AND id = ?").run(to, workspaceId, id);
      return { changed: true };
    })();
  }

  /**
   * The person's answer to a refused analysis: what they add is appended to the capture's own context, so the next
   * attempt reads it the way it read the original. Only a blocked capture takes it — any other state is past asking.
   */
  addCaptureContext(workspaceId: string, id: string, note: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const capture = this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!capture) throw new Error("CAPTURE_NOT_FOUND");
      if (capture.state !== "blocked") return { changed: false };
      const text = note.trim().slice(0, 2000);
      if (!text) throw new Error("CAPTURE_NOTE_REQUIRED");
      const context = capture.context ? `${capture.context}\n补充（${new Date().toISOString().slice(0, 10)}）：${text}` : text;
      this.appendEvent({ ownerId: capture.ownerId, workspaceId, idempotencyKey: `capture-context:${id}:${capture.attempt}`,
        type: "capture.context_added", entityId: id, payload: { note: text } });
      this.#db.prepare("UPDATE captures SET context = ? WHERE workspace_id = ? AND id = ?").run(context, workspaceId, id);
      return { changed: true };
    })();
  }

  listCaptures(workspaceId: string): StoredCapture[] {
    const rows = this.#db.prepare("SELECT * FROM captures WHERE workspace_id = ? ORDER BY rowid").all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      title: row.title!, context: row.context!, state: row.state as StoredCapture["state"],
      attempt: Number(row.attempt ?? 0), audit: JSON.parse(row.audit_json!) }));
  }

  transitionWorkOrder(workspaceId: string, id: string, event: WorkOrderEvent, idempotencyKey: string,
    update: { proposal?: unknown; context?: unknown; audit?: StoredCapture["audit"]; attempt?: number;
      evidence?: EvidenceClaimInput[]; durationObserved?: boolean;
      /** When the act happened, if not now — an offline command replayed later carries the time it was
       * done on the device; stamping it with the replay time made offline work look shorter or longer. */
      occurredAt?: string;
      /** The duration the person chose at completion (one tap, or the screen record's suggestion they confirmed). */
      reportedMinutes?: number; reportedSource?: "one_tap" | "activity";
      /** Answers to the order's own `evidenceChecklist`, submitted alongside `evidence` on
       * `human.completed` — see 工作块 E. Stored on the closing execution row, not on any evidence claim. */
      checklistAnswers?: ChecklistAnswer[];
      // The identity pack's static prior, frozen by the caller at call time — not looked up here, so
      // `packages/db` never needs to know what an "identity pack" is. Present only on `evidence.accepted`;
      // absent (e.g. a pre-`family` WorkOrder, or a caller that can't resolve one) simply skips recording
      // a duration observation for this acceptance.
      durationCalibrationBaseline?: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
      expectedWorkOrder?: StoredWorkOrder } = {}): { changed: boolean; state: WorkOrderState } {
    return this.#db.transaction(() => {
      const current = this.listWorkOrders(workspaceId).find((item) => item.id === id)
        ?? this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!current) throw new Error("WORK_ORDER_NOT_FOUND");
      const state = current.state as WorkOrderState;
      const isCapture = !("intent" in current);
      if (update.expectedWorkOrder && (isCapture
        || JSON.stringify(current) !== JSON.stringify(update.expectedWorkOrder)))
        throw new Error("PROPOSAL_VERSION_CHANGED");
      if (isCapture && !["analysis.proposed", "analysis.accepted", "blocked"].includes(event.type)) throw new Error("INVALID_WORK_ORDER_TRANSITION");
      if (this.#db.prepare("SELECT 1 FROM events WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, idempotencyKey)) {
        return { changed: false, state };
      }
      // A blocked capture is still raw user text, so a new attempt may re-analyse it. A blocked
      // WorkOrder has already been analysed and stays on the formal table's transitions.
      const retrying = isCapture && state === "blocked" && event.type === "analysis.proposed";
      const next = advanceWorkOrder({ ...current, state: retrying ? "captured" : state }, event);
      if (!next.ok) throw new Error(next.blocker.code);
      // A blocked order is accepted only as the person's own completion, never by the gate or a review.
      if (state === "blocked" && event.type === "evidence.accepted" && !event.onCompletion) throw new Error("INVALID_WORK_ORDER_TRANSITION");
      if (event.type === "analysis.accepted") {
        const context = validateAnalysisContext(update.context);
        const proposal = validateAnalysisProposal(update.proposal, context);
        // Empty `milestoneId` means the proposal chose not to bind to any offered milestone — there is
        // no approved-milestone freshness to re-check for that.
        if (proposal.milestoneId) {
          const approved = context.approvedMilestones.find((m) => m.id === proposal.milestoneId)!;
          if (!this.listMilestones(workspaceId).some((m) => m.ownerId === current.ownerId && m.id === approved.id && m.version === approved.version && m.projectId === approved.projectId && m.identityId === approved.identityId && m.status === "approved")) throw new Error("ANALYSIS_MILESTONE_CHANGED");
        }
        if (!update.audit?.threadId || !update.audit?.turnId) throw new Error("ANALYSIS_AUDIT_REQUIRED");
        this.saveWorkOrder({ id, ownerId: current.ownerId, workspaceId, ...proposal, state: next.to,
          payload: { ...proposal, audit: update.audit, contextVersion: context.version } });
      }
      // Copied once, verbatim, from the bound milestone's own `evidenceQuestionBank` — not filtered or
      // matched against the order's `intent`/`evidenceContract`. A milestone's bank today comes from
      // exactly one template (or one Skill call), so it is already small and already specific to that
      // milestone; a relevance filter would add real complexity for no signal it can actually act on
      // with today's data shape. Revisit if a bank ever grows from multiple merged sources.
      if (!isCapture && event.type === "plan.approved") this.#materializeByproducts(workspaceId, current as StoredWorkOrder);
      if (!isCapture && event.type === "plan.approved") {
        const milestoneId = (current as StoredWorkOrder).milestoneId;
        const milestone = milestoneId ? this.getMilestone(workspaceId, milestoneId) : undefined;
        if (milestone?.evidenceQuestionBank?.length) {
          this.#mergeWorkOrderPayload(workspaceId, id, { evidenceChecklist: milestone.evidenceQuestionBank });
        }
      }
      // The acceptance standard is fixed when the work is approved: judging afterwards uses this and adds nothing (the owner's decision of
      // 2026-10-15). A standard the person edited before approving is already there and is kept; a re-approval keeps the first one.
      if (!isCapture && event.type === "plan.approved") {
        const payload = ((current as StoredWorkOrder).payload ?? {}) as { evidenceContract?: Array<{ description?: string; required?: boolean }>; acceptanceStandard?: unknown };
        if (!payload.acceptanceStandard)
          this.#mergeWorkOrderPayload(workspaceId, id, { acceptanceStandard: { fixedAt: update.occurredAt ?? new Date().toISOString(),
            lines: acceptanceStandardLines(payload.evidenceContract) } });
      }
      // The facts and preferences the analysis said it rested on (`usedRefKeys`, resolved by the runner) count as used once the proposal
      // takes effect, and only once: a revoked and re-approved proposal is the same answer.
      if (!isCapture && event.type === "plan.approved") {
        const payload = ((current as StoredWorkOrder).payload ?? {}) as { usedRefKeys?: UsedRef[]; usedRefsCounted?: boolean };
        if (payload.usedRefKeys?.length && !payload.usedRefsCounted) {
          this.markUsed(workspaceId, payload.usedRefKeys, update.occurredAt ?? new Date().toISOString());
          this.#mergeWorkOrderPayload(workspaceId, id, { usedRefsCounted: true });
        }
      }
      const table = isCapture ? "captures" : "work_orders";
      // A promoted capture keeps its raw text and audit but stops being a capture: without this marker
      // the same id would sit in both tables at the same state and could resurface as analysable.
      this.#db.prepare(`UPDATE ${table} SET state = ? WHERE workspace_id = ? AND id = ?`)
        .run(isCapture && event.type === "analysis.accepted" ? "promoted" : next.to, workspaceId, id);
      if (!isCapture) this.#recordExecutionEffects(workspaceId, id, current.ownerId, event, update);
      // A delivered task that produces an artifact hands its files to every task that uses it (docs/flywheel-and-views.md §5.5).
      if (!isCapture && (event.type === "human.completed" || event.type === "agent.delivered")) handOffArtifacts(this, workspaceId, id);
      // An accepted task is finished, so are its steps: pressing 完成 left them at 0/3 with step 1 still 「当前」 and minutes still to go
      // (walkthrough W-16). Steps the person skipped stay skipped.
      if (!isCapture && next.to === "accepted") this.#db.prepare("UPDATE task_steps SET status = 'done', progress_quarter = 4, updated_at = ? WHERE workspace_id = ? AND work_order_id = ? AND status = 'planned'")
        .run(update.occurredAt ?? new Date().toISOString(), workspaceId, id);
      if (isCapture && update.attempt !== undefined) {
        this.#db.prepare("UPDATE captures SET attempt = ? WHERE workspace_id = ? AND id = ?").run(update.attempt, workspaceId, id);
      }
      // Only captures carry an audit row; a promoted WorkOrder keeps its audit inside its own payload.
      if (update.audit && isCapture) this.updateAnalysisAudit(workspaceId, id, update.audit);
      this.appendEvent({ ownerId: current.ownerId, workspaceId, idempotencyKey,
        type: "work_order.transitioned", entityId: id, payload: { from: state, to: next.to, event, ...(update.audit ? { audit: update.audit } : {}) } });
      return { changed: true, state: next.to };
    }).immediate();
  }

  // Runs inside transitionWorkOrder's transaction, so an execution or evidence row can never outlive a
  // rolled-back state change. WorkOrders only — a capture has neither executions nor evidence.
  #recordExecutionEffects(workspaceId: string, id: string, ownerId: string, event: WorkOrderEvent,
    update: { evidence?: EvidenceClaimInput[]; durationObserved?: boolean; checklistAnswers?: ChecklistAnswer[]; occurredAt?: string;
      reportedMinutes?: number; reportedSource?: "one_tap" | "activity";
      durationCalibrationBaseline?: { p25Minutes: number; p50Minutes: number; p85Minutes: number } }): void {
    const open = this.#openExecution(workspaceId, id);
    const now = notBefore(update.occurredAt ?? new Date().toISOString(), open?.interruptions.at(-1)?.resumedAt
      ?? open?.interruptions.at(-1)?.pausedAt ?? open?.startedAt);
    if (event.type === "human.started") {
      this.#db.prepare(`
        INSERT INTO executions (id, owner_id, workspace_id, work_order_id, started_at, ended_at, pause_minutes, outcome, payload_json)
        VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?)
      `).run(randomUUID(), ownerId, workspaceId, id, now,
        JSON.stringify({ durationObserved: update.durationObserved === true, interruptions: [] }));
      return;
    }
    // Ending while paused would otherwise leave the last interruption open and uncounted, so the
    // recorded wall clock would silently read as work. Both endings close it the same way. Tracked in
    // this local rather than re-read from `open`, which is a snapshot taken before this closes anything —
    // the final payload write below has to see the closed interruption, not the stale open one.
    let interruptions = open?.interruptions ?? [];
    if (event.type === "human.completed" || event.type === "blocked" || event.type === "archived") {
      const last = interruptions.at(-1);
      if (open && last && !last.resumedAt) {
        interruptions = [...interruptions.slice(0, -1), { ...last, resumedAt: now }];
        this.#writeInterruptions(open.id, interruptions, open.durationObserved);
      }
    }
    if (event.type === "human.completed" || event.type === "agent.delivered") {
      const evidence = update.evidence ?? [];
      for (const claim of evidence) {
        this.#db.prepare(`
          INSERT INTO evidence_claims (id, owner_id, workspace_id, work_order_id, kind, uri, review_status, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)
        `).run(randomUUID(), ownerId, workspaceId, id, claim.kind, claim.uri, JSON.stringify({ description: claim.description }), now);
      }
      // No evidence is recorded as an explicit outcome rather than as an invented claim.
      if (open) {
        const checklistAnswers = update.checklistAnswers ?? [];
        const reported = update.reportedMinutes && update.reportedMinutes > 0 && update.reportedMinutes <= 24 * 60 ? update.reportedMinutes : undefined;
        this.#db.prepare("UPDATE executions SET ended_at = ?, outcome = ?, payload_json = ? WHERE id = ?")
          .run(now, evidence.length ? "completed" : "completed_without_evidence",
            JSON.stringify({ durationObserved: open.durationObserved, interruptions,
              ...(checklistAnswers.length ? { checklistAnswers } : {}),
              ...(reported ? { reportedMinutes: Math.round(reported), reportedSource: update.reportedSource ?? "one_tap" } : {}) }), open.id);
      }
      // Recorded at completion, not only at acceptance: how long it took is a fact once the work is done, and work waiting for (or
      // refused by) the gate used to teach the calibration nothing — the real ledger had two timed sessions and zero observations.
      if (event.type === "human.completed")
        this.#recordDurationObservationIfCalibratable(workspaceId, id, ownerId, this.listWorkOrders(workspaceId).find((item) => item.id === id),
          update.durationCalibrationBaseline);
      return;
    }
    if (event.type === "evidence.accepted") {
      const order = this.listWorkOrders(workspaceId).find((item) => item.id === id);
      const submitted = this.listEvidenceClaims(workspaceId).filter((claim) => claim.workOrderId === id && claim.reviewStatus === "submitted");
      // A milestone-bound item cannot be accepted on an empty evidence set — unless the person pressed 完成 and that is the acceptance
      // (the owner's decision of 2026-10-15, `completionRule` in core): 「ECE 555 作业 2」 marked done is done, with or without a file.
      // The rule still holds for every other acceptance (the gate, a manual review, the assistant's delivery).
      if (order?.milestoneId && !submitted.length && !(event.type === "evidence.accepted" && event.onCompletion)) throw new Error("EVIDENCE_REQUIRED");
      this.#db.prepare("UPDATE evidence_claims SET review_status = 'accepted' WHERE workspace_id = ? AND work_order_id = ? AND review_status = 'submitted'")
        .run(workspaceId, id);
      this.#recordDurationObservationIfCalibratable(workspaceId, id, ownerId, order, update.durationCalibrationBaseline);
      return;
    }
    if (event.type === "acceptance.revoked") {
      this.#db.prepare("UPDATE evidence_claims SET review_status = 'submitted' WHERE workspace_id = ? AND work_order_id = ? AND review_status = 'accepted'")
        .run(workspaceId, id);
      return;
    }
    if (event.type === "blocked") {
      if (open) this.#db.prepare("UPDATE executions SET ended_at = ?, outcome = 'blocked' WHERE id = ?").run(now, open.id);
      this.#db.prepare("UPDATE evidence_claims SET review_status = 'rejected' WHERE workspace_id = ? AND work_order_id = ? AND review_status = 'submitted'")
        .run(workspaceId, id);
      // A reason that lives only in the ledger is a reason nobody reads; keep it on the row the UI renders.
      this.#mergeWorkOrderPayload(workspaceId, id, { blocker: { reason: event.reason, at: now } });
    }
    // A session running when its order is discarded ends with it; left open, every reader that counts an open session to now
    // (plan vs actual, the work rhythm) went on adding the wall clock — a demo order discarded mid-timer read as 350 hours of work.
    if (event.type === "archived" && open) this.#db.prepare("UPDATE executions SET ended_at = ?, outcome = 'archived' WHERE id = ?").run(now, open.id);
    if (event.type === "plan.approved") this.#mergeWorkOrderPayload(workspaceId, id, { blocker: undefined });
  }

  #mergeWorkOrderPayload(workspaceId: string, id: string, patch: Record<string, unknown>): void {
    const row = this.#db.prepare("SELECT payload_json FROM work_orders WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as { payload_json: string } | undefined;
    if (!row) return;
    this.#db.prepare("UPDATE work_orders SET payload_json = ? WHERE workspace_id = ? AND id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.payload_json), ...patch }), workspaceId, id);
  }

  /**
   * Tags a WorkOrder's `(identityId, family)` bucket after the fact — the one field seeded and
   * pre-`family` WorkOrders never got, which leaves calibration permanently blind to them (see
   * `#recordDurationObservationIfCalibratable`: no `family`, no observation, ever). This only helps a
   * still-open order's *own future* completion; an order already `accepted` had its one write chance at
   * acceptance time and does not get a missed observation back retroactively.
   *
   * Unlike `#mergeWorkOrderPayload`, this is audited: it goes through `appendEvent`'s own idempotency
   * check first, so a repeated call is a safe no-op rather than a second silent overwrite.
   */
  backfillWorkOrderFamily(workspaceId: string, ownerId: string, workOrderId: string, family: string,
    idempotencyKey: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const order = this.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
      if (!order) throw new Error("WORK_ORDER_NOT_FOUND");
      const previousFamily = (order.payload as { family?: string } | undefined)?.family ?? null;
      const { inserted } = this.appendEvent({ ownerId, workspaceId, idempotencyKey,
        type: "work_order.family_backfilled", entityId: workOrderId, payload: { previousFamily, family } });
      if (!inserted) return { changed: false };
      this.#mergeWorkOrderPayload(workspaceId, workOrderId, { family });
      return { changed: true };
    }).immediate();
  }

  /**
   * Publishes a manually-created WorkOrder for a capture, atomically: the WorkOrder must not appear
   * without the capture leaving `captures`, and vice versa, the same "publish as a unit" guarantee
   * `saveBackplanDrafts` gives the backplanner. Skips Codex entirely — `payload.manualPromotion` marks
   * the result so nothing downstream mistakes it for an analysed proposal.
   */
  promoteCaptureManually(workspaceId: string, captureId: string, workOrder: StoredWorkOrder,
    idempotencyKey: string): { ok: true } | { ok: false; code: string } {
    return this.#db.transaction((): { ok: true } | { ok: false; code: string } => {
      if (this.#db.prepare("SELECT 1 FROM events WHERE workspace_id = ? AND idempotency_key = ?")
        .get(workspaceId, idempotencyKey)) return { ok: true };
      const capture = this.listCaptures(workspaceId).find((item) => item.id === captureId);
      if (!capture) return { ok: false, code: "CAPTURE_NOT_FOUND" };
      if (capture.state === "discarded") return { ok: false, code: "CAPTURE_DISCARDED" };
      if (capture.state === "promoted") return { ok: false, code: "CAPTURE_ALREADY_PROMOTED" };
      if (capture.state === "analyzing") return { ok: false, code: "CAPTURE_IS_ANALYZING" };
      if (this.listWorkOrders(workspaceId).some((item) => item.id === workOrder.id))
        return { ok: false, code: "WORK_ORDER_ID_COLLISION" };
      this.saveWorkOrder(workOrder);
      this.#db.prepare("UPDATE captures SET state = 'promoted' WHERE workspace_id = ? AND id = ?").run(workspaceId, captureId);
      this.appendEvent({ ownerId: workOrder.ownerId, workspaceId, idempotencyKey,
        type: "capture.promoted_manually", entityId: captureId, payload: { workOrderId: workOrder.id } });
      return { ok: true };
    }).immediate();
  }

  /**
   * When a work order with byproducts is approved, each byproduct becomes its own small landing order on the
   * other line: it depends on the main order (it is scheduled after it, never in its way), carries its own
   * evidence for its own milestone (the gate judges each separately, so nothing is counted twice), and takes
   * effect by itself — inside the machine, reversible, recorded as `work_order.auto_approved` with the one-day
   * undo every default-effective order has. Created once per (main order, line); re-approving changes nothing.
   */
  #materializeByproducts(workspaceId: string, primary: StoredWorkOrder): void {
    const byproducts = ((primary.payload as { byproducts?: Array<{ lineId: string; milestoneId: string; artifact: string;
      landing: { minutes: number; description: string }; why: string }> } | undefined)?.byproducts) ?? [];
    if (!byproducts.length) return;
    const existing = new Set(this.listWorkOrders(workspaceId).map((order) => order.id));
    const milestones = new Map(this.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
    for (const byproduct of byproducts) {
      const id = `landing-${primary.id}-${byproduct.lineId}`.slice(0, 128);
      if (existing.has(id)) continue;
      const minutes = Math.max(5, Math.round(byproduct.landing.minutes));
      const milestone = byproduct.milestoneId ? milestones.get(byproduct.milestoneId) : undefined;
      this.saveWorkOrder({ id, ownerId: primary.ownerId, workspaceId, identityId: byproduct.lineId,
        projectId: milestone?.projectId ?? `${byproduct.lineId}-default`, milestoneId: milestone ? milestone.id : "",
        intent: `落地：${byproduct.artifact}`.slice(0, 200), state: "approved", riskTier: "routine",
        estimate: { p25Minutes: Math.max(1, Math.round(minutes * 0.7)), p50Minutes: minutes, p85Minutes: Math.round(minutes * 1.6),
          source: "llm_prior", observationCount: 0, confidence: "low" },
        // A byproduct is a small artifact (`byproductArtifactId`) its main task produces and this task uses, landed within
        // `BYPRODUCT_LAG_DAYS` of the main task's delivery; the hand-off gives it the main task's files.
        payload: { family: "preparation", byproductOf: primary.id, inheritsFrom: primary.id, dependsOn: [primary.id],
          uses: [byproductArtifactId(primary.id, byproduct.lineId)],
          contextVersion: (primary.payload as { contextVersion?: string } | undefined)?.contextVersion ?? "",
          humanCore: [{ id: `${id}-core`, intent: byproduct.landing.description, energy: "medium", interruptible: true }],
          automationParts: [], materialContract: [],
          evidenceContract: [{ kind: "record", description: byproduct.artifact.slice(0, 280), why: byproduct.why.slice(0, 280), required: true }] } });
      this.appendEvent({ ownerId: primary.ownerId, workspaceId, idempotencyKey: `work_order.auto_approved:${id}`, type: "work_order.auto_approved",
        entityId: id, payload: { reason: `「${primary.intent.slice(0, 40)}」的顺带产出，排在它之后` } });
      this.appendEvent({ ownerId: primary.ownerId, workspaceId, idempotencyKey: `byproduct.planned:${id}`, type: "byproduct.planned",
        entityId: id, payload: { primaryId: primary.id, lineId: byproduct.lineId, milestoneId: milestone?.id ?? "", artifact: byproduct.artifact } });
    }
  }

  #openExecution(workspaceId: string, workOrderId: string):
    { id: string; ownerId: string; startedAt: string; durationObserved: boolean; interruptions: StoredExecution["interruptions"] } | undefined {
    const row = this.#db.prepare(
      "SELECT id, owner_id, started_at, payload_json FROM executions WHERE workspace_id = ? AND work_order_id = ? AND ended_at IS NULL ORDER BY started_at DESC"
    ).get(workspaceId, workOrderId) as { id: string; owner_id: string; started_at: string; payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as { durationObserved: boolean; interruptions: StoredExecution["interruptions"] };
    return { id: row.id, ownerId: row.owner_id, startedAt: row.started_at, durationObserved: payload.durationObserved, interruptions: payload.interruptions };
  }

  /**
   * Real active minutes are the honest signal only when a live timer actually ran the whole way
   * (`durationObserved`) — a backfilled completion has no clock to trust. Silently does nothing when
   * that's not the case, when the caller couldn't resolve a baseline (no `family` yet, or a pre-`family`
   * WorkOrder), or when no execution ever closed for this order — none of those are errors, they're just
   * "nothing to learn from here yet." `ON CONFLICT DO NOTHING` inside `recordDurationObservation` makes a
   * revoke-then-reaccept cycle (same closed execution, evidence.accepted fired twice) a safe no-op.
   */
  #recordDurationObservationIfCalibratable(workspaceId: string, workOrderId: string, ownerId: string,
    order: StoredWorkOrder | undefined, baseline: { p25Minutes: number; p50Minutes: number; p85Minutes: number } | undefined): void {
    if (!order || !baseline) return;
    const family = (order.payload as { family?: string } | undefined)?.family;
    if (!family) return;
    // Every closed, timed session of this order, not only the last one: work split across two sittings
    // used to be recorded as just the second sitting, so the person looked faster than they are.
    // A session is counted by what the person reported for it at completion (one tap, or the screen record's
    // suggestion they confirmed) when they did — that is the only number available for work done away from the
    // timer — and otherwise by its own timer.
    type Session = { id: string; started_at: string; ended_at: string; pause_minutes: number; payload_json: string };
    const rows = (this.#db.prepare(
      "SELECT id, started_at, ended_at, pause_minutes, payload_json FROM executions WHERE workspace_id = ? AND work_order_id = ? AND ended_at IS NOT NULL ORDER BY started_at"
    ).all(workspaceId, workOrderId) as Session[])
      .map((row) => ({ row, payload: JSON.parse(row.payload_json) as { durationObserved: boolean; reportedMinutes?: number; reportedSource?: "one_tap" | "activity" } }))
      .filter(({ payload }) => payload.durationObserved || (payload.reportedMinutes ?? 0) > 0);
    const last = rows.at(-1)?.row;
    if (!last) return;
    const wallClockMinutes = rows.reduce((sum, { row }) => sum + Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 60_000), 0);
    const pauseMinutes = rows.reduce((sum, { row }) => sum + row.pause_minutes, 0);
    const observedMinutes = rows.reduce((sum, { row, payload }) => sum + ((payload.reportedMinutes ?? 0) > 0 ? payload.reportedMinutes!
      : Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 60_000) - row.pause_minutes), 0);
    const reported = rows.map(({ payload }) => payload.reportedSource).filter(Boolean);
    const actualSource = reported.includes("one_tap") ? "one_tap" as const : reported.includes("activity") ? "activity" as const : "timer" as const;
    if (observedMinutes < 1) return;
    // One observation per work order. A revoke-then-reaccept with no new session is a no-op; one with a new
    // session replaces the earlier row, whose minutes the new sum already contains — inserting beside it
    // counted them twice.
    const existing = this.#db.prepare("SELECT execution_id, observed_minutes FROM duration_observations WHERE workspace_id = ? AND work_order_id = ?")
      .get(workspaceId, workOrderId) as { execution_id: string; observed_minutes: number } | undefined;
    if (existing?.execution_id === last.id && existing.observed_minutes === observedMinutes) return;
    this.#db.prepare("DELETE FROM duration_observations WHERE workspace_id = ? AND work_order_id = ?").run(workspaceId, workOrderId);
    this.recordDurationObservation({
      ownerId, workspaceId, workOrderId, executionId: last.id, identityId: order.identityId, family,
      observedMinutes, wallClockMinutes, pauseMinutes,
      // A reported duration already excludes the interruptions the person lived through; only a timer can be dominated by them.
      interruptionDominant: actualSource === "timer" && pauseMinutes >= wallClockMinutes * 0.5,
      baseline, observedAt: last.ended_at,
      llm: order.estimate.source === "llm_prior" ? { p50Minutes: order.estimate.p50Minutes, p85Minutes: order.estimate.p85Minutes } : null,
      actualSource, contextVersion: String((order.payload as { contextVersion?: string } | undefined)?.contextVersion ?? "")
    });
  }

  #writeInterruptions(executionId: string, interruptions: StoredExecution["interruptions"], durationObserved: boolean): void {
    const pausedMs = interruptions.reduce((total, item) =>
      total + (item.resumedAt ? Date.parse(item.resumedAt) - Date.parse(item.pausedAt) : 0), 0);
    this.#db.prepare("UPDATE executions SET pause_minutes = ?, payload_json = ? WHERE id = ?")
      .run(Math.round(pausedMs / 60_000), JSON.stringify({ durationObserved, interruptions }), executionId);
  }

  // Pause and resume are execution facts, not formal WorkOrder states: the order stays `active`
  // throughout and only the interruption record changes.
  /**
   * A work session the person confirmed after the fact (docs/loop-and-scout.md §3): 「按预估完成」 / 「超出 30 分钟」 on a block that
   * ended. An open session (they pressed start and never stopped) is ended with the confirmed minutes; with none, a closed session is
   * written over the block's own times. The order's state does not move — finishing the task is `human.completed`'s job. The minutes
   * count towards the task's duration observation when it is completed (`reportedMinutes`, like a one-tap report at completion).
   */
  recordConfirmedSession(workspaceId: string, workOrderId: string, ownerId: string,
    session: { startedAt: string; endedAt: string; minutes: number; source: "one_tap" | "activity"; key: string }): { executionId: string; changed: boolean } {
    return this.#db.transaction(() => {
      const minutes = Math.round(Math.min(24 * 60, Math.max(1, session.minutes)));
      const appended = this.appendEvent({ ownerId, workspaceId, idempotencyKey: session.key, type: "execution.confirmed", entityId: workOrderId,
        payload: { startedAt: session.startedAt, endedAt: session.endedAt, minutes, source: session.source } });
      const open = this.#openExecution(workspaceId, workOrderId);
      if (!appended.inserted) return { executionId: open?.id ?? "", changed: false };
      if (open) {
        const endedAt = notBefore(session.endedAt, open.interruptions.at(-1)?.resumedAt ?? open.interruptions.at(-1)?.pausedAt ?? open.startedAt);
        const last = open.interruptions.at(-1);
        const interruptions = last && !last.resumedAt ? [...open.interruptions.slice(0, -1), { ...last, resumedAt: endedAt }] : open.interruptions;
        if (interruptions !== open.interruptions) this.#writeInterruptions(open.id, interruptions, open.durationObserved);
        this.#db.prepare("UPDATE executions SET ended_at = ?, outcome = 'confirmed', payload_json = ? WHERE id = ?")
          .run(endedAt, JSON.stringify({ durationObserved: open.durationObserved, interruptions, reportedMinutes: minutes, reportedSource: session.source }), open.id);
        return { executionId: open.id, changed: true };
      }
      const id = randomUUID();
      this.#db.prepare(`
        INSERT INTO executions (id, owner_id, workspace_id, work_order_id, started_at, ended_at, pause_minutes, outcome, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, 0, 'confirmed', ?)
      `).run(id, ownerId, workspaceId, workOrderId, session.startedAt, notBefore(session.endedAt, session.startedAt),
        JSON.stringify({ durationObserved: false, interruptions: [], reportedMinutes: minutes, reportedSource: session.source }));
      return { executionId: id, changed: true };
    }).immediate();
  }

  /**
   * Opens a timed session on an order already `active` with none open: after a confirmed session closed the last one, pressing start
   * again has to time something (the state machine has no transition for it — the order never left `active`).
   */
  openSession(workspaceId: string, workOrderId: string, ownerId: string, at?: string): { executionId: string } {
    return this.#db.transaction(() => {
      const open = this.#openExecution(workspaceId, workOrderId);
      if (open) return { executionId: open.id };
      const id = randomUUID();
      this.#db.prepare(`
        INSERT INTO executions (id, owner_id, workspace_id, work_order_id, started_at, ended_at, pause_minutes, outcome, payload_json)
        VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?)
      `).run(id, ownerId, workspaceId, workOrderId, at ?? new Date().toISOString(), JSON.stringify({ durationObserved: true, interruptions: [] }));
      return { executionId: id };
    }).immediate();
  }

  pauseExecution(workspaceId: string, workOrderId: string, reason: string, at?: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const open = this.#openExecution(workspaceId, workOrderId);
      if (!open) throw new Error("NO_ACTIVE_EXECUTION");
      if (open.interruptions.at(-1) && !open.interruptions.at(-1)!.resumedAt) return { changed: false };
      const pausedAt = notBefore(at ?? new Date().toISOString(), open.interruptions.at(-1)?.resumedAt ?? open.startedAt);
      this.#writeInterruptions(open.id, [...open.interruptions, { pausedAt, reason }], open.durationObserved);
      this.appendEvent({ ownerId: open.ownerId, workspaceId, idempotencyKey: `execution:${open.id}:pause:${open.interruptions.length}`,
        type: "execution.paused", entityId: workOrderId, payload: { executionId: open.id, reason } });
      return { changed: true };
    }).immediate();
  }

  resumeExecution(workspaceId: string, workOrderId: string, at?: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const open = this.#openExecution(workspaceId, workOrderId);
      if (!open) throw new Error("NO_ACTIVE_EXECUTION");
      const last = open.interruptions.at(-1);
      if (!last || last.resumedAt) return { changed: false };
      const resumedAt = notBefore(at ?? new Date().toISOString(), last.pausedAt);
      this.#writeInterruptions(open.id, [...open.interruptions.slice(0, -1), { ...last, resumedAt }], open.durationObserved);
      this.appendEvent({ ownerId: open.ownerId, workspaceId, idempotencyKey: `execution:${open.id}:resume:${open.interruptions.length - 1}`,
        type: "execution.resumed", entityId: workOrderId, payload: { executionId: open.id, reason: last.reason } });
      return { changed: true };
    }).immediate();
  }

  listExecutions(workspaceId: string, workOrderId?: string): StoredExecution[] {
    const rows = (workOrderId
      ? this.#db.prepare("SELECT * FROM executions WHERE workspace_id = ? AND work_order_id = ? ORDER BY started_at, id").all(workspaceId, workOrderId)
      : this.#db.prepare("SELECT * FROM executions WHERE workspace_id = ? ORDER BY started_at, id").all(workspaceId)) as Array<Record<string, string | number | null>>;
    return rows.map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as {
        durationObserved?: boolean; interruptions?: StoredExecution["interruptions"]; checklistAnswers?: ChecklistAnswer[];
      };
      return {
        id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
        workOrderId: String(row.work_order_id), startedAt: String(row.started_at),
        ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
        pauseMinutes: Number(row.pause_minutes), durationObserved: payload.durationObserved === true,
        ...(row.outcome ? { outcome: String(row.outcome) as NonNullable<StoredExecution["outcome"]> } : {}),
        interruptions: payload.interruptions ?? [],
        ...(payload.checklistAnswers?.length ? { checklistAnswers: payload.checklistAnswers } : {})
      };
    });
  }

  listEvidenceClaims(workspaceId: string): StoredEvidenceClaim[] {
    const rows = this.#db.prepare(
      "SELECT * FROM evidence_claims WHERE workspace_id = ? ORDER BY created_at, id"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, workOrderId: row.work_order_id!,
      kind: row.kind as StoredEvidenceClaim["kind"], uri: row.uri!,
      description: String((JSON.parse(row.payload_json!) as { description?: string }).description ?? ""),
      reviewStatus: row.review_status as StoredEvidenceClaim["reviewStatus"], createdAt: row.created_at!
    }));
  }

  saveMaterial(material: StoredMaterial): void {
    this.#db.prepare(`
      INSERT INTO materials (id, owner_id, workspace_id, work_order_id, uri, media_type, source_refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, work_order_id, uri) DO NOTHING
    `).run(material.id, material.ownerId, material.workspaceId, material.workOrderId, material.uri,
      material.mediaType, JSON.stringify(material.sourceRefs), material.createdAt);
  }

  listMaterials(workspaceId: string, workOrderId?: string): StoredMaterial[] {
    const rows = (workOrderId
      ? this.#db.prepare("SELECT * FROM materials WHERE workspace_id = ? AND work_order_id = ? ORDER BY created_at, id").all(workspaceId, workOrderId)
      : this.#db.prepare("SELECT * FROM materials WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId)) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      workOrderId: row.work_order_id!, uri: row.uri!, mediaType: row.media_type!,
      sourceRefs: JSON.parse(row.source_refs_json!) as string[], createdAt: row.created_at! }));
  }

  saveCaptureAttachment(attachment: StoredCaptureAttachment): void {
    this.#db.prepare(`
      INSERT INTO capture_attachments (id, owner_id, workspace_id, capture_id, uri, media_type, file_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, capture_id, uri) DO NOTHING
    `).run(attachment.id, attachment.ownerId, attachment.workspaceId, attachment.captureId, attachment.uri,
      attachment.mediaType, attachment.fileName, attachment.createdAt);
  }

  listCaptureAttachments(workspaceId: string, captureId?: string): StoredCaptureAttachment[] {
    const rows = (captureId
      ? this.#db.prepare("SELECT * FROM capture_attachments WHERE workspace_id = ? AND capture_id = ? ORDER BY created_at, id").all(workspaceId, captureId)
      : this.#db.prepare("SELECT * FROM capture_attachments WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId)) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      captureId: row.capture_id!, uri: row.uri!, mediaType: row.media_type!,
      fileName: row.file_name!, createdAt: row.created_at! }));
  }

  /** The day's conversation of the one input box, made on first use. */
  conversationFor(workspaceId: string, day: string, now = new Date().toISOString()): StoredConversation {
    this.#db.prepare(`INSERT INTO conversations (id, workspace_id, day, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, day) DO NOTHING`).run(`conv-${workspaceId.slice(0, 8)}-${day}`, workspaceId, day, now, now);
    return this.#conversation(this.#db.prepare("SELECT * FROM conversations WHERE workspace_id = ? AND day = ?").get(workspaceId, day) as Record<string, string>);
  }

  getConversation(workspaceId: string, id: string): StoredConversation | undefined {
    const row = this.#db.prepare("SELECT * FROM conversations WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as Record<string, string> | undefined;
    return row ? this.#conversation(row) : undefined;
  }

  listConversations(workspaceId: string, limit = 60): StoredConversation[] {
    return (this.#db.prepare("SELECT * FROM conversations WHERE workspace_id = ? ORDER BY day DESC LIMIT ?").all(workspaceId, limit) as Array<Record<string, string>>)
      .map((row) => this.#conversation(row));
  }

  setConversationThread(workspaceId: string, id: string, codexThreadId: string | null): void {
    this.#db.prepare("UPDATE conversations SET codex_thread_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(codexThreadId, new Date().toISOString(), workspaceId, id);
  }

  appendConversationMessage(message: Omit<StoredConversationMessage, "createdAt"> & { createdAt?: string }): StoredConversationMessage {
    const createdAt = message.createdAt ?? new Date().toISOString();
    this.#db.prepare(`INSERT INTO conversation_messages (id, workspace_id, conversation_id, role, text, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.workspaceId, message.conversationId, message.role, message.text, JSON.stringify(message.payload ?? {}), createdAt);
    this.#db.prepare("UPDATE conversations SET updated_at = ? WHERE workspace_id = ? AND id = ?").run(createdAt, message.workspaceId, message.conversationId);
    return { ...message, payload: message.payload ?? {}, createdAt };
  }

  /** A card's state changes as the person acts on it (executed, edited, dismissed); the message's words never do. */
  updateConversationPayload(workspaceId: string, messageId: string, payload: Record<string, unknown>): void {
    this.#db.prepare("UPDATE conversation_messages SET payload_json = ? WHERE workspace_id = ? AND id = ?").run(JSON.stringify(payload), workspaceId, messageId);
  }

  /** Only the second look (先快后准) rewrites an answer's words, and only when it changed what the card proposes. */
  updateConversationText(workspaceId: string, messageId: string, text: string): void {
    this.#db.prepare("UPDATE conversation_messages SET text = ? WHERE workspace_id = ? AND id = ? AND role = 'assistant'").run(text, workspaceId, messageId);
  }

  getConversationMessage(workspaceId: string, id: string): StoredConversationMessage | undefined {
    const row = this.#db.prepare("SELECT * FROM conversation_messages WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as Record<string, string> | undefined;
    return row ? this.#message(row) : undefined;
  }

  listConversationMessages(workspaceId: string, conversationId: string): StoredConversationMessage[] {
    return (this.#db.prepare("SELECT * FROM conversation_messages WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at, rowid")
      .all(workspaceId, conversationId) as Array<Record<string, string>>).map((row) => this.#message(row));
  }

  /** The system's own messages since a moment, newest last (the nudge engine's memory, and what the worker delivers when the person is away). */
  listRecentNudges(workspaceId: string, sinceIso: string): StoredConversationMessage[] {
    return (this.#db.prepare("SELECT * FROM conversation_messages WHERE workspace_id = ? AND role = 'nudge' AND created_at >= ? ORDER BY created_at, rowid")
      .all(workspaceId, sinceIso) as Array<Record<string, string>>).map((row) => this.#message(row));
  }

  /** Every conversation is searchable (a note the person jotted lives only here). */
  searchConversationMessages(workspaceId: string, query: string, limit = 30): StoredConversationMessage[] {
    const q = `%${query.replace(/[!%_]/g, (char) => `!${char}`)}%`;
    return (this.#db.prepare("SELECT * FROM conversation_messages WHERE workspace_id = ? AND text LIKE ? ESCAPE '!' ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, q, limit) as Array<Record<string, string>>).map((row) => this.#message(row));
  }

  #conversation(row: Record<string, string>): StoredConversation {
    return { id: row.id!, workspaceId: row.workspace_id!, day: row.day!, ...(row.codex_thread_id ? { codexThreadId: row.codex_thread_id } : {}),
      createdAt: row.created_at!, updatedAt: row.updated_at! };
  }

  #message(row: Record<string, string>): StoredConversationMessage {
    return { id: row.id!, workspaceId: row.workspace_id!, conversationId: row.conversation_id!, role: row.role as ConversationRole, text: row.text!,
      payload: JSON.parse(row.payload_json || "{}") as Record<string, unknown>, createdAt: row.created_at! };
  }

  saveAssistantThread(thread: StoredAssistantThread): void {
    this.#db.prepare(`
      INSERT INTO assistant_threads (id, owner_id, workspace_id, codex_thread_id, work_order_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET codex_thread_id = excluded.codex_thread_id, updated_at = excluded.updated_at
    `).run(thread.id, thread.ownerId, thread.workspaceId, thread.codexThreadId ?? null,
      thread.workOrderId ?? null, thread.createdAt, thread.updatedAt);
  }

  getAssistantThread(workspaceId: string, id: string): StoredAssistantThread | undefined {
    const row = this.#db.prepare("SELECT * FROM assistant_threads WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      ...(row.codex_thread_id ? { codexThreadId: row.codex_thread_id } : {}),
      ...(row.work_order_id ? { workOrderId: row.work_order_id } : {}),
      createdAt: row.created_at!, updatedAt: row.updated_at!
    };
  }

  // --- Projects, source documents, onboarding sessions, profile facts, diligence reports -------------
  // One block because they are one feature: what we know about the person and where it came from.

  saveProject(project: StoredProject): void {
    const before = this.#db.prepare("SELECT name, identity_id FROM workspace_projects WHERE workspace_id = ? AND id = ?")
      .get(project.workspaceId, project.id) as { name: string; identity_id: string } | undefined;
    this.#db.prepare(`
      INSERT INTO workspace_projects (id, owner_id, workspace_id, identity_id, name, status, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET identity_id = excluded.identity_id, name = excluded.name,
        status = excluded.status, summary = excluded.summary, updated_at = excluded.updated_at
    `).run(project.id, project.ownerId, project.workspaceId, project.identityId, project.name, project.status,
      project.summary, project.createdAt, project.updatedAt);
    // Renamed or moved to another line: its files' passages are indexed under the new heading.
    if (before && (before.name !== project.name || before.identity_id !== project.identityId))
      this.#refreshHeadings(project.workspaceId, "document_id IN (SELECT id FROM source_documents WHERE workspace_id = ? AND project_id = ?)", [project.workspaceId, project.id]);
  }

  listProjects(workspaceId: string, options: { identityId?: string; includeArchived?: boolean } = {}): StoredProject[] {
    const rows = this.#db.prepare(
      "SELECT * FROM workspace_projects WHERE workspace_id = ? ORDER BY created_at, rowid"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows
      .filter((row) => (options.includeArchived || row.status !== "archived")
        && (!options.identityId || row.identity_id === options.identityId))
      .map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, identityId: row.identity_id!,
        name: row.name!, status: row.status as StoredProject["status"], summary: row.summary ?? "",
        createdAt: row.created_at!, updatedAt: row.updated_at! }));
  }

  /**
   * Stores a source document once per file content: the same syllabus dropped twice is one row. Returns
   * the row that now exists, which is the existing one on a repeat.
   */
  saveSourceDocument(doc: StoredSourceDocument): StoredSourceDocument {
    this.#db.transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM source_documents WHERE workspace_id = ? AND sha256 = ?").get(doc.workspaceId, doc.sha256)) return;
      this.#db.prepare(`
        INSERT INTO source_documents (id, owner_id, workspace_id, project_id, kind, file_name, media_type, sha256, uri,
          extracted_text, extraction_status, extraction_note, created_at, ref_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(doc.id, doc.ownerId, doc.workspaceId, doc.projectId ?? null, doc.kind, doc.fileName, doc.mediaType,
        doc.sha256, doc.uri, doc.extractedText, doc.extractionStatus, doc.extractionNote ?? null, doc.createdAt,
        this.#nextNumber(doc.workspaceId, "source_documents.ref_no", "SELECT MAX(ref_no) AS n FROM source_documents WHERE workspace_id = ?"));
      this.#indexDocument(doc.workspaceId, doc.id);
    }).immediate();
    return this.listSourceDocuments(doc.workspaceId).find((item) => item.sha256 === doc.sha256)!;
  }

  /**
   * The next number of a per-workspace sequence that never gives a number twice, even after the row that held it is deleted: a
   * high-water mark kept in `workspace_counters`, never below what the table itself holds (a restore or an older file has no mark).
   * Call inside a transaction.
   */
  #nextNumber(workspaceId: string, name: string, maxQuery: string): number {
    const kept = (this.#db.prepare("SELECT value FROM workspace_counters WHERE workspace_id = ? AND name = ?").get(workspaceId, name) as { value: number } | undefined)?.value ?? 0;
    const held = Number((this.#db.prepare(maxQuery).get(workspaceId) as { n: number | null } | undefined)?.n ?? 0);
    const next = Math.max(kept, held) + 1;
    this.#db.prepare(`INSERT INTO workspace_counters (workspace_id, name, value) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, name) DO UPDATE SET value = excluded.value`).run(workspaceId, name, next);
    return next;
  }

  listSourceDocuments(workspaceId: string, options: { projectId?: string } = {}): StoredSourceDocument[] {
    const rows = this.#db.prepare("SELECT * FROM source_documents WHERE workspace_id = ? ORDER BY created_at, rowid")
      .all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.filter((row) => !options.projectId || row.project_id === options.projectId).map((row) => ({
      id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      ...(typeof row.ref_no === "number" ? { refNo: row.ref_no } : {}),
      kind: row.kind as StoredSourceDocument["kind"], fileName: String(row.file_name), mediaType: String(row.media_type),
      sha256: String(row.sha256), uri: String(row.uri), extractedText: String(row.extracted_text ?? ""),
      extractionStatus: row.extraction_status as StoredSourceDocument["extractionStatus"],
      ...(row.extraction_note ? { extractionNote: String(row.extraction_note) } : {}), createdAt: String(row.created_at)
    }));
  }

  /** Text extraction runs after upload, in the worker, so it is recorded separately from the file itself. */
  setSourceDocumentExtraction(workspaceId: string, id: string,
    result: { status: StoredSourceDocument["extractionStatus"]; text?: string; note?: string }): void {
    this.#db.transaction(() => {
      this.#db.prepare(
        "UPDATE source_documents SET extraction_status = ?, extracted_text = ?, extraction_note = ? WHERE workspace_id = ? AND id = ?"
      ).run(result.status, result.text ?? "", result.note ?? null, workspaceId, id);
      this.#indexDocument(workspaceId, id);
    })();
  }

  /**
   * Removes one document row (an authorized folder's file the person excluded or took back). Returns its stored file and whether any
   * row in any workspace still points at it, so the caller deletes the copy only when nothing else reads it.
   */
  deleteSourceDocument(workspaceId: string, id: string): { uri: string; uriInUse: boolean } | undefined {
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT uri FROM source_documents WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { uri: string } | undefined;
      if (!row) return undefined;
      this.#db.prepare("DELETE FROM source_documents WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
      this.#db.prepare("DELETE FROM doc_chunks WHERE workspace_id = ? AND document_id = ?").run(workspaceId, id);
      // The file's words go with it; facts that cited them keep their quote but no longer point at its sentences.
      const gone = new Set((this.#db.prepare("SELECT id FROM evidence_sentences WHERE workspace_id = ? AND source_kind = 'document' AND source_id = ?")
        .all(workspaceId, id) as Array<{ id: number }>).map((sentence) => sentence.id));
      if (gone.size) {
        // Kept as blank, retired rows: the ids stay spent, so no later sentence takes a number an earlier turn showed for this file.
        this.#db.prepare("UPDATE evidence_sentences SET retired = 1, text = '' WHERE workspace_id = ? AND source_kind = 'document' AND source_id = ?").run(workspaceId, id);
        const facts = this.#db.prepare("SELECT identity_id, project_id, slot, source_sentences FROM profile_facts WHERE workspace_id = ? AND source_sentences <> '[]'")
          .all(workspaceId) as Array<{ identity_id: string; project_id: string; slot: string; source_sentences: string }>;
        for (const fact of facts) {
          const ids = sentenceIds(fact.source_sentences);
          if (ids.some((sentence) => gone.has(sentence))) this.setProfileFactSentences(workspaceId,
            { identityId: fact.identity_id, projectId: fact.project_id, slot: fact.slot }, ids.filter((sentence) => !gone.has(sentence)));
        }
      }
      return { uri: row.uri, uriInUse: Boolean(this.#db.prepare("SELECT 1 FROM source_documents WHERE uri = ? LIMIT 1").get(row.uri)) };
    })();
  }

  assignSourceDocumentProject(workspaceId: string, id: string, projectId: string | null): void {
    this.#db.transaction(() => {
      this.#db.prepare("UPDATE source_documents SET project_id = ? WHERE workspace_id = ? AND id = ?")
        .run(projectId, workspaceId, id);
      // The passages' heading names the project: filed elsewhere, they are found under the new one.
      this.#refreshHeadings(workspaceId, "document_id = ?", [id]);
    })();
  }

  /** The heading every passage of a document is indexed under: 「文件名 · 项目 · 线」 (「未归项目」 for a file filed under none). */
  #headingOf(workspaceId: string, documentId: string): string | undefined {
    const row = this.#db.prepare(`SELECT d.file_name AS file, p.name AS project, p.identity_id AS line FROM source_documents d
      LEFT JOIN workspace_projects p ON p.workspace_id = d.workspace_id AND p.id = d.project_id WHERE d.workspace_id = ? AND d.id = ?`)
      .get(workspaceId, documentId) as { file: string; project: string | null; line: string | null } | undefined;
    return row ? [row.file, row.project ?? "未归项目", row.line ?? ""].filter(Boolean).join(" · ") : undefined;
  }

  /** Cuts one document's text into passages and indexes them, replacing what it had (none when it has no readable text). */
  #indexDocument(workspaceId: string, documentId: string): void {
    this.#db.prepare("DELETE FROM doc_chunks WHERE workspace_id = ? AND document_id = ?").run(workspaceId, documentId);
    const row = this.#db.prepare("SELECT extracted_text AS text, extraction_status AS status FROM source_documents WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, documentId) as { text: string; status: string } | undefined;
    if (!row || row.status !== "done" || !row.text.trim()) return;
    const heading = this.#headingOf(workspaceId, documentId) ?? "";
    const insert = this.#db.prepare("INSERT INTO doc_chunks (workspace_id, document_id, ord, start_at, heading, body) VALUES (?, ?, ?, ?, ?, ?)");
    chunkText(row.text).forEach((chunk, ord) => insert.run(workspaceId, documentId, ord, chunk.start, heading, chunk.text));
  }

  /** Every document's passages again, for one workspace or all (migration 19 and a restore). */
  #indexDocuments(workspaceId?: string): void {
    const ids = this.#db.prepare(`SELECT workspace_id AS ws, id FROM source_documents ${workspaceId ? "WHERE workspace_id = ?" : ""}`)
      .all(...(workspaceId ? [workspaceId] : [])) as Array<{ ws: string; id: string }>;
    for (const { ws, id } of ids) this.#indexDocument(ws, id);
  }

  /** Rebuilds the passage index of one workspace from its documents. Returns how many passages it now holds. */
  reindexDocuments(workspaceId: string): number {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM doc_chunks WHERE workspace_id = ?").run(workspaceId);
      this.#indexDocuments(workspaceId);
    })();
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM doc_chunks WHERE workspace_id = ?").get(workspaceId) as { n: number }).n);
  }

  #refreshHeadings(workspaceId: string, where: string, params: unknown[]): void {
    const documents = this.#db.prepare(`SELECT DISTINCT document_id AS id FROM doc_chunks WHERE workspace_id = ? AND ${where}`)
      .all(workspaceId, ...params) as Array<{ id: string }>;
    const update = this.#db.prepare("UPDATE doc_chunks SET heading = ? WHERE workspace_id = ? AND document_id = ? AND heading <> ?");
    for (const { id } of documents) { const heading = this.#headingOf(workspaceId, id) ?? ""; update.run(heading, workspaceId, id, heading); }
  }

  #docChunk(row: Record<string, string | number | null>): DocChunk {
    return { id: Number(row.id), documentId: String(row.document_id), ord: Number(row.ord), start: Number(row.start_at), heading: String(row.heading),
      body: String(row.body), fileName: String(row.file_name ?? ""), ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      ...(row.identity_id ? { identityId: String(row.identity_id) } : {}) };
  }

  /**
   * The passages of this workspace's files that match a query, best first (docs/context-selection.md). Terms of three characters or more
   * go through the trigram index (bm25, the heading weighted double); two-character ones (「组会」, 「HW」) are matched by LIKE and add to
   * the score. A passage of `projectId` counts double and one of `identityId`'s line 1.4×; `within` keeps only those. Read-only.
   */
  searchDocChunks(workspaceId: string, query: string, options: { projectId?: string; identityId?: string; within?: "project" | "line" | "all";
    documentIds?: string[]; limit?: number } = {}): DocChunkHit[] {
    const terms = searchTerms(query);
    const scores = new Map<number, number>();
    if (terms.long.length) {
      try {
        const rows = this.#db.prepare(`SELECT c.id AS id, bm25(doc_chunks_fts, 2.0, 1.0) AS rank FROM doc_chunks_fts JOIN doc_chunks c ON c.id = doc_chunks_fts.rowid
          WHERE doc_chunks_fts MATCH ? AND c.workspace_id = ? ORDER BY rank LIMIT 400`).all(ftsMatchExpression(terms.long), workspaceId) as Array<{ id: number; rank: number }>;
        for (const row of rows) scores.set(row.id, -row.rank);
      } catch { /* an expression the index cannot read finds nothing, never fails the caller */ }
    }
    const top = Math.max(1, ...scores.values());
    // A two-character word alone is a weak signal (「输入」 is in every file about voice input): with longer terms in the query it only
    // lifts passages they already found; with none, it is all there is to search by.
    const longFound = new Set(scores.keys());
    const like = this.#db.prepare("SELECT id FROM doc_chunks WHERE workspace_id = ? AND (body LIKE ? ESCAPE '!' OR heading LIKE ? ESCAPE '!') LIMIT 800");
    for (const term of terms.short) {
      const pattern = `%${term.replace(/[!%_]/g, (char) => `!${char}`)}%`;
      for (const row of like.all(workspaceId, pattern, pattern) as Array<{ id: number }>)
        if (!terms.long.length || longFound.has(row.id)) scores.set(row.id, (scores.get(row.id) ?? 0) + top * 0.3);
    }
    if (!scores.size) return [];
    const ids = [...scores.keys()];
    const rows: Array<Record<string, string | number | null>> = [];
    for (let at = 0; at < ids.length; at += 500) {
      const slice = ids.slice(at, at + 500);
      rows.push(...this.#db.prepare(`SELECT c.*, d.file_name, d.project_id, p.identity_id FROM doc_chunks c
        JOIN source_documents d ON d.workspace_id = c.workspace_id AND d.id = c.document_id
        LEFT JOIN workspace_projects p ON p.workspace_id = d.workspace_id AND p.id = d.project_id
        WHERE c.workspace_id = ? AND c.id IN (${slice.map(() => "?").join(", ")})`).all(workspaceId, ...slice) as Array<Record<string, string | number | null>>);
    }
    const allowed = options.documentIds ? new Set(options.documentIds) : undefined;
    const ownProject = (chunk: DocChunk) => Boolean(options.projectId) && chunk.projectId === options.projectId;
    const ownLine = (chunk: DocChunk) => Boolean(options.identityId) && chunk.identityId === options.identityId;
    return rows.map((row) => this.#docChunk(row))
      .filter((chunk) => !allowed || allowed.has(chunk.documentId))
      .filter((chunk) => options.within === "project" ? ownProject(chunk) : options.within === "line" ? ownProject(chunk) || ownLine(chunk) : true)
      .map((chunk) => ({ ...chunk, score: scores.get(chunk.id)! * (ownProject(chunk) ? 2 : ownLine(chunk) ? 1.4 : 1) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, options.limit ?? 40);
  }

  /** One passage by id, only within this workspace, with the ids of the passages before and after it in its file. */
  readDocChunk(workspaceId: string, id: number): (DocChunk & { previousId?: number; nextId?: number; total: number }) | undefined {
    const row = this.#db.prepare(`SELECT c.*, d.file_name, d.project_id, p.identity_id FROM doc_chunks c
      JOIN source_documents d ON d.workspace_id = c.workspace_id AND d.id = c.document_id
      LEFT JOIN workspace_projects p ON p.workspace_id = d.workspace_id AND p.id = d.project_id
      WHERE c.workspace_id = ? AND c.id = ?`).get(workspaceId, id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    const chunk = this.#docChunk(row);
    const near = (ord: number) => (this.#db.prepare("SELECT id FROM doc_chunks WHERE workspace_id = ? AND document_id = ? AND ord = ?")
      .get(workspaceId, chunk.documentId, ord) as { id: number } | undefined)?.id;
    const previousId = near(chunk.ord - 1), nextId = near(chunk.ord + 1);
    const total = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM doc_chunks WHERE workspace_id = ? AND document_id = ?")
      .get(workspaceId, chunk.documentId) as { n: number }).n);
    return { ...chunk, total, ...(previousId !== undefined ? { previousId } : {}), ...(nextId !== undefined ? { nextId } : {}) };
  }

  /** How many passages each of the workspace's documents is cut into (a document with no readable text is absent). */
  docChunkCounts(workspaceId: string): Map<string, number> {
    return new Map((this.#db.prepare("SELECT document_id AS id, COUNT(*) AS n FROM doc_chunks WHERE workspace_id = ? GROUP BY document_id")
      .all(workspaceId) as Array<{ id: string; n: number }>).map((row) => [row.id, Number(row.n)]));
  }

  /** A document's first passages in order (the opening of a file of the task that no search term reached). */
  documentChunks(workspaceId: string, documentId: string, limit = 3): DocChunk[] {
    return (this.#db.prepare(`SELECT c.*, d.file_name, d.project_id, p.identity_id FROM doc_chunks c
      JOIN source_documents d ON d.workspace_id = c.workspace_id AND d.id = c.document_id
      LEFT JOIN workspace_projects p ON p.workspace_id = d.workspace_id AND p.id = d.project_id
      WHERE c.workspace_id = ? AND c.document_id = ? ORDER BY c.ord LIMIT ?`).all(workspaceId, documentId, limit) as Array<Record<string, string | number | null>>)
      .map((row) => this.#docChunk(row));
  }

  saveOnboardingSession(session: StoredOnboardingSession): void {
    this.#db.prepare(`
      INSERT INTO onboarding_sessions (id, owner_id, workspace_id, codex_thread_id, state, coverage_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET codex_thread_id = excluded.codex_thread_id, state = excluded.state,
        coverage_json = excluded.coverage_json, updated_at = excluded.updated_at
    `).run(session.id, session.ownerId, session.workspaceId, session.codexThreadId ?? null, session.state,
      JSON.stringify(session.coverage), session.createdAt, session.updatedAt);
  }

  #onboardingSessionFrom(row: Record<string, string>): StoredOnboardingSession {
    return { id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      ...(row.codex_thread_id ? { codexThreadId: row.codex_thread_id } : {}),
      state: row.state as StoredOnboardingSession["state"], coverage: JSON.parse(row.coverage_json ?? "{}"),
      createdAt: row.created_at!, updatedAt: row.updated_at! };
  }

  /** The workspace's current onboarding conversation: the most recently touched one. A line's own interview (`line-<id>`) is not it. */
  getLatestOnboardingSession(workspaceId: string): StoredOnboardingSession | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM onboarding_sessions WHERE workspace_id = ? AND id NOT LIKE 'line-%' ORDER BY updated_at DESC, rowid DESC LIMIT 1"
    ).get(workspaceId) as Record<string, string> | undefined;
    return row ? this.#onboardingSessionFrom(row) : undefined;
  }

  /**
   * Records a question in the ledger (`question_ledger`) once per `key` and returns its number. A question asked again keeps its number;
   * an answered or assumed one never goes back to open or pending (re-asking what was answered is the duplicate the ledger exists to
   * catch), and a dropped one opens again when it is asked again.
   */
  recordQuestion(workspaceId: string, question: { kind: LedgerQuestion["kind"]; key: string; text: string; options?: string[]; identityId?: string;
    projectId?: string; status: "pending" | "open" | "dropped"; repeats?: number; at: string }): number {
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT id, status FROM question_ledger WHERE workspace_id = ? AND key = ?").get(workspaceId, question.key) as
        { id: number; status: LedgerQuestion["status"] } | undefined;
      if (row) {
        const settled = row.status === "answered" || row.status === "assumed";
        const status = settled ? row.status : row.status === "open" && question.status === "pending" ? "open" : question.status;
        this.#db.prepare(`UPDATE question_ledger SET text = ?, options_json = ?, identity_id = ?, project_id = ?, status = ?, repeats = COALESCE(?, repeats),
          updated_at = ? WHERE workspace_id = ? AND id = ?`).run(question.text, JSON.stringify(question.options ?? []), question.identityId ?? "",
          question.projectId ?? "", status, question.repeats ?? null, question.at, workspaceId, row.id);
        return row.id;
      }
      const id = Number((this.#db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM question_ledger WHERE workspace_id = ?").get(workspaceId) as { id: number }).id);
      this.#db.prepare(`INSERT INTO question_ledger (workspace_id, id, kind, key, text, options_json, identity_id, project_id, status, repeats, asked_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, id, question.kind, question.key, question.text, JSON.stringify(question.options ?? []),
        question.identityId ?? "", question.projectId ?? "", question.status, question.repeats ?? null, question.at, question.at);
      return id;
    }).immediate();
  }

  /** The person's answer to a numbered question (or the assumption that stands in for one), with the sentences it was given in. */
  answerQuestion(workspaceId: string, id: number, answer: { text: string; sentences?: number[]; status?: "answered" | "assumed"; at: string }): void {
    this.#db.prepare(`UPDATE question_ledger SET status = ?, answer = ?, answer_sentences = ?, answered_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(answer.status ?? "answered", answer.text, JSON.stringify(answer.sentences ?? []), answer.at, answer.at, workspaceId, id);
  }

  /** Takes an unanswered question out of what is asked (its cause went away, or it repeated an answered one). Answers are never undone. */
  dropQuestion(workspaceId: string, id: number, at: string): void {
    this.#db.prepare("UPDATE question_ledger SET status = 'dropped', updated_at = ? WHERE workspace_id = ? AND id = ? AND status IN ('pending','open')")
      .run(at, workspaceId, id);
  }

  listQuestions(workspaceId: string, options: { kind?: LedgerQuestion["kind"]; statuses?: LedgerQuestion["status"][]; keyPrefix?: string } = {}): LedgerQuestion[] {
    const rows = this.#db.prepare("SELECT * FROM question_ledger WHERE workspace_id = ? ORDER BY id").all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.map(questionRow).filter((question) => (!options.kind || question.kind === options.kind)
      && (!options.statuses || options.statuses.includes(question.status)) && (!options.keyPrefix || question.key.startsWith(options.keyPrefix)));
  }

  questionByKey(workspaceId: string, key: string): LedgerQuestion | undefined {
    const row = this.#db.prepare("SELECT * FROM question_ledger WHERE workspace_id = ? AND key = ?").get(workspaceId, key) as Record<string, string | number | null> | undefined;
    return row ? questionRow(row) : undefined;
  }

  /**
   * Runs several writes as one transaction: all of them land or none does. The interview's extraction writes facts, projects, dates and the
   * portrait from one answer, and a throw half-way used to leave half of it written and the run to be repeated over it.
   */
  atomically<T>(work: () => T): T {
    return this.#db.transaction(work).immediate();
  }

  /** Every interview conversation of the workspace, the line interviews included. */
  listOnboardingSessions(workspaceId: string): StoredOnboardingSession[] {
    return (this.#db.prepare("SELECT * FROM onboarding_sessions WHERE workspace_id = ? ORDER BY created_at, rowid").all(workspaceId) as Array<Record<string, string>>)
      .map((row) => this.#onboardingSessionFrom(row));
  }

  getOnboardingSession(workspaceId: string, id: string): StoredOnboardingSession | undefined {
    const row = this.#db.prepare("SELECT * FROM onboarding_sessions WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as Record<string, string> | undefined;
    return row ? this.#onboardingSessionFrom(row) : undefined;
  }

  /** Appends at the next sequence number, atomically, and returns it. */
  appendOnboardingMessage(message: Omit<StoredOnboardingMessage, "seq">): number {
    return this.#db.transaction(() => {
      const next = (this.#db.prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM onboarding_messages WHERE workspace_id = ? AND session_id = ?"
      ).get(message.workspaceId, message.sessionId) as { n: number }).n;
      this.#db.prepare(
        "INSERT INTO onboarding_messages (session_id, workspace_id, seq, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(message.sessionId, message.workspaceId, next, message.role, JSON.stringify(message.content), message.createdAt);
      return next;
    })();
  }

  listOnboardingMessages(workspaceId: string, sessionId: string): StoredOnboardingMessage[] {
    const rows = this.#db.prepare(
      "SELECT * FROM onboarding_messages WHERE workspace_id = ? AND session_id = ? ORDER BY seq"
    ).all(workspaceId, sessionId) as Array<Record<string, string | number>>;
    return rows.map((row) => ({ sessionId: String(row.session_id), workspaceId: String(row.workspace_id),
      seq: Number(row.seq), role: row.role as StoredOnboardingMessage["role"],
      content: JSON.parse(String(row.content_json)), createdAt: String(row.created_at) }));
  }

  /**
   * One value per (identity, project, slot), last write wins. A fact the person confirmed is never
   * downgraded back to `inferred` by a later guess: confirming is a human act and inferring is not.
   */
  upsertProfileFact(fact: StoredProfileFact): void {
    this.#db.prepare(`
      INSERT INTO profile_facts (workspace_id, identity_id, project_id, slot, value, status, source_ref, source_quote, source_sentences, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, identity_id, project_id, slot) DO UPDATE SET
        value = CASE WHEN profile_facts.status = 'confirmed' AND excluded.status = 'inferred'
          THEN profile_facts.value ELSE excluded.value END,
        status = CASE WHEN profile_facts.status = 'confirmed' THEN 'confirmed' ELSE excluded.status END,
        source_ref = CASE WHEN profile_facts.status = 'confirmed' AND excluded.status = 'inferred'
          THEN profile_facts.source_ref ELSE excluded.source_ref END,
        source_quote = CASE WHEN profile_facts.status = 'confirmed' AND excluded.status = 'inferred'
          THEN profile_facts.source_quote ELSE excluded.source_quote END,
        source_sentences = CASE WHEN profile_facts.status = 'confirmed' AND excluded.status = 'inferred'
          THEN profile_facts.source_sentences ELSE excluded.source_sentences END,
        updated_at = excluded.updated_at
    `).run(fact.workspaceId, fact.identityId, fact.projectId, fact.slot, fact.value, fact.status,
      fact.sourceRef, fact.sourceQuote, JSON.stringify(fact.sourceSentences ?? []), fact.updatedAt);
  }

  /** Gives a fact its sentences without touching anything else (facts written before numbered evidence). */
  setProfileFactSentences(workspaceId: string, key: { identityId: string; projectId: string; slot: string }, ids: number[]): void {
    this.#db.prepare("UPDATE profile_facts SET source_sentences = ? WHERE workspace_id = ? AND identity_id = ? AND project_id = ? AND slot = ?")
      .run(JSON.stringify(ids), workspaceId, key.identityId, key.projectId, key.slot);
  }

  /**
   * The numbered sentences of one reply or file, cut on first use and kept: ids are per workspace, given once, and never move, so a
   * citation stored today means the same words next year. When the source's text changed (a file read again), its old sentences are
   * retired, never renumbered or deleted, and the new text gets new ids.
   */
  ensureEvidence(workspaceId: string, sourceKind: StoredSentence["sourceKind"], sourceId: string, text: string): StoredSentence[] {
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 32);
    return this.#db.transaction(() => {
      const current = this.#db.prepare("SELECT source_hash FROM evidence_sentences WHERE workspace_id = ? AND source_kind = ? AND source_id = ? AND retired = 0 LIMIT 1")
        .get(workspaceId, sourceKind, sourceId) as { source_hash: string } | undefined;
      if (current?.source_hash === hash) return this.sentencesOf(workspaceId, sourceKind, sourceId);
      if (current) this.#db.prepare("UPDATE evidence_sentences SET retired = 1 WHERE workspace_id = ? AND source_kind = ? AND source_id = ?")
        .run(workspaceId, sourceKind, sourceId);
      const segments = segmentText(text);
      // Reserve the whole run of ids at once: never one a removed file's sentence held.
      const first = this.#nextNumber(workspaceId, "evidence_sentences.id", "SELECT MAX(id) AS n FROM evidence_sentences WHERE workspace_id = ?");
      if (segments.length > 1) this.#db.prepare("UPDATE workspace_counters SET value = ? WHERE workspace_id = ? AND name = ?")
        .run(first + segments.length - 1, workspaceId, "evidence_sentences.id");
      const next = first;
      const insert = this.#db.prepare(`INSERT INTO evidence_sentences (workspace_id, id, source_kind, source_id, source_hash, ord, start_at, end_at, text, segmenter, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const at = new Date().toISOString();
      segments.forEach((segment, ord) => insert.run(workspaceId, next + ord, sourceKind, sourceId, hash, ord, segment.start, segment.end,
        segment.text, SEGMENTER_VERSION, at));
      return this.sentencesOf(workspaceId, sourceKind, sourceId);
    }).immediate();
  }

  /** The current (not retired) sentences of one source, in order. */
  sentencesOf(workspaceId: string, sourceKind: StoredSentence["sourceKind"], sourceId: string): StoredSentence[] {
    return (this.#db.prepare("SELECT * FROM evidence_sentences WHERE workspace_id = ? AND source_kind = ? AND source_id = ? AND retired = 0 ORDER BY ord")
      .all(workspaceId, sourceKind, sourceId) as Array<Record<string, string | number>>).map(sentenceRow);
  }

  /** Sentences by id, retired ones included (a stored citation still reads the words it was made on). */
  sentencesById(workspaceId: string, ids: number[]): StoredSentence[] {
    if (!ids.length) return [];
    return (this.#db.prepare(`SELECT * FROM evidence_sentences WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .all(workspaceId, ...ids) as Array<Record<string, string | number>>).map(sentenceRow);
  }

  listProfileFacts(workspaceId: string, options: { identityId?: string; projectId?: string } = {}): StoredProfileFact[] {
    const rows = this.#db.prepare(
      "SELECT * FROM profile_facts WHERE workspace_id = ? ORDER BY identity_id, project_id, slot"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.filter((row) => (!options.identityId || row.identity_id === options.identityId)
      && (options.projectId === undefined || row.project_id === options.projectId))
      .map((row) => ({ workspaceId: row.workspace_id!, identityId: row.identity_id!, projectId: row.project_id ?? "",
        slot: row.slot!, value: row.value!, status: row.status as StoredProfileFact["status"],
        sourceRef: row.source_ref!, sourceQuote: row.source_quote ?? "", updatedAt: row.updated_at!,
        ...(sentenceIds(row.source_sentences).length ? { sourceSentences: sentenceIds(row.source_sentences) } : {}),
        ...(Number(row.use_count ?? 0) > 0 ? { useCount: Number(row.use_count) } : {}), ...(row.last_used_at ? { lastUsedAt: String(row.last_used_at) } : {}) }));
  }

  /** The person rejecting a fact the interview inferred (or correcting one it got wrong). */
  deleteProfileFact(workspaceId: string, identityId: string, projectId: string, slot: string): boolean {
    return this.#db.prepare(
      "DELETE FROM profile_facts WHERE workspace_id = ? AND identity_id = ? AND project_id = ? AND slot = ?"
    ).run(workspaceId, identityId, projectId, slot).changes > 0;
  }

  /**
   * Adds one reading to the screen-activity record: it extends the last segment when it is the same window (and not
   * long after it), and starts a new one otherwise. `intervalSeconds` is how much time one reading stands for.
   */
  recordActivityReading(input: { workspaceId: string; at: string; intervalSeconds: number; app: string; title: string; category: string; idle: boolean }): void {
    const end = new Date(Date.parse(input.at) + input.intervalSeconds * 1000).toISOString();
    const last = this.#db.prepare("SELECT id, end_at, app, title, category, idle FROM activity_segments WHERE workspace_id = ? ORDER BY id DESC LIMIT 1")
      .get(input.workspaceId) as { id: number; end_at: string; app: string; title: string; category: string; idle: number } | undefined;
    const sameWindow = last && last.app === input.app && last.title === input.title && last.category === input.category && Boolean(last.idle) === input.idle;
    // A reading that arrives more than two intervals after the last one is a gap (asleep, worker off), not a continuation.
    const close = last && Date.parse(input.at) - Date.parse(last.end_at) <= input.intervalSeconds * 2000;
    if (sameWindow && close && Date.parse(end) > Date.parse(last.end_at)) {
      this.#db.prepare("UPDATE activity_segments SET end_at = ? WHERE id = ?").run(end, last.id);
      return;
    }
    this.#db.prepare("INSERT INTO activity_segments (workspace_id, start_at, end_at, app, title, category, idle) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.workspaceId, input.at, end, input.app, input.title, input.category, input.idle ? 1 : 0);
  }

  /**
   * A linked device's segments (docs/device-mode.md): everything from `sinceIso` on is replaced by what the device sent. They arrive with
   * no title at all — the column is written empty here, whatever the caller has — and `app` is the device's opaque token, not a name.
   */
  replaceDeviceActivitySegments(workspaceId: string, sinceIso: string, segments: Array<{ start: string; end: string; app: string; category: string; idle: boolean }>): number {
    return this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM activity_segments WHERE workspace_id = ? AND start_at >= ?").run(workspaceId, sinceIso);
      const insert = this.#db.prepare("INSERT INTO activity_segments (workspace_id, start_at, end_at, app, title, category, idle) VALUES (?, ?, ?, ?, '', ?, ?)");
      let written = 0;
      for (const segment of segments) if (segment.start >= sinceIso) { insert.run(workspaceId, segment.start, segment.end, segment.app, segment.category, segment.idle ? 1 : 0); written += 1; }
      return written;
    }).immediate();
  }

  /** Every segment of a workspace goes (a device's detail consent turned off). */
  deleteActivitySegments(workspaceId: string): number {
    return Number(this.#db.prepare("DELETE FROM activity_segments WHERE workspace_id = ?").run(workspaceId).changes);
  }

  /** Segments that ended after `sinceIso`, without their titles. */
  listActivitySegments(workspaceId: string, sinceIso: string): StoredActivitySegment[] {
    const rows = this.#db.prepare("SELECT start_at, end_at, app, category, idle FROM activity_segments WHERE workspace_id = ? AND end_at >= ? ORDER BY start_at")
      .all(workspaceId, sinceIso) as Array<{ start_at: string; end_at: string; app: string; category: string; idle: number }>;
    return rows.map((row) => ({ workspaceId, start: row.start_at, end: row.end_at, app: row.app, category: row.category, idle: Boolean(row.idle) }));
  }

  /** The newest entries with their titles, for the one screen that shows the person what is kept. */
  recentActivityEntries(workspaceId: string, limit: number): RecentActivityEntry[] {
    const rows = this.#db.prepare("SELECT start_at, end_at, app, title, category, idle FROM activity_segments WHERE workspace_id = ? ORDER BY id DESC LIMIT ?")
      .all(workspaceId, limit) as Array<{ start_at: string; end_at: string; app: string; title: string; category: string; idle: number }>;
    return rows.map((row) => ({ workspaceId, start: row.start_at, end: row.end_at, app: row.app, title: row.title, category: row.category, idle: Boolean(row.idle) }));
  }

  /**
   * Retention: titles older than `titlesBefore` are blanked (the minutes, app and category stay), and rows older than
   * `rowsBefore` are deleted. Returns how many titles were blanked and rows deleted.
   */
  pruneActivity(workspaceId: string, titlesBefore: string, rowsBefore: string): { blanked: number; deleted: number } {
    const blanked = this.#db.prepare("UPDATE activity_segments SET title = '' WHERE workspace_id = ? AND end_at < ? AND title <> ''").run(workspaceId, titlesBefore).changes;
    const deleted = this.#db.prepare("DELETE FROM activity_segments WHERE workspace_id = ? AND end_at < ?").run(workspaceId, rowsBefore).changes;
    return { blanked: Number(blanked), deleted: Number(deleted) };
  }

  /** Blanks every stored title, whatever its age. */
  clearActivityTitles(workspaceId: string): number {
    return Number(this.#db.prepare("UPDATE activity_segments SET title = '' WHERE workspace_id = ? AND title <> ''").run(workspaceId).changes);
  }

  saveModelUsage(usage: StoredModelUsage): void {
    this.#db.prepare(`
      INSERT INTO model_usage (workspace_id, skill, tier, model, effort, spend_mode, thread_id, ok, error_code, repairs, turns,
        input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, duration_ms, at, purpose)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(usage.workspaceId, usage.skill, usage.tier, usage.model, usage.effort, usage.spendMode, usage.threadId, usage.ok ? 1 : 0,
      usage.errorCode, usage.repairs, usage.turns, usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningTokens,
      usage.totalTokens, usage.durationMs, usage.at, usage.purpose ?? "");
  }

  /**
   * Token sums since `sinceIso` per purpose and model: what the weighted cost of a span is computed from (weights and prices are linear,
   * so sums are enough; `runCost` in core applies them). The quota saver reads the person's week with it.
   */
  modelUsageByPurpose(workspaceId: string, sinceIso: string): Array<{ purpose: string; model: string; runs: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }> {
    return (this.#db.prepare(`
      SELECT purpose, model, COUNT(*) AS runs, SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens, SUM(output_tokens) AS output_tokens
      FROM model_usage WHERE workspace_id = ? AND at >= ? GROUP BY purpose, model
    `).all(workspaceId, sinceIso) as Array<Record<string, string | number>>).map((row) => ({ purpose: String(row.purpose), model: String(row.model),
      runs: Number(row.runs), inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens) }));
  }

  /** Per Skill and model since `sinceIso`, biggest spender first. */
  /**
   * Records one thing learned about how the person works. `refId` makes a repeated signal (the same task's estimate changed twice)
   * replace its earlier entry instead of piling up.
   */
  addPreference(entry: Omit<StoredPreference, "id" | "createdAt" | "deletedAt"> & { createdAt?: string }): StoredPreference {
    const createdAt = entry.createdAt ?? new Date().toISOString();
    const existing = entry.refId ? this.#db.prepare("SELECT id FROM preference_entries WHERE workspace_id = ? AND source = ? AND ref_id = ? AND deleted_at IS NULL")
      .get(entry.workspaceId, entry.source, entry.refId) as { id: string } | undefined : undefined;
    const id = existing?.id ?? `pref-${randomUUID()}`;
    // A signal given again is live again, whatever lapsed before.
    this.#db.prepare(`INSERT INTO preference_entries (workspace_id, id, source, scope, text, weight, ref_id, created_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(workspace_id, id) DO UPDATE SET scope = excluded.scope, text = excluded.text,
      weight = excluded.weight, created_at = excluded.created_at, invalidated_at = NULL`)
      .run(entry.workspaceId, id, entry.source, entry.scope, entry.text.slice(0, 500), entry.weight, entry.refId, createdAt);
    return { ...entry, id, createdAt, deletedAt: null };
  }

  /**
   * The live preferences a model is given: those for one of `scopes` or for everything, at most `limit` — what the person stated (or kept)
   * first, then the most used, the most recently used, the weightiest, the newest (decided 2026-10-21). Every analysis, step plan and
   * milestone design reads them through here; a lapsed one is left out.
   */
  preferenceEntries(workspaceId: string, scopes: string[], limit = 20): StoredPreference[] {
    const wanted = new Set([...scopes, "all"]);
    const stated = (entry: StoredPreference) => Number(Boolean(entry.confirmedAt) || STATED_PREFERENCE_SOURCES.has(entry.source));
    return this.listPreferences(workspaceId).filter((entry) => wanted.has(entry.scope) || scopes.some((scope) => entry.scope.startsWith(`${scope}:`)))
      .sort((a, b) => stated(b) - stated(a) || (b.useCount ?? 0) - (a.useCount ?? 0) || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "")
        || b.weight - a.weight || b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /** `preferenceEntries` as the lines a model is given. */
  preferenceLines(workspaceId: string, scopes: string[], limit = 20): string[] {
    return this.preferenceEntries(workspaceId, scopes, limit).map((entry) => entry.text);
  }

  /** `includeInvalidated`: lapsed entries too (Settings lists them to restore). */
  listPreferences(workspaceId: string, options: { includeDeleted?: boolean; includeInvalidated?: boolean } = {}): StoredPreference[] {
    const rows = this.#db.prepare(`SELECT * FROM preference_entries WHERE workspace_id = ?${options.includeDeleted ? "" : " AND deleted_at IS NULL"}${
      options.includeInvalidated ? "" : " AND invalidated_at IS NULL"} ORDER BY created_at DESC`)
      .all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({ workspaceId, id: String(row.id), source: String(row.source) as StoredPreference["source"], scope: String(row.scope),
      text: String(row.text), weight: Number(row.weight), refId: String(row.ref_id ?? ""), createdAt: String(row.created_at),
      deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
      ...(Number(row.use_count ?? 0) > 0 ? { useCount: Number(row.use_count) } : {}), ...(row.last_used_at ? { lastUsedAt: String(row.last_used_at) } : {}),
      ...(row.invalidated_at ? { invalidatedAt: String(row.invalidated_at) } : {}), ...(row.confirmed_at ? { confirmedAt: String(row.confirmed_at) } : {}) }));
  }

  /** The person keeping a lapsed preference: live again and confirmed, so it never lapses again. */
  restorePreference(workspaceId: string, id: string, at = new Date().toISOString()): boolean {
    return this.#db.prepare(`UPDATE preference_entries SET invalidated_at = NULL, confirmed_at = ? WHERE workspace_id = ? AND id = ?
      AND deleted_at IS NULL AND invalidated_at IS NOT NULL`).run(at, workspaceId, id).changes > 0;
  }

  /**
   * Keeps one lesson. A rule offers the same `source` + `sourceRef` every day it runs, so a lesson is written once — a lapsed one is not
   * written again; `inserted` says whether this call added it.
   */
  saveLesson(input: Omit<StoredLesson, "id" | "useCount" | "lastUsedAt" | "invalidatedAt" | "createdAt"> & { createdAt?: string }): { inserted: boolean; id: string } {
    const id = `lesson-${randomUUID()}`;
    const inserted = this.#db.prepare(`INSERT OR IGNORE INTO run_lessons (workspace_id, id, line_id, archetype_id, kind, text, source, source_ref, keywords, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.workspaceId, id, input.lineId || null, input.archetypeId || null, input.kind,
      input.text.trim().slice(0, 300), input.source, input.sourceRef, input.keywords.slice(0, 300), input.createdAt ?? new Date().toISOString()).changes > 0;
    if (inserted) return { inserted, id };
    const row = this.#db.prepare("SELECT id FROM run_lessons WHERE workspace_id = ? AND source = ? AND source_ref = ?")
      .get(input.workspaceId, input.source, input.sourceRef) as { id: string };
    return { inserted, id: row.id };
  }

  listLessons(workspaceId: string, options: { includeInvalidated?: boolean } = {}): StoredLesson[] {
    const rows = this.#db.prepare(`SELECT * FROM run_lessons WHERE workspace_id = ?${options.includeInvalidated ? "" : " AND invalidated_at IS NULL"} ORDER BY created_at, rowid`)
      .all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({ workspaceId, id: String(row.id), lineId: row.line_id === null ? null : String(row.line_id),
      archetypeId: row.archetype_id === null ? null : String(row.archetype_id), kind: String(row.kind) as StoredLesson["kind"], text: String(row.text),
      source: String(row.source), sourceRef: String(row.source_ref), keywords: String(row.keywords), createdAt: String(row.created_at),
      useCount: Number(row.use_count), lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      invalidatedAt: row.invalidated_at === null ? null : String(row.invalidated_at) }));
  }

  /** What an answer that took effect cited (`usedRefs`): each counted once more, used now. Returns how many rows moved. */
  markUsed(workspaceId: string, refs: UsedRef[], at = new Date().toISOString()): number {
    const fact = this.#db.prepare("UPDATE profile_facts SET use_count = use_count + 1, last_used_at = ? WHERE workspace_id = ? AND identity_id = ? AND project_id = ? AND slot = ?");
    const pref = this.#db.prepare("UPDATE preference_entries SET use_count = use_count + 1, last_used_at = ? WHERE workspace_id = ? AND id = ?");
    const lesson = this.#db.prepare("UPDATE run_lessons SET use_count = use_count + 1, last_used_at = ? WHERE workspace_id = ? AND id = ?");
    return this.#db.transaction(() => refs.reduce((sum, ref) => sum + (ref.kind === "fact" ? fact.run(at, workspaceId, ref.identityId, ref.projectId, ref.slot)
      : ref.kind === "pref" ? pref.run(at, workspaceId, ref.id) : lesson.run(at, workspaceId, ref.id)).changes, 0))();
  }

  /**
   * What lapses unused (decided 2026-10-21; no model call): a preference read off an edit (estimate, importance, postponing) not cited for
   * 30 days, unless the person kept it; a lesson not cited for 60. Neither is deleted: Settings lists a lapsed preference to restore.
   */
  expireUnused(workspaceId: string, now = new Date()): { preferences: number; lessons: number } {
    const at = now.toISOString();
    const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const sources = [...LAPSING_PREFERENCE_SOURCES];
    const preferences = this.#db.prepare(`UPDATE preference_entries SET invalidated_at = ? WHERE workspace_id = ? AND deleted_at IS NULL
      AND invalidated_at IS NULL AND confirmed_at IS NULL AND source IN (${sources.map(() => "?").join(", ")}) AND COALESCE(last_used_at, created_at) < ?`)
      .run(at, workspaceId, ...sources, before(PREFERENCE_LAPSE_DAYS)).changes;
    const lessons = this.#db.prepare("UPDATE run_lessons SET invalidated_at = ? WHERE workspace_id = ? AND invalidated_at IS NULL AND COALESCE(last_used_at, created_at) < ?")
      .run(at, workspaceId, before(LESSON_LAPSE_DAYS)).changes;
    return { preferences, lessons };
  }

  saveLearnedArchetype(workspaceId: string, archetype: { id: string; label: string } & Record<string, unknown>, basis: unknown, at = new Date().toISOString()): void {
    this.#db.prepare(`INSERT INTO learned_archetypes (workspace_id, id, label, archetype_json, basis_json, created_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace_id, id) DO UPDATE SET label = excluded.label, archetype_json = excluded.archetype_json, basis_json = excluded.basis_json, retired_at = NULL`)
      .run(workspaceId, archetype.id, archetype.label, JSON.stringify(archetype), JSON.stringify(basis ?? {}), at);
  }

  listLearnedArchetypes(workspaceId: string, options: { includeRetired?: boolean } = {}): Array<{ id: string; label: string; archetype: unknown; basis: unknown; createdAt: string; retiredAt: string | null }> {
    const rows = this.#db.prepare(`SELECT * FROM learned_archetypes WHERE workspace_id = ?${options.includeRetired ? "" : " AND retired_at IS NULL"} ORDER BY created_at`)
      .all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({ id: String(row.id), label: String(row.label), archetype: JSON.parse(String(row.archetype_json)),
      basis: JSON.parse(String(row.basis_json ?? "{}")), createdAt: String(row.created_at), retiredAt: row.retired_at ?? null }));
  }

  retireLearnedArchetype(workspaceId: string, id: string, at = new Date().toISOString()): boolean {
    return this.#db.prepare("UPDATE learned_archetypes SET retired_at = ? WHERE workspace_id = ? AND id = ? AND retired_at IS NULL").run(at, workspaceId, id).changes > 0;
  }

  /** The person removing something the system learned: it stops reaching any model, and stays on record as removed. */
  deletePreference(workspaceId: string, id: string, at = new Date().toISOString()): boolean {
    return this.#db.prepare("UPDATE preference_entries SET deleted_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL").run(at, workspaceId, id).changes > 0;
  }

  /** Tokens and runs per UTC day since `sinceIso`, oldest first: the settings page's seven-day trend. */
  dailyModelUsage(workspaceId: string, sinceIso: string): Array<{ day: string; runs: number; totalTokens: number }> {
    const rows = this.#db.prepare(`
      SELECT substr(at, 1, 10) AS day, COUNT(*) AS runs, SUM(total_tokens) AS total_tokens
      FROM model_usage WHERE workspace_id = ? AND at >= ? GROUP BY day ORDER BY day
    `).all(workspaceId, sinceIso) as Array<{ day: string; runs: number; total_tokens: number }>;
    return rows.map((row) => ({ day: row.day, runs: Number(row.runs), totalTokens: Number(row.total_tokens) }));
  }

  /** Runs that ended in failure since `sinceIso`, per Skill and code (a lesson's rule reads repeats). */
  failedModelRuns(workspaceId: string, sinceIso: string): Array<{ skill: string; errorCode: string; runs: number; lastAt: string }> {
    return (this.#db.prepare(`SELECT skill, error_code, COUNT(*) AS runs, MAX(at) AS last_at FROM model_usage WHERE workspace_id = ? AND at >= ? AND ok = 0
      AND error_code <> '' GROUP BY skill, error_code ORDER BY runs DESC`).all(workspaceId, sinceIso) as Array<{ skill: string; error_code: string; runs: number; last_at: string }>)
      .map((row) => ({ skill: row.skill, errorCode: row.error_code, runs: Number(row.runs), lastAt: row.last_at }));
  }

  /** The workspace each Codex thread ran for, from `model_usage` (importing Codex's memories into the right account). */
  threadWorkspaces(threadIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const query = this.#db.prepare("SELECT workspace_id FROM model_usage WHERE thread_id = ? GROUP BY workspace_id");
    for (const threadId of new Set(threadIds)) {
      const rows = query.all(threadId) as Array<{ workspace_id: string }>;
      // A thread seen under two workspaces cannot be placed; it is skipped rather than given to either.
      if (rows.length === 1) out.set(threadId, rows[0]!.workspace_id);
    }
    return out;
  }

  /** Finished work whose observed minutes passed `ratio` × the analysis's cautious (p85) estimate. */
  durationOverruns(workspaceId: string, ratio: number): Array<{ workOrderId: string; observedMinutes: number; p85Minutes: number; observedAt: string }> {
    return (this.#db.prepare(`SELECT work_order_id, observed_minutes, COALESCE(llm_p85_minutes, baseline_p85_minutes) AS p85, observed_at FROM duration_observations
      WHERE workspace_id = ? AND censored = 0 AND COALESCE(llm_p85_minutes, baseline_p85_minutes) > 0
        AND observed_minutes > ? * COALESCE(llm_p85_minutes, baseline_p85_minutes)`).all(workspaceId, ratio) as Array<Record<string, string | number>>)
      .map((row) => ({ workOrderId: String(row.work_order_id), observedMinutes: Number(row.observed_minutes), p85Minutes: Number(row.p85), observedAt: String(row.observed_at) }));
  }

  /** Each Skill's latest run: when, and whether it ended well (the background tasks page). */
  lastModelRuns(workspaceId: string): Array<{ skill: string; at: string; ok: boolean }> {
    return (this.#db.prepare(`SELECT skill, at, ok FROM model_usage m WHERE workspace_id = ? AND at = (SELECT MAX(at) FROM model_usage x WHERE x.workspace_id = m.workspace_id AND x.skill = m.skill)`)
      .all(workspaceId) as Array<{ skill: string; at: string; ok: number }>).map((row) => ({ skill: row.skill, at: row.at, ok: row.ok === 1 }));
  }

  summarizeModelUsage(workspaceId: string, sinceIso: string): ModelUsageSummary[] {
    const rows = this.#db.prepare(`
      SELECT skill, model, COUNT(*) AS runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, SUM(repairs) AS repairs,
        SUM(input_tokens) AS input_tokens, SUM(cached_input_tokens) AS cached_input_tokens, SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
        SUM(total_tokens) AS total_tokens, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
      FROM model_usage WHERE workspace_id = ? AND at >= ? GROUP BY skill, model ORDER BY total_tokens DESC, runs DESC
    `).all(workspaceId, sinceIso) as Array<Record<string, number | string>>;
    return rows.map((row) => ({ skill: String(row.skill), model: String(row.model), runs: Number(row.runs), failed: Number(row.failed),
      repairs: Number(row.repairs), inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens), outputTokens: Number(row.output_tokens),
      reasoningTokens: Number(row.reasoning_tokens), totalTokens: Number(row.total_tokens), averageSeconds: Math.round(Number(row.avg_ms) / 100) / 10, longestSeconds: Math.round(Number(row.max_ms) / 100) / 10 }));
  }

  /**
   * What an installed copy's usage sender reads (`apps/worker/src/telemetry.ts`), each strictly after its own cursor: ledger events
   * by rowid, model runs by id, interview replies by time. Rows, not meaning: the sender keeps only what
   * `packages/core/src/telemetry.ts` whitelists, and an interview reply contributes its number and the stage it answered, never its text.
   */
  telemetrySince(workspaceId: string, cursor: { eventRow: number; usageId: number; roundAt: string }, limit = 500): {
    events: Array<{ row: number; type: string; entityId: string; payload: unknown; createdAt: string }>;
    usage: Array<{ id: number; skill: string; ok: boolean; code: string; repairs: number; ms: number; input: number; cached: number; output: number; at: string }>;
    rounds: Array<{ seq: number; createdAt: string; stage?: string }>;
  } {
    const events = (this.#db.prepare("SELECT rowid AS row, type, entity_id, payload_json, created_at FROM events WHERE workspace_id = ? AND rowid > ? ORDER BY rowid LIMIT ?")
      .all(workspaceId, cursor.eventRow, limit) as Array<{ row: number; type: string; entity_id: string; payload_json: string; created_at: string }>)
      .map((row) => ({ row: Number(row.row), type: row.type, entityId: row.entity_id, createdAt: row.created_at,
        payload: (() => { try { return JSON.parse(row.payload_json) as unknown; } catch { return {}; } })() }));
    const usage = (this.#db.prepare(`SELECT id, skill, ok, error_code, repairs, duration_ms, input_tokens, cached_input_tokens, output_tokens, at
      FROM model_usage WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?`).all(workspaceId, cursor.usageId, limit) as Array<Record<string, string | number>>)
      .map((row) => ({ id: Number(row.id), skill: String(row.skill), ok: Number(row.ok) === 1, code: String(row.error_code), repairs: Number(row.repairs),
        ms: Number(row.duration_ms), input: Number(row.input_tokens), cached: Number(row.cached_input_tokens), output: Number(row.output_tokens), at: String(row.at) }));
    const rounds = (this.#db.prepare(`SELECT user.seq AS seq, user.created_at AS created_at,
        (SELECT content_json FROM onboarding_messages a WHERE a.workspace_id = user.workspace_id AND a.session_id = user.session_id
          AND a.role = 'assistant' AND a.seq < user.seq ORDER BY a.seq DESC LIMIT 1) AS asked
      FROM onboarding_messages user WHERE user.workspace_id = ? AND user.role = 'user' AND user.created_at > ? ORDER BY user.created_at LIMIT ?`)
      .all(workspaceId, cursor.roundAt, limit) as Array<{ seq: number; created_at: string; asked: string | null }>)
      .map((row) => {
        let stage: unknown;
        try { stage = (JSON.parse(row.asked ?? "{}") as { stage?: unknown }).stage; } catch { /* no stage */ }
        return { seq: Number(row.seq), createdAt: row.created_at, ...(typeof stage === "string" ? { stage } : {}) };
      });
    return { events, usage, rounds };
  }

  saveMilestoneAnchor(anchor: StoredMilestoneAnchor): void {
    // A save that does not mention the artifact references (an edited date from the input box) keeps the stored ones.
    const stored = anchor.outputs === undefined || anchor.inputs === undefined
      ? this.listMilestoneAnchors(anchor.workspaceId).find((item) => item.milestoneId === anchor.milestoneId) : undefined;
    this.#db.prepare(`
      INSERT INTO milestone_anchors (workspace_id, milestone_id, stage, deadline, baseline, target, stakeholders_json,
        source_fact_ids_json, depends_on_json, updated_at, outputs_json, inputs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, milestone_id) DO UPDATE SET stage = excluded.stage, deadline = excluded.deadline,
        baseline = excluded.baseline, target = excluded.target, stakeholders_json = excluded.stakeholders_json,
        source_fact_ids_json = excluded.source_fact_ids_json, depends_on_json = excluded.depends_on_json, updated_at = excluded.updated_at,
        outputs_json = excluded.outputs_json, inputs_json = excluded.inputs_json
    `).run(anchor.workspaceId, anchor.milestoneId, anchor.stage, anchor.deadline, anchor.baseline, anchor.target,
      JSON.stringify(anchor.stakeholders), JSON.stringify(anchor.sourceFactIds), JSON.stringify(anchor.dependsOn), anchor.updatedAt,
      JSON.stringify(anchor.outputs ?? stored?.outputs ?? []), JSON.stringify(anchor.inputs ?? stored?.inputs ?? []));
  }

  saveWaitingItem(item: Omit<StoredWaitingItem, "createdAt" | "updatedAt"> & { createdAt?: string }): { inserted: boolean } {
    const now = new Date().toISOString();
    const result = this.#db.prepare(`
      INSERT INTO waiting_items (id, owner_id, workspace_id, title, who, expected_at, approximate, follow_up_at, state, blocks_json, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
    `).run(item.id, item.ownerId, item.workspaceId, item.title, item.who, item.expectedAt, item.approximate ? 1 : 0,
      item.followUpAt, item.state, JSON.stringify(item.blocks), item.source, item.createdAt ?? now, now);
    if (result.changes) this.appendEvent({ ownerId: item.ownerId, workspaceId: item.workspaceId, idempotencyKey: `waiting.created:${item.id}`,
      type: "waiting.created", entityId: item.id, payload: { title: item.title, who: item.who, expectedAt: item.expectedAt, blocks: item.blocks } });
    return { inserted: result.changes > 0 };
  }

  listWaitingItems(workspaceId: string, options: { state?: StoredWaitingItem["state"] } = {}): StoredWaitingItem[] {
    const rows = this.#db.prepare(`SELECT * FROM waiting_items WHERE workspace_id = ?${options.state ? " AND state = ?" : ""} ORDER BY follow_up_at, id`)
      .all(...(options.state ? [workspaceId, options.state] : [workspaceId])) as Array<Record<string, string | number>>;
    return rows.map((row) => ({ id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
      title: String(row.title), who: String(row.who), expectedAt: String(row.expected_at), approximate: Number(row.approximate) === 1,
      followUpAt: String(row.follow_up_at), state: row.state as StoredWaitingItem["state"], blocks: JSON.parse(String(row.blocks_json)) as string[],
      source: row.source as StoredWaitingItem["source"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  }

  /** More work held up by the same open item (a second ask turned out to be waiting for the same thing). */
  addWaitingBlocks(workspaceId: string, id: string, blocks: string[], ownerId: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const item = this.listWaitingItems(workspaceId, { state: "open" }).find((row) => row.id === id);
      if (!item) throw new Error("WAITING_ITEM_NOT_OPEN");
      const added = blocks.filter((block) => !item.blocks.includes(block));
      if (!added.length) return { changed: false };
      const next = [...item.blocks, ...added];
      this.#db.prepare("UPDATE waiting_items SET blocks_json = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(JSON.stringify(next), new Date().toISOString(), workspaceId, id);
      this.appendEvent({ ownerId, workspaceId, idempotencyKey: `waiting.blocks_added:${id}:${next.join(",")}`, type: "waiting.blocks_added",
        entityId: id, payload: { added } });
      return { changed: true };
    }).immediate();
  }

  /**
   * The person's answer to 「…到了吗？」: it arrived (the work it held up may now be scheduled), it was
   * dropped, or not yet — ask again on `followUpAt`. Each answer is its own event; answering a closed item is refused.
   */
  answerWaitingItem(workspaceId: string, id: string, answer: { kind: "arrived" } | { kind: "cancelled" } | { kind: "deferred"; followUpAt: string },
    ownerId: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const item = this.listWaitingItems(workspaceId).find((row) => row.id === id);
      if (!item) throw new Error("WAITING_ITEM_NOT_FOUND");
      if (item.state !== "open") return { changed: false };
      const now = new Date().toISOString();
      if (answer.kind === "deferred") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(answer.followUpAt)) throw new Error("WAITING_FOLLOW_UP_INVALID");
        this.#db.prepare("UPDATE waiting_items SET follow_up_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(answer.followUpAt, now, workspaceId, id);
      } else {
        this.#db.prepare("UPDATE waiting_items SET state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(answer.kind, now, workspaceId, id);
      }
      const attempt = this.listEvents(workspaceId, { type: ["waiting.arrived", "waiting.cancelled", "waiting.deferred"], entityId: id }).length;
      this.appendEvent({ ownerId, workspaceId, idempotencyKey: `waiting.${answer.kind}:${id}:${attempt}`, type: `waiting.${answer.kind}`, entityId: id,
        payload: answer.kind === "deferred" ? { followUpAt: answer.followUpAt } : {} });
      return { changed: true };
    }).immediate();
  }

  /**
   * Opens a closed waiting item again (an undo of 「到了」/「不等了」/「推迟」): back to open, with the follow-up day it had before the answer.
   * Effects the answer already had elsewhere (a re-split it triggered) are not reversed; the item simply waits again.
   */
  reopenWaitingItem(workspaceId: string, id: string, followUpAt: string, ownerId: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const item = this.listWaitingItems(workspaceId).find((row) => row.id === id);
      if (!item) throw new Error("WAITING_ITEM_NOT_FOUND");
      if (item.state === "open" && item.followUpAt === followUpAt) return { changed: false };
      this.#db.prepare("UPDATE waiting_items SET state = 'open', follow_up_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(followUpAt, new Date().toISOString(), workspaceId, id);
      const attempt = this.listEvents(workspaceId, { type: "waiting.reopened", entityId: id }).length;
      this.appendEvent({ ownerId, workspaceId, idempotencyKey: `waiting.reopened:${id}:${attempt}`, type: "waiting.reopened", entityId: id,
        payload: { followUpAt } });
      return { changed: true };
    }).immediate();
  }

  /**
   * Saves a task's step plan. Steps already done or skipped are kept (their ids too); the rest are replaced by the new plan, so a
   * replan after the first steps never undoes recorded progress. One event per version.
   */
  saveStepPlan(workspaceId: string, workOrderId: string, plan: StepPlanInput, ownerId: string, reason: string): StoredStepPlan {
    return this.#db.transaction(() => {
      const previous = this.getStepPlan(workspaceId, workOrderId);
      const version = (previous?.version ?? 0) + 1;
      const now = new Date().toISOString();
      const kept = (previous?.steps ?? []).filter((step) => step.status !== "planned");
      const keptIds = new Set(kept.map((step) => step.id));
      this.#db.prepare("DELETE FROM task_steps WHERE workspace_id = ? AND work_order_id = ? AND status = 'planned'").run(workspaceId, workOrderId);
      this.#db.prepare(`INSERT INTO task_step_plans (workspace_id, work_order_id, version, archetype_id, quantity_json, rationale, planned_at, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, work_order_id) DO UPDATE SET version = excluded.version,
        archetype_id = excluded.archetype_id, quantity_json = excluded.quantity_json, rationale = excluded.rationale, planned_at = excluded.planned_at,
        detail_json = excluded.detail_json`)
        .run(workspaceId, workOrderId, version, plan.archetypeId, JSON.stringify(plan.quantity), plan.rationale, now,
          JSON.stringify({ units: plan.units ?? [], questions: plan.questions ?? [], ...(plan.importance ? { importance: plan.importance } : {}) }));
      // New ids continue after the kept ones so a dependency on a done step still points at it.
      const offset = kept.length;
      const insert = this.#db.prepare(`INSERT INTO task_steps (workspace_id, work_order_id, id, seq, role, title, deliverable, done_criterion, share,
        p25_minutes, p50_minutes, p85_minutes, depends_on_json, not_before, due_by, schedulable, executor, tick_outcome, status, progress_quarter, updated_at, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', 0, ?, ?)`);
      const rename = new Map(plan.steps.map((step, index) => [step.id, keptIds.has(step.id) ? step.id : `v${version}s${index + 1}`]));
      plan.steps.forEach((step, index) => {
        if (keptIds.has(step.id)) return;
        insert.run(workspaceId, workOrderId, rename.get(step.id)!, offset + index, step.role, step.title, step.deliverable, step.doneCriterion,
          step.share, step.estimate.p25Minutes, step.estimate.p50Minutes, step.estimate.p85Minutes,
          JSON.stringify(step.dependsOn.map((dep) => rename.get(dep) ?? dep)), step.notBefore, step.dueBy, step.schedulable ? 1 : 0,
          step.executor, step.tickOutcome, now, JSON.stringify({ covers: step.covers ?? [], why: step.why ?? "", ...(step.aiAssist?.tool ? { aiAssist: step.aiAssist } : {}), ...(step.firstAction ? { firstAction: step.firstAction } : {}) }));
      });
      this.appendEvent({ ownerId, workspaceId, idempotencyKey: `task.steps_planned:${workOrderId}:${version}`, type: "task.steps_planned",
        entityId: workOrderId, payload: { version, archetypeId: plan.archetypeId, steps: plan.steps.length, kept: kept.length, reason } });
      return this.getStepPlan(workspaceId, workOrderId)!;
    }).immediate();
  }

  getStepPlan(workspaceId: string, workOrderId: string): StoredStepPlan | undefined {
    return this.listStepPlans(workspaceId, workOrderId)[0];
  }

  listStepPlans(workspaceId: string, workOrderId?: string): StoredStepPlan[] {
    const plans = this.#db.prepare(`SELECT * FROM task_step_plans WHERE workspace_id = ?${workOrderId ? " AND work_order_id = ?" : ""}`)
      .all(...(workOrderId ? [workspaceId, workOrderId] : [workspaceId])) as Array<Record<string, string | number>>;
    if (!plans.length) return [];
    const steps = this.#db.prepare(`SELECT * FROM task_steps WHERE workspace_id = ?${workOrderId ? " AND work_order_id = ?" : ""} ORDER BY work_order_id, seq`)
      .all(...(workOrderId ? [workspaceId, workOrderId] : [workspaceId])) as Array<Record<string, string | number>>;
    const byOrder = new Map<string, StoredTaskStep[]>();
    for (const row of steps) {
      const list = byOrder.get(String(row.work_order_id)) ?? [];
      list.push({ id: String(row.id), workOrderId: String(row.work_order_id), seq: Number(row.seq), role: String(row.role), title: String(row.title),
        deliverable: String(row.deliverable), doneCriterion: String(row.done_criterion), share: Number(row.share),
        estimate: { p25Minutes: Number(row.p25_minutes), p50Minutes: Number(row.p50_minutes), p85Minutes: Number(row.p85_minutes) },
        dependsOn: JSON.parse(String(row.depends_on_json)) as string[], notBefore: String(row.not_before), dueBy: String(row.due_by),
        schedulable: Number(row.schedulable) === 1, executor: row.executor as StoredTaskStep["executor"], tickOutcome: String(row.tick_outcome),
        status: row.status as StoredTaskStep["status"], progressQuarter: Number(row.progress_quarter), updatedAt: String(row.updated_at),
        ...(JSON.parse(String(row.detail_json ?? "{}")) as { covers?: string[]; why?: string; aiAssist?: { tool: string; how: string; minutesSaved: number }; firstAction?: string }) });
      byOrder.set(String(row.work_order_id), list);
    }
    return plans.map((row) => ({ workOrderId: String(row.work_order_id), version: Number(row.version), archetypeId: String(row.archetype_id),
      quantity: JSON.parse(String(row.quantity_json)) as StoredStepPlan["quantity"], rationale: String(row.rationale),
      plannedAt: String(row.planned_at),
      ...(() => { const detail = JSON.parse(String(row.detail_json ?? "{}")) as Partial<Pick<StoredStepPlan, "units" | "questions" | "importance">>;
        return { units: detail.units ?? [], questions: detail.questions ?? [], ...(detail.importance ? { importance: detail.importance } : {}) }; })(),
      steps: byOrder.get(String(row.work_order_id)) ?? [] }));
  }

  /** The person's own estimate for one step (dragged on the card or the calendar). */
  updateStepEstimate(workspaceId: string, workOrderId: string, stepId: string,
    estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number }, ownerId: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const step = this.getStepPlan(workspaceId, workOrderId)?.steps.find((item) => item.id === stepId);
      if (!step) throw new Error("STEP_NOT_FOUND");
      if (step.estimate.p50Minutes === estimate.p50Minutes) return { changed: false };
      this.#db.prepare("UPDATE task_steps SET p25_minutes = ?, p50_minutes = ?, p85_minutes = ?, updated_at = ? WHERE workspace_id = ? AND work_order_id = ? AND id = ?")
        .run(estimate.p25Minutes, estimate.p50Minutes, estimate.p85Minutes, new Date().toISOString(), workspaceId, workOrderId, stepId);
      const attempt = this.listEvents(workspaceId, { type: "task.step_estimated", entityId: workOrderId }).length;
      this.appendEvent({ ownerId, workspaceId, idempotencyKey: `task.step_estimated:${workOrderId}:${stepId}:${attempt}`, type: "task.step_estimated",
        entityId: workOrderId, payload: { stepId, before: step.estimate, after: estimate } });
      return { changed: true };
    }).immediate();
  }

  /** Progress on one step: quarters (0–4), done, or skipped. Each change is its own event. */
  updateStepProgress(workspaceId: string, workOrderId: string, stepId: string,
    change: { progressQuarter?: number; status?: StoredTaskStep["status"] }, ownerId: string, source: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const step = this.getStepPlan(workspaceId, workOrderId)?.steps.find((item) => item.id === stepId);
      if (!step) throw new Error("STEP_NOT_FOUND");
      const quarter = change.status === "done" ? 4 : Math.max(0, Math.min(4, Math.round(change.progressQuarter ?? step.progressQuarter)));
      const status = change.status ?? (quarter === 4 ? "done" : step.status === "done" ? "planned" : step.status);
      if (quarter === step.progressQuarter && status === step.status) return { changed: false };
      this.#db.prepare("UPDATE task_steps SET progress_quarter = ?, status = ?, updated_at = ? WHERE workspace_id = ? AND work_order_id = ? AND id = ?")
        .run(quarter, status, new Date().toISOString(), workspaceId, workOrderId, stepId);
      const attempt = this.listEvents(workspaceId, { type: "task.step_progress", entityId: workOrderId }).length;
      this.appendEvent({ ownerId, workspaceId, idempotencyKey: `task.step_progress:${workOrderId}:${stepId}:${attempt}`, type: "task.step_progress",
        entityId: workOrderId, payload: { stepId, progressQuarter: quarter, status, source } });
      return { changed: true };
    }).immediate();
  }

  listMilestoneAnchors(workspaceId: string): StoredMilestoneAnchor[] {
    const rows = this.#db.prepare("SELECT * FROM milestone_anchors WHERE workspace_id = ? ORDER BY stage, milestone_id")
      .all(workspaceId) as Array<Record<string, string | number>>;
    return rows.map((row) => ({ workspaceId: String(row.workspace_id), milestoneId: String(row.milestone_id), stage: Number(row.stage),
      deadline: String(row.deadline), baseline: String(row.baseline), target: String(row.target),
      stakeholders: JSON.parse(String(row.stakeholders_json)), sourceFactIds: JSON.parse(String(row.source_fact_ids_json)),
      dependsOn: JSON.parse(String(row.depends_on_json)), updatedAt: String(row.updated_at),
      outputs: JSON.parse(String(row.outputs_json ?? "[]")), inputs: JSON.parse(String(row.inputs_json ?? "[]")) }));
  }

  saveDiligenceReport(report: StoredDiligenceReport): void {
    this.#db.prepare(`
      INSERT INTO diligence_reports (id, owner_id, workspace_id, scope, question, findings_json, proposals_json,
        sources_json, status, note, run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET findings_json = excluded.findings_json,
        proposals_json = excluded.proposals_json, sources_json = excluded.sources_json,
        status = excluded.status, note = excluded.note, run_at = excluded.run_at
    `).run(report.id, report.ownerId, report.workspaceId, report.scope, report.question,
      JSON.stringify(report.findings ?? []), JSON.stringify(report.proposals ?? []),
      JSON.stringify(report.sources ?? []), report.status, report.note ?? null, report.runAt);
  }

  listDiligenceReports(workspaceId: string): StoredDiligenceReport[] {
    const rows = this.#db.prepare("SELECT * FROM diligence_reports WHERE workspace_id = ? ORDER BY run_at DESC, rowid DESC")
      .all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, scope: row.scope!,
      question: row.question!, findings: JSON.parse(row.findings_json ?? "[]"),
      proposals: JSON.parse(row.proposals_json ?? "[]"), sources: JSON.parse(row.sources_json ?? "[]"),
      status: row.status as StoredDiligenceReport["status"], ...(row.note ? { note: row.note } : {}), runAt: row.run_at! }));
  }

  saveAssistantAttachment(attachment: StoredAssistantAttachment): void {
    this.#db.prepare(`
      INSERT INTO assistant_attachments (id, owner_id, workspace_id, thread_id, uri, media_type, file_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, thread_id, uri) DO NOTHING
    `).run(attachment.id, attachment.ownerId, attachment.workspaceId, attachment.threadId, attachment.uri,
      attachment.mediaType, attachment.fileName, attachment.createdAt);
  }

  listAssistantAttachments(workspaceId: string, threadId?: string): StoredAssistantAttachment[] {
    const rows = (threadId
      ? this.#db.prepare("SELECT * FROM assistant_attachments WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at, id").all(workspaceId, threadId)
      : this.#db.prepare("SELECT * FROM assistant_attachments WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId)) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      threadId: row.thread_id!, uri: row.uri!, mediaType: row.media_type!,
      fileName: row.file_name!, createdAt: row.created_at! }));
  }

  updateAnalysisAudit(workspaceId: string, id: string, audit: StoredCapture["audit"]): void {
    this.#db.transaction(() => {
      const capture = this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!capture) throw new Error("CAPTURE_NOT_FOUND");
      this.#db.prepare("UPDATE captures SET audit_json = ? WHERE workspace_id = ? AND id = ?")
        .run(JSON.stringify({ ...capture.audit, ...audit }), workspaceId, id);
    })();
  }

  /** Keeps one record; a second one with the same `dedupeKey` is not written (`inserted: false`) and the first stays as it was. */
  addRecord(workspaceId: string, input: DomainRecordInput, now = new Date().toISOString()): { inserted: boolean; record: StoredDomainRecord } {
    const record: StoredDomainRecord = { ...input, id: randomUUID(), workspaceId, createdAt: now };
    const result = this.#db.prepare(`INSERT OR IGNORE INTO domain_records (workspace_id, id, domain, kind, at, value, unit, currency, category, note, source,
      source_ref, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, record.id, input.domain, input.kind, input.at,
      input.value, input.unit, input.currency, input.category, input.note, input.source, input.sourceRef, input.dedupeKey, now);
    if (result.changes) return { inserted: true, record };
    const existing = this.listRecords(workspaceId, { includeDeleted: true }).find((item) => item.dedupeKey === input.dedupeKey)!;
    return { inserted: false, record: existing };
  }

  /** Records of a workspace, oldest first; `since` is a day (`YYYY-MM-DD`) compared with each record's own day. */
  listRecords(workspaceId: string, filter: { domain?: "wellness" | "wealth"; since?: string; includeDeleted?: boolean } = {}): StoredDomainRecord[] {
    const rows = this.#db.prepare(`SELECT * FROM domain_records WHERE workspace_id = ? ${filter.domain ? "AND domain = ?" : ""}
      ${filter.since ? "AND substr(at, 1, 10) >= ?" : ""} ${filter.includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY at, created_at`)
      .all(workspaceId, ...(filter.domain ? [filter.domain] : []), ...(filter.since ? [filter.since] : [])) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ id: String(row.id), workspaceId, domain: row.domain as "wellness" | "wealth", kind: row.kind as DomainRecordInput["kind"],
      at: String(row.at), value: Number(row.value), unit: String(row.unit), currency: String(row.currency), category: String(row.category), note: String(row.note),
      source: row.source as DomainRecordInput["source"], sourceRef: String(row.source_ref), dedupeKey: String(row.dedupe_key), createdAt: String(row.created_at) }));
  }

  /** Marks a record removed (kept for undo) or brings it back. */
  setRecordDeleted(workspaceId: string, id: string, deleted: boolean, at = new Date().toISOString()): boolean {
    return this.#db.prepare("UPDATE domain_records SET deleted_at = ? WHERE workspace_id = ? AND id = ?").run(deleted ? at : null, workspaceId, id).changes > 0;
  }

  appendEvent(event: LedgerEventInput): { inserted: boolean; eventId: string } {
    const existing = this.#db.prepare(
      "SELECT event_id FROM events WHERE workspace_id = ? AND idempotency_key = ?"
    ).get(event.workspaceId, event.idempotencyKey) as { event_id: string } | undefined;
    if (existing) return { inserted: false, eventId: existing.event_id };

    const eventId = randomUUID();
    this.#db.prepare(`
      INSERT INTO events (
        event_id, owner_id, workspace_id, idempotency_key, type, entity_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event.ownerId,
      event.workspaceId,
      event.idempotencyKey,
      event.type,
      event.entityId,
      JSON.stringify(event.payload),
      new Date().toISOString()
    );
    return { inserted: true, eventId };
  }

  /**
   * Events in the order they happened, scoped to one workspace.
   *
   * The workspace used to be the caller's problem: this took no arguments, read the whole table and
   * `JSON.parse`d every row, and forty-odd call sites filtered afterwards — several of them only by
   * `type`, so they would have read another workspace's rows the moment a second one existed. Making
   * it a parameter fixes the scoping and the full scan together, since `events_workspace_type` can
   * only be used by a query that names the workspace.
   *
   * `type` and `entityId` narrow it further. Passing them matters: the worker's timer paths were
   * walking the entire ledger every tick to build a two-entry map.
   */
  listEvents(workspaceId: string, options: { type?: string | string[]; entityId?: string } = {}): LedgerEvent[] {
    const types = options.type === undefined ? [] : Array.isArray(options.type) ? options.type : [options.type];
    const where = ["workspace_id = ?"];
    const values: string[] = [workspaceId];
    if (types.length) {
      where.push(`type IN (${types.map(() => "?").join(", ")})`);
      values.push(...types);
    }
    if (options.entityId !== undefined) {
      where.push("entity_id = ?");
      values.push(options.entityId);
    }
    // rowid is the order things actually happened. Ordering by (created_at, event_id) let a random
    // UUID decide the sequence of same-millisecond events, which defeats an append-only ledger.
    const rows = this.#db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY rowid`)
      .all(...values) as Array<Record<string, string>>;
    return rows.map((row) => ({
      eventId: row.event_id!,
      ownerId: row.owner_id!,
      workspaceId: row.workspace_id!,
      idempotencyKey: row.idempotency_key!,
      type: row.type!,
      entityId: row.entity_id!,
      payload: JSON.parse(row.payload_json!),
      createdAt: row.created_at!
    }));
  }

  saveMilestone(milestone: Omit<StoredMilestone, "successCriteria" | "verifiability">
    & Partial<Pick<StoredMilestone, "successCriteria" | "verifiability">>): void {
    const criteria = milestone.successCriteria ?? [];
    // An empty set is how a pre-v2 milestone is carried forward: honest, and refused by the gate.
    let verifiability: StoredMilestone["verifiability"] = "unstated";
    if (criteria.length) {
      const checked = validateSuccessCriteria(criteria);
      if (!checked.ok) throw new Error(checked.blocker.code);
      verifiability = checked.verifiability;
    }
    this.#db.prepare(`
      INSERT INTO milestones (
        id, owner_id, workspace_id, identity_id, title, version, status, updated_at, project_id,
        success_criteria_json, verifiability, template_id, confidence, evidence_question_bank_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id, version) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        updated_at = excluded.updated_at,
        project_id = COALESCE(excluded.project_id, milestones.project_id),
        success_criteria_json = excluded.success_criteria_json,
        verifiability = excluded.verifiability,
        template_id = excluded.template_id,
        confidence = excluded.confidence,
        evidence_question_bank_json = excluded.evidence_question_bank_json
    `).run(
      milestone.id,
      milestone.ownerId,
      milestone.workspaceId,
      milestone.identityId,
      milestone.title,
      milestone.version,
      milestone.status,
      new Date().toISOString(),
      milestone.projectId ?? null,
      JSON.stringify(criteria),
      verifiability,
      milestone.templateId ?? null,
      milestone.confidence ?? null,
      milestone.evidenceQuestionBank ? JSON.stringify(milestone.evidenceQuestionBank) : null
    );
  }

  #mapMilestoneRow(row: Record<string, string | number>): StoredMilestone {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      workspaceId: String(row.workspace_id),
      identityId: String(row.identity_id),
      title: String(row.title),
      version: Number(row.version),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      status: String(row.status) as StoredMilestone["status"],
      successCriteria: JSON.parse(String(row.success_criteria_json ?? "[]")) as SuccessCriterion[],
      verifiability: String(row.verifiability ?? "unstated") as StoredMilestone["verifiability"],
      ...(row.template_id ? { templateId: String(row.template_id) } : {}),
      ...(row.confidence ? { confidence: String(row.confidence) as "low" | "medium" | "high" } : {}),
      ...(row.evidence_question_bank_json
        ? { evidenceQuestionBank: JSON.parse(String(row.evidence_question_bank_json)) as EvidenceQuestionTemplate[] } : {})
    };
  }

  listMilestones(workspaceId: string): StoredMilestone[] {
    // The outer join used to match on `(id, version)` alone — harmless while two workspaces could never
    // both hold a row with the same id (the very bug migration 7 fixes), invisible until fixing that made
    // it possible for A and B to each have their own `(id, version)` pair land on the same literal
    // values, at which point this returned both rows to whichever workspace asked. `m.workspace_id = ?`
    // on the join, not just the subquery, is what keeps the two from being able to leak into each other.
    const rows = this.#db.prepare(`
      SELECT m.* FROM milestones m
      JOIN (
        SELECT id, MAX(version) AS version FROM milestones
        WHERE workspace_id = ? GROUP BY id
      ) latest ON latest.id = m.id AND latest.version = m.version
      WHERE m.workspace_id = ?
      ORDER BY m.identity_id, m.id
    `).all(workspaceId, workspaceId) as Array<Record<string, string | number>>;
    return rows.map((row) => this.#mapMilestoneRow(row));
  }

  /** Same latest-version join as `listMilestones`, narrowed to one id — index-covered
   * (`milestones_workspace(workspace_id, id)`) rather than the full-workspace scan `listMilestones`
   * does, for callers (like `task-detail.ts`'s single-id tier) that only need one milestone. */
  getMilestone(workspaceId: string, id: string): StoredMilestone | undefined {
    const row = this.#db.prepare(`
      SELECT m.* FROM milestones m
      JOIN (
        SELECT id, MAX(version) AS version FROM milestones
        WHERE workspace_id = ? AND id = ? GROUP BY id
      ) latest ON latest.id = m.id AND latest.version = m.version
      WHERE m.workspace_id = ? AND m.id = ?
    `).get(workspaceId, id, workspaceId, id) as Record<string, string | number> | undefined;
    return row ? this.#mapMilestoneRow(row) : undefined;
  }

  #mapMilestoneTemplateRow(row: Record<string, string>): StoredMilestoneTemplate {
    return {
      id: row.id!, kind: row.kind as MilestoneTemplateKind, identityId: row.identity_id!,
      titleHint: row.title_hint!,
      successCriteriaDefaults: JSON.parse(row.success_criteria_defaults_json!) as SuccessCriterion[],
      evidenceQuestionDefaults: JSON.parse(row.evidence_question_defaults_json!) as EvidenceQuestionTemplate[],
      source: row.source as MilestoneTemplateSource, createdAt: row.created_at!
    };
  }

  listMilestoneTemplates(workspaceId: string, identityId?: string): StoredMilestoneTemplate[] {
    const rows = (identityId
      ? this.#db.prepare("SELECT * FROM milestone_templates WHERE workspace_id = ? AND identity_id = ? ORDER BY id")
        .all(workspaceId, identityId)
      : this.#db.prepare("SELECT * FROM milestone_templates WHERE workspace_id = ? ORDER BY identity_id, id")
        .all(workspaceId)) as Array<Record<string, string>>;
    return rows.map((row) => this.#mapMilestoneTemplateRow(row));
  }

  /** Upsert by `(workspaceId, id)` — a template's own identity rarely changes, so this is a plain
   * replace rather than the versioned history `milestones` keeps for criteria a gate may already have
   * judged against. */
  saveMilestoneTemplate(template: Omit<StoredMilestoneTemplate, "createdAt"> & { workspaceId: string }): void {
    this.#db.prepare(`
      INSERT INTO milestone_templates (
        id, workspace_id, kind, identity_id, title_hint,
        success_criteria_defaults_json, evidence_question_defaults_json, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET
        kind = excluded.kind, identity_id = excluded.identity_id, title_hint = excluded.title_hint,
        success_criteria_defaults_json = excluded.success_criteria_defaults_json,
        evidence_question_defaults_json = excluded.evidence_question_defaults_json,
        source = excluded.source
    `).run(
      template.id, template.workspaceId, template.kind, template.identityId, template.titleHint,
      JSON.stringify(template.successCriteriaDefaults), JSON.stringify(template.evidenceQuestionDefaults),
      template.source, new Date().toISOString()
    );
  }

  /** Seeds the built-in template library into a workspace exactly once — `INSERT OR IGNORE` on the same
   * `(workspace_id, id)` primary key `saveMilestoneTemplate` upserts on, so a second call (a second
   * request racing the first, or a workspace that already has its builtins) is a no-op rather than
   * stomping a user's own edit to a builtin row id. */
  seedMilestoneTemplates(workspaceId: string, templates: Array<Omit<StoredMilestoneTemplate, "createdAt" | "source">>): void {
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO milestone_templates (
        id, workspace_id, kind, identity_id, title_hint,
        success_criteria_defaults_json, evidence_question_defaults_json, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'builtin', ?)
    `);
    const now = new Date().toISOString();
    this.#db.transaction(() => {
      for (const template of templates) {
        insert.run(template.id, workspaceId, template.kind, template.identityId, template.titleHint,
          JSON.stringify(template.successCriteriaDefaults), JSON.stringify(template.evidenceQuestionDefaults), now);
      }
    })();
  }

  saveMilestoneRelation(relation: Omit<StoredMilestoneRelation, RelationExtras> & Partial<Pick<StoredMilestoneRelation, RelationExtras>>): void {
    // A relation with no evidence decides nothing, so it is not allowed to claim approval.
    const status = relation.status === "approved" && !(relation.evidence ?? []).length ? "candidate" : relation.status;
    this.#db.prepare(`
      INSERT INTO milestone_relations (
        id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status,
        evidence_json, counterexample_json, cost_minutes, last_validated_at, explanation, refuted_when, updated_at,
        artifact_id, transfer_json, check_on, counterfactual
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET
        from_milestone_id = excluded.from_milestone_id,
        to_milestone_id = excluded.to_milestone_id,
        kind = excluded.kind,
        status = excluded.status,
        evidence_json = excluded.evidence_json,
        counterexample_json = excluded.counterexample_json,
        cost_minutes = excluded.cost_minutes,
        last_validated_at = excluded.last_validated_at,
        explanation = excluded.explanation,
        refuted_when = excluded.refuted_when,
        updated_at = excluded.updated_at,
        artifact_id = excluded.artifact_id,
        transfer_json = excluded.transfer_json,
        check_on = excluded.check_on,
        counterfactual = excluded.counterfactual
    `).run(
      relation.id, relation.ownerId, relation.workspaceId, relation.fromMilestoneId,
      relation.toMilestoneId, relation.kind, status,
      JSON.stringify(relation.evidence ?? []), JSON.stringify(relation.counterexample ?? []),
      relation.costMinutes ?? null, relation.lastValidatedAt ?? null,
      relation.explanation ?? null, relation.refutedWhen ?? null, new Date().toISOString(),
      relation.artifactId ?? null, relation.transfer ? JSON.stringify(relation.transfer) : null, relation.checkOn ?? null, relation.counterfactual ?? null
    );
  }

  listMilestoneRelations(workspaceId: string): StoredMilestoneRelation[] {
    const rows = this.#db.prepare(
      "SELECT * FROM milestone_relations WHERE workspace_id = ? AND status <> 'archived' ORDER BY id"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => this.#relationOf(row));
  }

  /** One relation by id, archived ones included — a re-derivation must not bring back one the person removed or the gate refuted. */
  getMilestoneRelation(workspaceId: string, id: string): StoredMilestoneRelation | undefined {
    const row = this.#db.prepare("SELECT * FROM milestone_relations WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as Record<string, string> | undefined;
    return row ? this.#relationOf(row) : undefined;
  }

  #relationOf(row: Record<string, string>): StoredMilestoneRelation {
    return ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      fromMilestoneId: row.from_milestone_id!, toMilestoneId: row.to_milestone_id!,
      kind: row.kind as StoredMilestoneRelation["kind"], status: row.status as StoredMilestoneRelation["status"],
      evidence: JSON.parse(String(row.evidence_json ?? "[]")),
      counterexample: JSON.parse(String(row.counterexample_json ?? "[]")),
      costMinutes: row.cost_minutes === null || row.cost_minutes === undefined ? null : Number(row.cost_minutes),
      lastValidatedAt: row.last_validated_at ?? null,
      explanation: row.explanation ?? null,
      refutedWhen: row.refuted_when ?? null,
      artifactId: row.artifact_id ?? null,
      transfer: row.transfer_json ? JSON.parse(row.transfer_json) as StoredMilestoneRelation["transfer"] : null,
      checkOn: row.check_on ?? null,
      counterfactual: row.counterfactual ?? null
    });
  }

  /**
   * Batch decision on candidate relations — the approval mode `requiredApproval("approve_milestone_relations")`
   * asks for.
   *
   * Only candidates are touched. A relation the user already approved, or that evidence has refuted,
   * is left exactly as it is: a batch action that silently re-decided settled relations would make the
   * whole review untrustworthy. Ids that are not candidates come back in `skipped` rather than being
   * reported as successes.
   */
  decideMilestoneRelations(workspaceId: string, ownerId: string, ids: string[], decision: "approved" | "archived",
    idempotencyKey: string): { decided: string[]; skipped: string[] } {
    const decided: string[] = [];
    const skipped: string[] = [];
    this.#db.transaction(() => {
      for (const id of ids) {
        const row = this.#db.prepare(
          "SELECT status, evidence_json FROM milestone_relations WHERE workspace_id = ? AND id = ?"
        ).get(workspaceId, id) as { status?: string; evidence_json?: string } | undefined;
        if (!row || row.status !== "candidate") { skipped.push(id); continue; }
        // The same rule `saveMilestoneRelation` enforces: a relation with no evidence decides nothing,
        // so it cannot be approved into one that does.
        if (decision === "approved" && !(JSON.parse(row.evidence_json ?? "[]") as unknown[]).length) {
          skipped.push(id);
          continue;
        }
        this.#db.prepare("UPDATE milestone_relations SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(decision, new Date().toISOString(), workspaceId, id);
        decided.push(id);
      }
      if (decided.length) {
        this.appendEvent({
          ownerId, workspaceId, idempotencyKey,
          type: "milestone_relations.decided", entityId: decided[0]!,
          payload: { decision, relationIds: decided, skipped }
        });
      }
    })();
    return { decided, skipped };
  }

  applyMilestoneGate(workspaceId: string, workOrderId: string, result: MilestoneGateResult,
    evidenceTexts: string[], idempotencyKey: string,
    durationCalibrationBaseline?: { p25Minutes: number; p50Minutes: number; p85Minutes: number }
  ): { changed: boolean; state: WorkOrderState } {
    // One transaction, not the dozen this used to be. The audit event, the transition, the payload
    // merge and any relation refutation each committed on their own, so a crash or a concurrent writer
    // between any two left the ledger and the row disagreeing — which is exactly the shape of the
    // "ledger says accepted, order still in evidence_review" state seen on the real database.
    return this.#db.transaction(() => {
    const order = this.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (!order || order.state !== "evidence_review") throw new Error("EVIDENCE_REVIEW_NOT_READY");
    const milestone = this.listMilestones(workspaceId).find((item) => item.id === order.milestoneId && item.status === "approved");
    // No `verifiability` check: a milestone without criteria is judged on the order's own contract (see
    // `buildMilestoneGateContext`); it just has no progress to record.
    if (!milestone) throw new Error("MILESTONE_NOT_FOUND");
    // The same requirement strings the gate was handed. This is the write, so the bar `pass` claims to
    // have cleared is re-checked here rather than trusted from the caller.
    const contractRequirements = requiredContractRequirements(
      (order.payload as { evidenceContract?: Array<{ description?: string; kind?: string; required?: boolean }> }).evidenceContract);
    validateMilestoneGateResult(result, milestone.successCriteria, evidenceTexts, contractRequirements,
      Boolean(currentMineVersion(readMineSkill(this.getSetting(workspaceId, mineSkillSettingKey(order.identityId))))));
    // Milestone progress is recorded on every judgement, pass or not. The verdict says whether this one
    // work order delivered; this says how far the milestone itself has moved, which is the question the
    // person actually has and which no single verdict can answer.
    this.appendEvent({
      ownerId: order.ownerId, workspaceId, idempotencyKey: `${idempotencyKey}:progress`,
      type: "milestone_gate.judged", entityId: workOrderId,
      payload: {
        milestoneId: milestone.id, milestoneVersion: milestone.version, verdict: result.verdict,
        criteriaVerdict: result.criteriaVerdict.map((item) => ({ criterionId: item.criterionId, met: item.met }))
      }
    });
    if (result.verdict !== "pass") {
      const transitioned = this.transitionWorkOrder(workspaceId, workOrderId,
        { type: "blocked", reason: `MILESTONE_GATE_${result.verdict.toUpperCase()}` }, idempotencyKey);
      // The judgement is kept on a refusal too. Only the pass path stored it, so a held work order
      // showed the person the single word MILESTONE_GATE_INSUFFICIENT and threw away the per-criterion
      // reasoning that says what is actually missing — which is the one thing they could act on.
      this.#mergeWorkOrderPayload(workspaceId, workOrderId, { gateReview: result });
      for (const assessment of result.flywheelAssessment.filter((item) => item.supports === "contradicts")) {
        this.refuteMilestoneRelation(workspaceId, assessment.relationId, assessment.evidenceQuote,
          `${idempotencyKey}:refute:${assessment.relationId}`);
      }
      return transitioned;
    }
    const relationIds = result.flywheelAssessment.filter((item) => item.supports === "advances").map((item) => item.relationId);
    const transitioned = this.transitionWorkOrder(workspaceId, workOrderId,
      { type: "evidence.accepted", approvalId: "crossline-milestone-gate" }, idempotencyKey,
      { ...(durationCalibrationBaseline ? { durationCalibrationBaseline } : {}) });
    // A reused idempotency key makes the transition a no-op, and writing the acceptance audit anyway
    // produced a ledger that said `milestone_gate.auto_accepted` about an order still sitting in
    // `evidence_review`. A key that has already been spent is a caller bug, and it says so.
    if (!transitioned.changed) throw new Error("GATE_ALREADY_APPLIED");
    this.#mergeWorkOrderPayload(workspaceId, workOrderId, {
      gateReview: result,
      autoAcceptance: { acceptedAt: new Date().toISOString(), relationIds }
    });
    this.appendEvent({ ownerId: order.ownerId, workspaceId, idempotencyKey: `${idempotencyKey}:audit`,
      type: "milestone_gate.auto_accepted", entityId: workOrderId, payload: { milestoneId: milestone.id, relationIds } });
    return transitioned;
    })["immediate"]();
  }

  revokeAutoAcceptance(workspaceId: string, workOrderId: string, reason: string, idempotencyKey: string): { changed: boolean; state: WorkOrderState } {
    // Read, check `state !== "accepted"`, transition, merge, append — five separate writes with no
    // outer transaction, so a revoke could half-happen.
    return this.#db.transaction(() => {
    const order = this.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    const payload = order?.payload as { autoAcceptance?: Record<string, unknown> } | undefined;
    if (!order || order.state !== "accepted" || !payload?.autoAcceptance) throw new Error("AUTO_ACCEPTANCE_NOT_REVOCABLE");
    if (!reason.trim()) throw new Error("REVOCATION_REASON_REQUIRED");
    const transitioned = this.transitionWorkOrder(workspaceId, workOrderId,
      { type: "acceptance.revoked", reason: reason.trim() }, idempotencyKey);
    // `transitionWorkOrder` no-ops silently on a spent idempotency key (`{ changed: false }`), which is
    // right for a genuine retry but wrong here if it happens anyway: the caller is expected to key each
    // attempt uniquely, and a collision reaching this point means the transition did NOT happen, not
    // that it happened before. Proceeding to merge the payload and append the audit event under that
    // assumption is exactly the bug this guard closes — the caller reported success for a revoke that
    // never touched the work order's state.
    if (!transitioned.changed) throw new Error("REVOCATION_ALREADY_APPLIED");
    this.#mergeWorkOrderPayload(workspaceId, workOrderId, {
      autoAcceptance: { ...payload.autoAcceptance, revokedAt: new Date().toISOString(), revocationReason: reason.trim() }
    });
    this.appendEvent({ ownerId: order.ownerId, workspaceId, idempotencyKey: `${idempotencyKey}:audit`,
      type: "milestone_gate.auto_acceptance_revoked", entityId: workOrderId, payload: { reason: reason.trim() } });
    return transitioned;
    })["immediate"]();
  }

  refuteMilestoneRelation(workspaceId: string, relationId: string, note: string, idempotencyKey: string): void {
    // The relation write, one payload merge per affected work order, and the ledger entry were all
    // separate; two concurrent merges on the same order also lost one of the patches.
    this.#db.transaction(() => {
    const relation = this.listMilestoneRelations(workspaceId).find((item) => item.id === relationId);
    if (!relation) throw new Error("MILESTONE_RELATION_NOT_FOUND");
    const observedAt = new Date().toISOString();
    this.saveMilestoneRelation({ ...relation, status: "refuted",
      counterexample: [...relation.counterexample, { note, observedAt }], lastValidatedAt: observedAt });
    for (const order of this.listWorkOrders(workspaceId).filter((item) => item.state === "accepted")) {
      const payload = order.payload as { autoAcceptance?: { relationIds?: string[]; [key: string]: unknown } };
      if (!payload.autoAcceptance?.relationIds?.includes(relationId)) continue;
      this.#mergeWorkOrderPayload(workspaceId, order.id, {
        autoAcceptance: { ...payload.autoAcceptance, questionedAt: observedAt, questionedByRelationId: relationId }
      });
    }
    this.appendEvent({ ownerId: relation.ownerId, workspaceId, idempotencyKey,
      type: "milestone_relation.refuted", entityId: relationId, payload: { note } });
    })["immediate"]();
  }

  /**
   * A day's local activity is a rolling summary, not an observation: it is rewritten as the day goes
   * on. Self-reports stay immutable (`saveEnergyObservation` ignores conflicts) because a thing a
   * person said at a moment must never be silently rewritten.
   */
  upsertDailyActivity(input: { ownerId: string; workspaceId: string; day: string; aggregate: Record<string, number>; observedAt: string }): void {
    this.#db.prepare(`
      INSERT INTO energy_observations (
        id, owner_id, workspace_id, source, level, confidence, aggregate_json, observed_at
      ) VALUES (?, ?, ?, 'local_activity', 'uncalibrated', 'low', ?, ?)
      ON CONFLICT(id) DO UPDATE SET aggregate_json = excluded.aggregate_json, observed_at = excluded.observed_at
    `).run(`local-activity:${input.day}`, input.ownerId, input.workspaceId,
      JSON.stringify(input.aggregate), input.observedAt);
  }

  saveEnergyObservation(observation: StoredEnergyObservation): void {
    this.#db.prepare(`
      INSERT INTO energy_observations (
        id, owner_id, workspace_id, source, level, confidence, aggregate_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      observation.id, observation.ownerId, observation.workspaceId, observation.source,
      observation.level, observation.confidence, JSON.stringify(observation.aggregate),
      observation.observedAt
    );
  }

  /** Absent means never asked — which is different from asked and declined. */
  getSetting(workspaceId: string, key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE workspace_id = ? AND key = ?")
      .get(workspaceId, key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(workspaceId: string, key: string, value: string): void {
    this.#db.prepare(`
      INSERT INTO settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(workspaceId, key, value, new Date().toISOString());
  }

  /** Every setting whose key starts with one of `prefixes` (what an undo snapshot compares before and after). */
  listSettings(workspaceId: string, prefixes: readonly string[]): Map<string, string> {
    const rows = this.#db.prepare("SELECT key, value FROM settings WHERE workspace_id = ?").all(workspaceId) as Array<{ key: string; value: string }>;
    return new Map(rows.filter((row) => prefixes.some((prefix) => row.key.startsWith(prefix))).map((row) => [row.key, row.value]));
  }

  /** Back to never set — what undoing the first save of a setting restores. */
  deleteSetting(workspaceId: string, key: string): void {
    this.#db.prepare("DELETE FROM settings WHERE workspace_id = ? AND key = ?").run(workspaceId, key);
  }

  /**
   * Structured background facts per identity — current experiment/paper title, key file paths, the kind
   * of thing onboarding digs up and a capture's own compaction step keeps in sync. Lives under
   * `background.<identityId>` in the existing generic `settings` table (no migration needed, same
   * substrate `schedule.availability`/`calendar.sources` already use), as typed wrappers here rather than
   * in `apps/web/lib/crossline.ts` (where the other settings wrappers live) because both the web app
   * (reads, via `task-detail.ts`) and the worker (writes, via `background-facts-runner.ts`) need this —
   * two separate packages that can't import each other's `lib/`, but both already depend on this one.
   */
  getBackgroundFacts(workspaceId: string, identityId: string): StoredBackgroundFact[] {
    const raw = this.getSetting(workspaceId, `background.${identityId}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed as StoredBackgroundFact[] : [];
    } catch { return []; }
  }

  /** Merges by `key` — last-write-wins per key, not a wholesale replace, so a compaction step run against
   * one capture never erases facts an earlier capture or onboarding turn already established. */
  mergeBackgroundFacts(workspaceId: string, identityId: string,
    incoming: Array<{ key: string; value: string; why: string; sourceQuote: string }>): void {
    if (!incoming.length) return;
    const byKey = new Map(this.getBackgroundFacts(workspaceId, identityId).map((fact) => [fact.key, fact]));
    const now = new Date().toISOString();
    for (const fact of incoming) byKey.set(fact.key, { ...fact, updatedAt: now });
    this.setSetting(workspaceId, `background.${identityId}`, JSON.stringify([...byKey.values()]));
  }

  /**
   * When the person last did something themselves (docs/review-2026-10-13.md §6.1): said something in the input box, timed or confirmed
   * work, answered a question, captured or discarded something, edited a milestone, reported a step's progress or their energy. A page
   * left open is not activity, and nothing the system did on its own counts. Background spending follows this.
   */
  lastPersonActivity(workspaceId: string): string | undefined {
    return (this.#db.prepare(`SELECT MAX(at) AS at FROM (${PERSON_ACTIVITY_SQL})`).get({ ws: workspaceId, since: "" }) as { at: string | null }).at ?? undefined;
  }

  /**
   * Every own action of the person since `since` (ISO; "" for all), oldest first (`PERSON_ACTIVITY_SQL` says what counts). The
   * return page finds the person's last absence in the gaps between them.
   */
  personActivityTimes(workspaceId: string, since: string): string[] {
    const rows = this.#db.prepare(`SELECT at FROM (${PERSON_ACTIVITY_SQL}) WHERE at IS NOT NULL ORDER BY at`).all({ ws: workspaceId, since }) as Array<{ at: string }>;
    return rows.map((row) => row.at);
  }

  /** Deletes a workspace's observations from one source (the camera's, when its consent is withdrawn). Returns how many went. */
  deleteEnergyObservations(workspaceId: string, source: StoredEnergyObservation["source"]): number {
    return this.#db.prepare("DELETE FROM energy_observations WHERE workspace_id = ? AND source = ?").run(workspaceId, source).changes;
  }

  listEnergyObservations(workspaceId: string): StoredEnergyObservation[] {
    const rows = this.#db.prepare(
      "SELECT * FROM energy_observations WHERE workspace_id = ? ORDER BY observed_at DESC, id"
    ).all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      source: row.source as StoredEnergyObservation["source"],
      level: row.level as StoredEnergyObservation["level"],
      confidence: row.confidence as StoredEnergyObservation["confidence"],
      aggregate: JSON.parse(row.aggregate_json!) as Record<string, number>,
      observedAt: row.observed_at!
    }));
  }


  listCapacityCommitments(workspaceId: string): CapacityCommitment[] {
    const rows = this.#db.prepare(
      "SELECT * FROM capacity_commitments WHERE workspace_id = ? ORDER BY id"
    ).all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      workspaceId: String(row.workspace_id),
      title: String(row.title),
      minimumMinutes: Number(row.minimum_minutes),
      ...(row.source_task_id ? { sourceTaskId: String(row.source_task_id) } : {})
    }));
  }

  #mapWorkOrderRow(row: Record<string, string>): StoredWorkOrder {
    return {
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, identityId: row.identity_id!,
      projectId: row.project_id!, milestoneId: row.milestone_id!, intent: row.intent!, state: row.state!,
      riskTier: row.risk_tier as StoredWorkOrder["riskTier"],
      estimate: JSON.parse(row.estimate_json!) as StoredWorkOrder["estimate"],
      payload: JSON.parse(row.payload_json!)
    };
  }

  listWorkOrders(workspaceId: string): StoredWorkOrder[] {
    const rows = this.#db.prepare(
      "SELECT * FROM work_orders WHERE workspace_id = ? ORDER BY updated_at, id"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => this.#mapWorkOrderRow(row));
  }

  /** Index-covered point lookup (`(workspace_id, id)` is the table's own primary key) for callers that
   * only need one work order — `task-detail.ts`'s single-id tier — instead of `listWorkOrders`'s full
   * per-workspace scan. */
  getWorkOrder(workspaceId: string, id: string): StoredWorkOrder | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM work_orders WHERE workspace_id = ? AND id = ?"
    ).get(workspaceId, id) as Record<string, string> | undefined;
    return row ? this.#mapWorkOrderRow(row) : undefined;
  }

  saveWorkOrder(workOrder: StoredWorkOrder): void {
    this.#db.prepare(`
      INSERT INTO work_orders (
        id, owner_id, workspace_id, identity_id, project_id, milestone_id,
        intent, state, risk_tier, estimate_json, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET
        identity_id = excluded.identity_id,
        project_id = excluded.project_id,
        milestone_id = excluded.milestone_id,
        intent = excluded.intent,
        state = excluded.state,
        risk_tier = excluded.risk_tier,
        estimate_json = excluded.estimate_json,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      workOrder.id, workOrder.ownerId, workOrder.workspaceId, workOrder.identityId,
      workOrder.projectId, workOrder.milestoneId, workOrder.intent, workOrder.state,
      workOrder.riskTier, JSON.stringify(workOrder.estimate), JSON.stringify(workOrder.payload),
      new Date().toISOString()
    );
  }

  /** Publish one backplan as a unit so a crash cannot leave half a set of draft steps. */
  saveBackplanDrafts(workspaceId: string, drafts: StoredWorkOrder[], event: LedgerEventInput): boolean {
    return this.#db.transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM events WHERE workspace_id = ? AND idempotency_key = ?")
        .get(workspaceId, event.idempotencyKey)) return false;
      const existing = new Set(this.listWorkOrders(workspaceId).map((item) => item.id));
      if (drafts.some((draft) => draft.workspaceId !== workspaceId || draft.state !== "awaiting_plan_approval"
        || existing.has(draft.id)))
        throw new Error("BACKPLAN_DRAFT_COLLISION");
      for (const draft of drafts) this.saveWorkOrder(draft);
      this.appendEvent(event);
      return true;
    })["immediate"]();
  }

  savePlanVersion(plan: StoredPlanVersion): void {
    this.#db.prepare(`
      INSERT INTO plan_versions (id, owner_id, workspace_id, version, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json
    `).run(plan.id, plan.ownerId, plan.workspaceId, plan.version, plan.status, JSON.stringify(plan.payload), new Date().toISOString());
  }

  listPlanVersions(workspaceId: string): StoredPlanVersion[] {
    const rows = this.#db.prepare(
      "SELECT * FROM plan_versions WHERE workspace_id = ? ORDER BY version DESC, created_at DESC"
    ).all(workspaceId) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
      version: Number(row.version), status: String(row.status) as StoredPlanVersion["status"],
      payload: JSON.parse(String(row.payload_json))
    }));
  }

  exportSnapshot(workspaceId: string): CrosslineSnapshot {
    const planVersions = this.listPlanVersions(workspaceId);
    // The typed fields below are the readable audit view; this raw dump is what a restore replays.
    // `events` and `milestones` are duplicated between the two on purpose: the typed copy parses
    // payloads for humans, the raw copy is what rebuilds the table without the importer needing to
    // know a single column name. `exportCoversEveryTable` keeps this list honest.
    const tableNames = [
      "events", "milestones",
      "captures", "capture_attachments",
      "milestone_relations",
      "work_orders", "executions", "evidence_claims", "plan_versions",
      "materials",
      "energy_observations", "external_bindings",
      "capacity_commitments", "duration_observations",
      "assistant_threads", "assistant_attachments", "milestone_templates",
      "workspace_projects", "source_documents", "onboarding_sessions", "onboarding_messages", "profile_facts",
      "diligence_reports", "milestone_anchors", "model_usage", "activity_segments", "waiting_items",
      "task_step_plans", "task_steps", "preference_entries", "learned_archetypes", "conversations", "conversation_messages", "beta_invites", "evidence_sentences", "question_ledger", "workspace_counters", "domain_records",
      "run_lessons",
      // Consent state is part of the ledger: a restore that silently re-enables collection is not a restore.
      "settings",
      // `principals`/`workspaces` are not workspace-scoped rows themselves — a principal is scoped by
      // membership, a workspace by its own id — so they get the two exceptions below instead of the
      // uniform `WHERE workspace_id = ?` query the rest of this list uses.
      "principals", "workspaces", "workspace_members", "tailscale_bindings", "device_leases", "audit_events"
    ] as const;
    // `ORDER BY rowid` for the same reason `listEvents` uses it: without it SQLite may return rows in
    // any order, so two exports of an unchanged database would not compare equal.
    const scopedByWorkspaceId = (tableName: string) =>
      this.#db.prepare(`SELECT * FROM ${tableName} WHERE workspace_id = ? ORDER BY rowid`)
        .all(workspaceId) as Array<Record<string, string | number | null>>;
    const tableQueries: Record<string, () => Array<Record<string, string | number | null>>> = {
      workspaces: () => this.#db.prepare("SELECT * FROM workspaces WHERE id = ? ORDER BY rowid")
        .all(workspaceId) as Array<Record<string, string | number | null>>,
      principals: () => this.#db.prepare(
        "SELECT * FROM principals WHERE id IN (SELECT principal_id FROM workspace_members WHERE workspace_id = ?) ORDER BY rowid"
      ).all(workspaceId) as Array<Record<string, string | number | null>>
    };
    const tables: Record<string, Array<Record<string, string | number | null>>> = Object.fromEntries(
      tableNames.map((tableName) => [tableName, (tableQueries[tableName] ?? (() => scopedByWorkspaceId(tableName)))()])
    );
    // A window title is the person's own, local, and not part of any backup: what was open stays on the machine.
    tables.activity_segments = tables.activity_segments!.map((row) => ({ ...row, title: "" }));
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      workspaceId,
      events: this.listEvents(workspaceId),
      milestones: this.listMilestones(workspaceId),
      capacityCommitments: this.listCapacityCommitments(workspaceId),
      workOrders: this.listWorkOrders(workspaceId),
      milestoneRelations: this.listMilestoneRelations(workspaceId),
      planVersions,
      energyObservations: this.listEnergyObservations(workspaceId),
      tables
    };
  }

  /**
   * The sync cursor for one external collection.
   *
   * Stored per (provider, collection) rather than per item: a delta cursor describes a whole stream, and
   * losing it means a full re-read rather than a lost row.
   */
  saveSyncCursor(input: { ownerId: string; workspaceId: string; provider: string; collection: string; cursor: string | null }): void {
    this.#db.prepare(`
      INSERT INTO external_bindings (id, owner_id, workspace_id, provider, external_id, etag, sync_cursor, mode, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 'read_only', ?)
      ON CONFLICT(workspace_id, provider, external_id) DO UPDATE SET
        sync_cursor = excluded.sync_cursor, updated_at = excluded.updated_at
    `).run(`${input.workspaceId}:${input.provider}:${input.collection}`, input.ownerId, input.workspaceId,
      input.provider, input.collection, input.cursor, new Date().toISOString());
  }

  readSyncCursor(workspaceId: string, provider: string, collection: string): string | null {
    const row = this.#db.prepare(
      "SELECT sync_cursor FROM external_bindings WHERE workspace_id = ? AND provider = ? AND external_id = ?"
    ).get(workspaceId, provider, collection) as { sync_cursor?: string | null } | undefined;
    return row?.sync_cursor ?? null;
  }

  /** Whether any of this workspace's per-source cursors for a provider has ever recorded a real sync. */
  hasAnySyncCursor(workspaceId: string, provider: string): boolean {
    const row = this.#db.prepare(
      "SELECT 1 FROM external_bindings WHERE workspace_id = ? AND provider = ? AND sync_cursor IS NOT NULL LIMIT 1"
    ).get(workspaceId, provider);
    return Boolean(row);
  }

  /** Every real table in this database, so the restore path can validate against reality. */
  tableNames(): string[] {
    const rows = this.#db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    // A full-text index (and the tables SQLite keeps for it) and the passages it indexes are derived from `source_documents`: rebuilt on
    // restore, never carried in a backup (they would double its size and could disagree with the files they were cut from).
    const virtual = rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "")).map((row) => row.name);
    return rows.map((row) => row.name).filter((name) => !DERIVED_TABLES.includes(name)
      && !virtual.some((table) => name === table || name.startsWith(`${table}_`)));
  }

  #columnsOf(tableName: string): string[] {
    return (this.#db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
  }

  /**
   * Rebuilds a workspace from a snapshot. This is the other half of `exportSnapshot`: a backup nobody
   * has ever restored is not a backup, it is a file.
   *
   * Restore is only ever a rebuild into an empty workspace. Merging into live rows would be
   * indistinguishable from silent corruption, and the one thing a restore must not do is damage the
   * ledger it exists to protect — so the refusal lives here, in the only code that can write, rather
   * than in a script that could be bypassed by calling this directly.
   */
  importSnapshot(snapshot: CrosslineSnapshot): Record<string, number> {
    if (snapshot.schemaVersion !== 2) throw new Error("RESTORE_SCHEMA_UNSUPPORTED");
    // A snapshot is a file read off disk, so its table and column names are untrusted input that would
    // otherwise be interpolated straight into SQL.
    const known = new Set(this.tableNames());
    const retired: Set<string> = new Set(RETIRED_TABLES);
    for (const [tableName, rows] of Object.entries(snapshot.tables)) {
      // A backup taken before migration 4 still lists the six tables that never carried a row. An
      // empty one is stepped over; one with rows is not, because the assumption behind dropping them
      // would have been wrong and skipping it would lose data without saying so.
      // A backup taken before migration 14 still carries the plan differences: they are archived as events below, not refused.
      if (!known.has(tableName) && tableName === "plan_changes") continue;
      // Derived passages are rebuilt from the documents below, whatever a snapshot carries.
      if (DERIVED_TABLES.includes(tableName)) continue;
      if (!known.has(tableName) && retired.has(tableName)) {
        if (rows.length) throw new Error("RESTORE_RETIRED_TABLE_NOT_EMPTY");
        continue;
      }
      if (!known.has(tableName)) throw new Error("RESTORE_UNKNOWN_TABLE");
      const columns = this.#columnsOf(tableName);
      const occupied = columns.includes("workspace_id")
        ? this.#db.prepare(`SELECT 1 FROM ${tableName} WHERE workspace_id = ? LIMIT 1`).get(snapshot.workspaceId)
        : this.#db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get();
      if (occupied) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    }

    const counts: Record<string, number> = {};
    this.#db.transaction(() => {
      // Rows are replayed in whatever order the snapshot lists them, so foreign keys are checked once
      // at commit instead of demanding the importer know the dependency order between tables.
      this.#db.pragma("defer_foreign_keys = ON");
      for (const [tableName, rows] of Object.entries(snapshot.tables)) {
        if (!known.has(tableName) || DERIVED_TABLES.includes(tableName)) continue;
        counts[tableName] = rows.length;
        const first = rows[0];
        if (!first) continue;
        const allowed = new Set(this.#columnsOf(tableName));
        // A snapshot older than a migration that dropped a column still carries it. Dropping it from
        // the insert is only safe while every row's value is empty — otherwise the migration threw
        // away something real, and refusing the restore is the correct way to find that out.
        const columns = Object.keys(first).filter((column) => {
          if (allowed.has(column)) return true;
          const retiredHere: readonly string[] = RETIRED_COLUMNS[tableName] ?? [];
          if (!retiredHere.includes(column)) throw new Error("RESTORE_UNKNOWN_COLUMN");
          if (rows.some((row) => row[column] !== null && row[column] !== undefined)) {
            throw new Error("RESTORE_RETIRED_COLUMN_NOT_EMPTY");
          }
          return false;
        });
        const statement = this.#db.prepare(
          `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
        );
        for (const row of rows) statement.run(columns.map((column) => row[column] ?? null));
      }
      const changes = snapshot.tables.plan_changes ?? [];
      if (changes.length && !known.has("plan_changes")) {
        counts.plan_changes = changes.length;
        const fields = ["id", "owner_id", "workspace_id", "plan_version_id", "kind", "trigger_event_id", "explanation", "before_json", "after_json", "status"];
        this.#db.exec(`CREATE TEMP TABLE restored_plan_changes (${fields.join(" TEXT, ")} TEXT)`);
        const insert = this.#db.prepare(`INSERT INTO restored_plan_changes VALUES (${fields.map(() => "?").join(", ")})`);
        for (const row of changes) insert.run(fields.map((field) => row[field] ?? null));
        this.#archivePlanChangeRows("SELECT * FROM temp.restored_plan_changes");
        this.#db.exec("DROP TABLE temp.restored_plan_changes");
      }
      this.#collapsePlanVersions(snapshot.workspaceId);
      // A backup taken before migration 16 has no document numbers: they get the ones their position gave them when it was taken.
      this.#numberDocuments(snapshot.workspaceId);
      // The passage index is not in a backup: it is cut again from the restored documents.
      this.#db.prepare("DELETE FROM doc_chunks WHERE workspace_id = ?").run(snapshot.workspaceId);
      this.#indexDocuments(snapshot.workspaceId);
    })();
    return counts;
  }

  /** Gives every document without a fixed `src-N` number the next ones, in upload order (migration 16 and older backups). */
  #numberDocuments(workspaceId?: string): void {
    const scope = workspaceId ? "AND workspace_id = ?" : "";
    this.#db.prepare(`UPDATE source_documents SET ref_no = (
        SELECT numbered.n FROM (SELECT rowid AS r, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, rowid)
          + (SELECT COALESCE(MAX(ref_no), 0) FROM source_documents kept WHERE kept.workspace_id = d.workspace_id) AS n
          FROM source_documents d WHERE ref_no IS NULL) numbered WHERE numbered.r = source_documents.rowid)
      WHERE ref_no IS NULL ${scope}`).run(...(workspaceId ? [workspaceId] : []));
  }

  getPrincipalByBetterAuthId(betterAuthUserId: string): StoredPrincipal | undefined {
    const row = this.#db.prepare("SELECT * FROM principals WHERE better_auth_user_id = ?")
      .get(betterAuthUserId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return { id: row.id!, betterAuthUserId: row.better_auth_user_id!, createdAt: row.created_at! };
  }

  getWorkspaceMembership(principalId: string, workspaceId: string): StoredWorkspaceMember | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM workspace_members WHERE principal_id = ? AND workspace_id = ?"
    ).get(principalId, workspaceId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      principalId: row.principal_id!, workspaceId: row.workspace_id!,
      role: row.role as StoredWorkspaceMember["role"], createdAt: row.created_at!
    };
  }

  /**
   * One lease per `(workspace, device)` — re-issuing (the offline workbench renews on every successful
   * sync) replaces the existing row rather than accumulating one per login, which is what the table's
   * own `UNIQUE(workspace_id, device_id)` constraint already enforces at the schema level.
   */
  issueDeviceLease(lease: { id: string; principalId: string; workspaceId: string; deviceId: string;
    issuedAt: string; expiresAt: string }): StoredDeviceLease {
    this.#db.prepare(`
      INSERT INTO device_leases (id, principal_id, workspace_id, device_id, issued_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace_id, device_id) DO UPDATE SET
        id = excluded.id, principal_id = excluded.principal_id,
        issued_at = excluded.issued_at, expires_at = excluded.expires_at, revoked_at = NULL
    `).run(lease.id, lease.principalId, lease.workspaceId, lease.deviceId, lease.issuedAt, lease.expiresAt);
    return { ...lease };
  }

  /** Every device this workspace has ever leased, newest first — what a "撤销设备" list is built from;
   * a revoked lease stays in this list (with `revokedAt` set) rather than disappearing, so the owner can
   * see it was actually revoked instead of just no longer appearing. */
  listDeviceLeases(workspaceId: string): StoredDeviceLease[] {
    const rows = this.#db.prepare(
      "SELECT * FROM device_leases WHERE workspace_id = ? ORDER BY issued_at DESC"
    ).all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, principalId: row.principal_id!, workspaceId: row.workspace_id!, deviceId: row.device_id!,
      issuedAt: row.issued_at!, expiresAt: row.expires_at!, ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
    }));
  }

  getDeviceLease(workspaceId: string, deviceId: string): StoredDeviceLease | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM device_leases WHERE workspace_id = ? AND device_id = ?"
    ).get(workspaceId, deviceId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    return {
      id: row.id!, principalId: row.principal_id!, workspaceId: row.workspace_id!, deviceId: row.device_id!,
      issuedAt: row.issued_at!, expiresAt: row.expires_at!, ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
    };
  }

  revokeDeviceLease(workspaceId: string, deviceId: string): { changed: boolean } {
    const result = this.#db.prepare(
      "UPDATE device_leases SET revoked_at = ? WHERE workspace_id = ? AND device_id = ? AND revoked_at IS NULL"
    ).run(new Date().toISOString(), workspaceId, deviceId);
    return { changed: result.changes > 0 };
  }

  /** One binding per `(workspace, tailscaleLogin)` — clicking "信任这个 Tailscale 身份" again for the same
   * login updates the existing row (e.g. a later request happened to carry `nodeKey` where an earlier
   * one could not) rather than accumulating duplicates. */
  saveTailscaleBinding(binding: { id: string; principalId: string; workspaceId: string; tailscaleLogin: string;
    nodeKey?: string; createdAt: string }): StoredTailscaleBinding {
    this.#db.prepare(`
      INSERT INTO tailscale_bindings (id, principal_id, workspace_id, tailscale_login, node_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, tailscale_login) DO UPDATE SET
        id = excluded.id, principal_id = excluded.principal_id, node_key = excluded.node_key
    `).run(binding.id, binding.principalId, binding.workspaceId, binding.tailscaleLogin, binding.nodeKey ?? null, binding.createdAt);
    return { ...binding };
  }

  listTailscaleBindings(workspaceId: string): StoredTailscaleBinding[] {
    const rows = this.#db.prepare(
      "SELECT * FROM tailscale_bindings WHERE workspace_id = ? ORDER BY created_at"
    ).all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, principalId: row.principal_id!, workspaceId: row.workspace_id!,
      tailscaleLogin: row.tailscale_login!, createdAt: row.created_at!,
      ...(row.node_key ? { nodeKey: row.node_key } : {})
    }));
  }

  revokeTailscaleBinding(workspaceId: string, tailscaleLogin: string): { changed: boolean } {
    const result = this.#db.prepare(
      "DELETE FROM tailscale_bindings WHERE workspace_id = ? AND tailscale_login = ?"
    ).run(workspaceId, tailscaleLogin);
    return { changed: result.changes > 0 };
  }

  /** Keyed on `(workspace, execution)`, not `work_order_id`: a revoked-then-re-judged WorkOrder reuses
   * the same closed execution, so a repeat call from `evidence.accepted` is a safe no-op instead of a
   * second, double-counted observation. */
  recordDurationObservation(input: {
    ownerId: string; workspaceId: string; workOrderId: string; executionId: string;
    identityId: string; family: string;
    observedMinutes: number; wallClockMinutes: number; pauseMinutes: number; interruptionDominant: boolean;
    baseline: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
    observedAt: string;
    llm?: { p50Minutes: number; p85Minutes: number } | null; actualSource?: StoredDurationObservation["actualSource"];
    contextVersion?: string; censored?: boolean;
  }): { changed: boolean } {
    const result = this.#db.prepare(`
      INSERT INTO duration_observations (
        id, owner_id, workspace_id, work_order_id, execution_id, identity_id, family,
        observed_minutes, wall_clock_minutes, pause_minutes, interruption_dominant,
        baseline_p25_minutes, baseline_p50_minutes, baseline_p85_minutes, observed_at, created_at,
        llm_p50_minutes, llm_p85_minutes, actual_source, context_version, censored
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, execution_id) DO NOTHING
    `).run(randomUUID(), input.ownerId, input.workspaceId, input.workOrderId, input.executionId,
      input.identityId, input.family, input.observedMinutes, input.wallClockMinutes, input.pauseMinutes,
      input.interruptionDominant ? 1 : 0, input.baseline.p25Minutes, input.baseline.p50Minutes,
      input.baseline.p85Minutes, input.observedAt, new Date().toISOString(),
      input.llm?.p50Minutes ?? null, input.llm?.p85Minutes ?? null, input.actualSource ?? "timer", input.contextVersion ?? "", input.censored ? 1 : 0);
    return { changed: result.changes > 0 };
  }

  listDurationObservations(workspaceId: string, identityId: string, family: string): StoredDurationObservation[] {
    return this.#durationRows(this.#db.prepare(
      "SELECT * FROM duration_observations WHERE workspace_id = ? AND identity_id = ? AND family = ? ORDER BY observed_at, id"
    ).all(workspaceId, identityId, family) as Array<Record<string, string | number>>);
  }

  /** Every observation in the workspace, oldest first — what a person-level calibration is fitted on. */
  listAllDurationObservations(workspaceId: string): StoredDurationObservation[] {
    return this.#durationRows(this.#db.prepare("SELECT * FROM duration_observations WHERE workspace_id = ? ORDER BY observed_at, id")
      .all(workspaceId) as Array<Record<string, string | number>>);
  }

  #durationRows(rows: Array<Record<string, string | number>>): StoredDurationObservation[] {
    return rows.map((row) => ({
      id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
      workOrderId: String(row.work_order_id), executionId: String(row.execution_id),
      identityId: String(row.identity_id), family: String(row.family),
      observedMinutes: Number(row.observed_minutes), wallClockMinutes: Number(row.wall_clock_minutes),
      pauseMinutes: Number(row.pause_minutes), interruptionDominant: Number(row.interruption_dominant) === 1,
      baselineP25Minutes: Number(row.baseline_p25_minutes), baselineP50Minutes: Number(row.baseline_p50_minutes),
      baselineP85Minutes: Number(row.baseline_p85_minutes),
      llmP50Minutes: row.llm_p50_minutes === null || row.llm_p50_minutes === undefined ? null : Number(row.llm_p50_minutes),
      llmP85Minutes: row.llm_p85_minutes === null || row.llm_p85_minutes === undefined ? null : Number(row.llm_p85_minutes),
      actualSource: (row.actual_source ?? "timer") as StoredDurationObservation["actualSource"],
      contextVersion: String(row.context_version ?? ""), censored: Number(row.censored ?? 0) === 1,
      observedAt: String(row.observed_at), createdAt: String(row.created_at)
    }));
  }

  /** One beta invite: an application, then the owner's decision, then the redemption (see `packages/db/src/invites.ts`). */
  saveInvite(invite: StoredInvite): void {
    this.#db.prepare(`INSERT INTO beta_invites (id, workspace_id, email, reason, status, code_hash, created_at, decided_at, redeemed_at, redeemed_workspace_id)
      VALUES (@id, @workspaceId, @email, @reason, @status, @codeHash, @createdAt, @decidedAt, @redeemedAt, @redeemedWorkspaceId)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, code_hash = excluded.code_hash, decided_at = excluded.decided_at,
        redeemed_at = excluded.redeemed_at, redeemed_workspace_id = excluded.redeemed_workspace_id`)
      .run({ codeHash: null, decidedAt: null, redeemedAt: null, redeemedWorkspaceId: null, ...invite });
  }

  /** Invites by id, applicant workspace, or code hash; newest first. */
  listInvites(filter: { id?: string; workspaceId?: string; codeHash?: string } = {}): StoredInvite[] {
    const where = [filter.id ? "id = @id" : "", filter.workspaceId ? "workspace_id = @workspaceId" : "", filter.codeHash ? "code_hash = @codeHash" : ""].filter(Boolean);
    const rows = this.#db.prepare(`SELECT * FROM beta_invites ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`)
      .all(Object.fromEntries(Object.entries(filter).filter(([, value]) => value))) as Array<Record<string, string | null>>;
    return rows.map((row) => ({ id: row.id!, workspaceId: row.workspace_id!, email: row.email!, reason: row.reason ?? "",
      status: row.status as StoredInvite["status"], createdAt: row.created_at!,
      ...(row.code_hash ? { codeHash: row.code_hash } : {}), ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
      ...(row.redeemed_at ? { redeemedAt: row.redeemed_at } : {}), ...(row.redeemed_workspace_id ? { redeemedWorkspaceId: row.redeemed_workspace_id } : {}) }));
  }

  listWorkspaces(): StoredWorkspace[] {
    // rowid breaks a same-millisecond tie by creation order; the random id would make "the first workspace" a coin flip.
    const rows = this.#db.prepare("SELECT * FROM workspaces ORDER BY created_at, rowid")
      .all() as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, name: row.name!, createdAt: row.created_at! }));
  }

  /**
   * The worker runs as a background job with no request/session of its own, so it cannot get an
   * `AccessContext` from `requireAccessContext` — it loops `listWorkspaces()` and needs the owner
   * principal for each one to attribute the events it appends. Every workspace has exactly one owner
   * member (no invite path exists yet), so this is that row's `principal_id`.
   */
  getWorkspaceOwnerId(workspaceId: string): string | undefined {
    const row = this.#db.prepare(
      "SELECT principal_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1"
    ).get(workspaceId) as { principal_id?: string } | undefined;
    return row?.principal_id;
  }

  /**
   * The only place a principal or a workspace is ever created. Keyed on the Better Auth user id so a
   * second call for the same account — a repeated login, a retried request — returns the existing
   * principal and its existing owner workspace rather than minting a second one. Every login stays a
   * single-owner personal workspace by design; there is no invite path that adds a second member.
   */
  createPrincipalWithWorkspace(betterAuthUserId: string, workspaceName: string):
    { principal: StoredPrincipal; workspace: StoredWorkspace } {
    return this.#db.transaction(() => {
      const existing = this.getPrincipalByBetterAuthId(betterAuthUserId);
      if (existing) {
        const membership = this.#db.prepare(
          "SELECT workspace_id FROM workspace_members WHERE principal_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1"
        ).get(existing.id) as { workspace_id: string } | undefined;
        if (!membership) throw new Error("PRINCIPAL_WITHOUT_OWNER_WORKSPACE");
        const workspaceRow = this.#db.prepare("SELECT * FROM workspaces WHERE id = ?")
          .get(membership.workspace_id) as Record<string, string>;
        return {
          principal: existing,
          workspace: { id: workspaceRow.id!, name: workspaceRow.name!, createdAt: workspaceRow.created_at! }
        };
      }
      const now = new Date().toISOString();
      const principal: StoredPrincipal = { id: randomUUID(), betterAuthUserId, createdAt: now };
      const workspace: StoredWorkspace = { id: randomUUID(), name: workspaceName, createdAt: now };
      this.#db.prepare("INSERT INTO principals (id, better_auth_user_id, created_at) VALUES (?, ?, ?)")
        .run(principal.id, principal.betterAuthUserId, principal.createdAt);
      this.#db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
        .run(workspace.id, workspace.name, workspace.createdAt);
      this.#db.prepare(
        "INSERT INTO workspace_members (principal_id, workspace_id, role, created_at) VALUES (?, ?, 'owner', ?)"
      ).run(principal.id, workspace.id, now);
      return { principal, workspace };
    })();
  }

  /**
   * What `requireAccessContext` calls on every request. The steady-state path (every request after an
   * account's first-ever login) used to cost 4 separate SQL statements — `createPrincipalWithWorkspace`'s
   * own 3-statement "principal already exists" branch, plus a redundant `getWorkspaceMembership` call
   * re-querying the exact same `workspace_members` row `createPrincipalWithWorkspace` had just read —
   * because every workspace has exactly one owner member and no invite path adds a second, that row is
   * always the same one. One indexed JOIN replaces all 4. First-ever login (the one-time path) still goes
   * through `createPrincipalWithWorkspace`'s existing transactional creation unchanged, since that path
   * runs once per account ever, not on the per-request path this method exists to speed up.
   */
  resolvePrincipalWorkspace(betterAuthUserId: string, workspaceName: string):
    { principal: StoredPrincipal; workspace: StoredWorkspace; role: StoredWorkspaceMember["role"] } {
    const fast = this.#db.prepare(`
      SELECT p.id AS principal_id, p.created_at AS principal_created_at, wm.role AS role,
             w.id AS workspace_id, w.name AS workspace_name, w.created_at AS workspace_created_at
      FROM principals p
      JOIN workspace_members wm ON wm.principal_id = p.id AND wm.role = 'owner'
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE p.better_auth_user_id = ?
    `).get(betterAuthUserId) as Record<string, string> | undefined;
    if (fast) {
      return {
        principal: { id: fast.principal_id!, betterAuthUserId, createdAt: fast.principal_created_at! },
        workspace: { id: fast.workspace_id!, name: fast.workspace_name!, createdAt: fast.workspace_created_at! },
        role: fast.role as StoredWorkspaceMember["role"]
      };
    }
    const { principal, workspace } = this.createPrincipalWithWorkspace(betterAuthUserId, workspaceName);
    const membership = this.getWorkspaceMembership(principal.id, workspace.id);
    if (!membership) throw new Error("PRINCIPAL_WITHOUT_OWNER_WORKSPACE");
    return { principal, workspace, role: membership.role };
  }

  /**
   * 「清空数据重新开始」: every row the workspace holds goes, as in `purgeWorkspace`, except what makes it the same account — its members,
   * device leases, Tailscale bindings and audit trail, the model spend it has run up, and the settings and events whose key or type starts
   * with one of `keep`'s prefixes (the machine-owner mark, the model connection and its conformance record). The workspace itself stays, so
   * the next page lands on an empty board and the interview, signed in as before. Returns the work orders and the stored files only this
   * workspace pointed at, for the caller to remove.
   */
  resetWorkspace(workspaceId: string, keep: { settingPrefixes: string[]; eventTypePrefixes: string[] }): { rows: number; workOrderIds: string[]; fileUris: string[] } {
    const untouched = new Set(["workspace_members", "device_leases", "tailscale_bindings", "audit_events", "model_usage", "settings", "events", "beta_invites"]);
    const kept = (value: string, prefixes: string[]) => prefixes.some((prefix) => value.startsWith(prefix));
    return this.#db.transaction(() => {
      const workOrderIds = this.#db.prepare("SELECT DISTINCT id FROM work_orders WHERE workspace_id = ?").pluck().all(workspaceId) as string[];
      const fileUris = this.#db.prepare(`SELECT DISTINCT uri FROM source_documents WHERE workspace_id = ?
        AND uri NOT IN (SELECT uri FROM source_documents WHERE workspace_id <> ?)`).pluck().all(workspaceId, workspaceId) as string[];
      const tables = (this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[])
        .filter((name) => !untouched.has(name)
          && (this.#db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).some((column) => column.name === "workspace_id"));
      let rows = 0;
      for (const name of tables) rows += this.#db.prepare(`DELETE FROM "${name}" WHERE workspace_id = ?`).run(workspaceId).changes;
      const deleteSetting = this.#db.prepare("DELETE FROM settings WHERE workspace_id = ? AND key = ?");
      for (const key of this.#db.prepare("SELECT key FROM settings WHERE workspace_id = ?").pluck().all(workspaceId) as string[]) {
        if (!kept(key, keep.settingPrefixes)) rows += deleteSetting.run(workspaceId, key).changes;
      }
      const deleteEvents = this.#db.prepare("DELETE FROM events WHERE workspace_id = ? AND type = ?");
      for (const type of this.#db.prepare("SELECT DISTINCT type FROM events WHERE workspace_id = ?").pluck().all(workspaceId) as string[]) {
        if (!kept(type, keep.eventTypePrefixes)) rows += deleteEvents.run(workspaceId, type).changes;
      }
      return { rows, workOrderIds, fileUris };
    }).immediate();
  }

  /**
   * Deletes a workspace and everything recorded in it (the person's 「删除账号」, decided 2026-10-17): every row of every table that
   * carries this `workspace_id` — found from the schema, so a table added later is covered without a change here — then the workspace,
   * then each member principal that belongs to no other workspace. One transaction: a failure leaves the workspace whole.
   * Returns what the caller still has to remove outside this database: the Better Auth users whose principal went, the work orders
   * (their material folders) and the stored files no other workspace points at.
   */
  purgeWorkspace(workspaceId: string): { rows: number; betterAuthUserIds: string[]; workOrderIds: string[]; fileUris: string[] } {
    return this.#db.transaction(() => {
      const members = this.#db.prepare("SELECT principal_id FROM workspace_members WHERE workspace_id = ?").pluck().all(workspaceId) as string[];
      const workOrderIds = this.#db.prepare("SELECT DISTINCT id FROM work_orders WHERE workspace_id = ?").pluck().all(workspaceId) as string[];
      const fileUris = this.#db.prepare(`SELECT DISTINCT uri FROM source_documents WHERE workspace_id = ?
        AND uri NOT IN (SELECT uri FROM source_documents WHERE workspace_id <> ?)`).pluck().all(workspaceId, workspaceId) as string[];
      const tables = (this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[])
        .filter((name) => (this.#db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).some((column) => column.name === "workspace_id"));
      let rows = 0;
      for (const name of tables) rows += this.#db.prepare(`DELETE FROM "${name}" WHERE workspace_id = ?`).run(workspaceId).changes;
      rows += this.#db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId).changes;
      const betterAuthUserIds: string[] = [];
      for (const principalId of members) {
        if (this.#db.prepare("SELECT 1 FROM workspace_members WHERE principal_id = ? LIMIT 1").get(principalId)) continue;
        const row = this.#db.prepare("SELECT better_auth_user_id FROM principals WHERE id = ?").get(principalId) as { better_auth_user_id: string } | undefined;
        if (row) betterAuthUserIds.push(row.better_auth_user_id);
        rows += this.#db.prepare("DELETE FROM principals WHERE id = ?").run(principalId).changes;
      }
      return { rows, betterAuthUserIds, workOrderIds, fileUris };
    }).immediate();
  }

  appendAuditEvent(event: Omit<StoredAuditEvent, "id" | "createdAt">): StoredAuditEvent {
    const record: StoredAuditEvent = { ...event, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#db.prepare(`
      INSERT INTO audit_events
        (id, principal_id, workspace_id, role, auth_method, request_id, idempotency_key,
         codex_thread_id, codex_turn_id, codex_call_id, action, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.principalId, record.workspaceId, record.role, record.authMethod, record.requestId,
      record.idempotencyKey ?? null, record.codexThreadId ?? null, record.codexTurnId ?? null,
      record.codexCallId ?? null, record.action, JSON.stringify(record.payload), record.createdAt
    );
    return record;
  }

  /**
   * Changes whenever anything is written to the ledger, by this connection (`total_changes()`) or any other (`data_version`, e.g. the
   * worker): two reads, for caching what is derived from the ledger until it changes.
   */
  changeToken(): string {
    const dataVersion = this.#db.pragma("data_version", { simple: true });
    const ownChanges = this.#db.prepare("SELECT total_changes()").pluck().get();
    return `${String(dataVersion)}:${String(ownChanges)}`;
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * What the person's own files said about dates, from the newest batch whether or not it has been confirmed yet (a milestone chain should
 * not wait on the calendar import), with each item tied to a project id. `dates` carry a day; `undated` are things a file lists but marks
 * TBD, kept so the part they belong to is not lost. An item with no project cannot belong to any project's chain and is left out.
 */
export function latestFileDates(store: CrosslineStore, workspaceId: string): {
  dates: Array<{ project: string; kind: string; date: string; title: string }>;
  undated: Array<{ project: string; kind: string; title: string }>;
} {
  const batch = [...store.listEvents(workspaceId, { type: "dates.extracted" })].reverse()
    .find((event) => !store.listEvents(workspaceId, { type: "dates.decided", entityId: event.entityId }).some((decision) => (decision.payload as { superseded?: boolean }).superseded));
  const payload = batch?.payload as { dates?: Array<{ project?: string; kind?: string; date?: string; title?: string }>; undated?: Array<{ project?: string; kind?: string; title?: string }> } | undefined;
  // The model names a project by id when it can and by its name when it cannot; both are resolved to the id the milestones use.
  const projects = store.listProjects(workspaceId);
  const resolve = (name: string) => (projects.find((project) => project.id === name)
    ?? projects.find((project) => project.name.toLowerCase() === name.toLowerCase())
    ?? projects.find((project) => name.toLowerCase().includes(project.name.toLowerCase()) || project.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(project.id.toLowerCase())))?.id;
  const dates = (payload?.dates ?? []).flatMap((entry) => {
    const project = entry.project ? resolve(entry.project) : undefined;
    return project && entry.kind && entry.date && entry.title ? [{ project, kind: entry.kind, date: entry.date, title: entry.title }] : [];
  }).slice(0, 80);
  const undated = (payload?.undated ?? []).flatMap((entry) => {
    const project = entry.project ? resolve(entry.project) : undefined;
    return project && entry.kind && entry.title ? [{ project, kind: entry.kind, title: entry.title }] : [];
  }).slice(0, 20);
  return { dates, undated };
}
export * from "./agent";
export * from "./interview";
export * from "./file-belonging";
export * from "./push";
export * from "./artifacts";
export * from "./portrait";
export * from "./skills";
export * from "./invites";
export * from "./evidence-backfill";
export * from "./onboarding-extract";
export * from "./records";
export * from "./automations";
export * from "./mail-replies";
export * from "./own-completion";
export * from "./preparation";
export * from "./lessons";
