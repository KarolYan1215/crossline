export * from "./access-context";
export * from "./availability";
export * from "./importance";
export * from "./analysis";
export * from "./assistant-schema";
export * from "./background-facts-schema";
export * from "./capacity";
export * from "./cost";
export * from "./estimate";
export * from "./flywheel";
export * from "./flywheel-schema";
export * from "./agent-history";
export * from "./materials-schema";
export * from "./milestone-gate-schema";
export * from "./milestone-templates";
export * from "./milestone-plan";
export * from "./milestone-risk";
export * from "./artifact-plan";
export * from "./onboarding-turn-schema";
export * from "./line-attributes";
export * from "./profile-gaps";
export * from "./agent-guard";
export * from "./agent-summary";
export * from "./agent-dispatch";
export * from "./agent-failure";
export * from "./source-kinds";
export * from "./date-schema";
export * from "./diligence-schema";
export * from "./manualbook-schema";
export * from "./activity-state";
export * from "./plan-explainer-schema";
export * from "./reality";
export * from "./replay";
export * from "./weekly-insight-schema";
export * from "./structured-output";
export * from "./text-hygiene";
export * from "./rhythm";
export * from "./backplan-schema";
export * from "./external-action";
export * from "./settings-keys";
export * from "./milestone-drafting";
export * from "./auto-approval";
export * from "./calibration";
export * from "./telemetry";
export * from "./effectiveness";
export * from "./plan-churn";
export * from "./interview-quota";
export * from "./sponsor";
import type { EvidenceQuestionTemplate } from "./milestone-templates";
export type EnergyLevel = "low" | "medium" | "high";

export type Estimate = {
  p25Minutes: number;
  p50Minutes: number;
  p85Minutes: number;
  // `legacy_task` marks a number carried over from a v1 row: real, but never a prior anyone authored.
  // `manual` marks one a person typed in directly, bypassing analysis entirely (see `promoteCaptureManually`).
  source: "identity_prior" | "llm_prior" | "personal_history" | "legacy_task" | "manual";
  observationCount: number;
  confidence: "low" | "medium" | "high";
  /**
   * How a model's guess relates to this person's record (`calibratedEstimate`): `applied` — the numbers above are
   * the corrected ones and `raw` is what the analysis wrote; `learning` — the raw numbers are used because the
   * correction has not yet beaten them in a backtest, and `needed` more finished tasks are required before it can.
   */
  calibration?: { factor: number; basedOn: number; state?: "applied" | "learning"; needed?: number;
    raw?: { p50Minutes: number; p85Minutes: number } };
};

export type Evidence = {
  id: string;
  kind: "file" | "link" | "record" | "telemetry";
  uri: string;
};

/** One answer to a pre-generated `EvidenceQuestionTemplate` — `answer` is the option label for a
 * checkbox question, or the typed text for a text one; the Skill-facing shape is flattened to
 * `"Q: <prompt> A: <answer>"` text at gate time (`milestone-gate-runner.ts`), not kept structured there,
 * because the gate's quoting rule only ever operates on plain evidence text. */
export type ChecklistAnswer = { questionId: string; answer: string };

// A milestone states up front what would count as reaching it. `judgement` is the honest exit for
// things that genuinely cannot be counted, but it must say what evidence would FAIL it — otherwise a
// milestone can never be objectively judged short, and the gate becomes a rubber stamp.
export type SuccessCriterion = {
  id: string;
  statement: string;
  required: boolean;
  /**
   * Whether this criterion measures something you produced, or something that actually changed.
   *
   * This exists because the easy criterion to write is always an output — "a summary file exists",
   * "three items are listed" — and a gate judging only outputs passes a milestone that has not moved.
   * That is Goodhart's law arriving on schedule: the artifact becomes the target and stops being
   * evidence of anything.
   *
   * Which side a criterion falls on is a judgement, so it is declared here and reviewed by the user,
   * never computed. Optional because criteria written before this field existed have no honest answer
   * and are shown as unlabelled rather than guessed at.
   */
  evidenceOf?: "output" | "outcome";
  measure:
    | { kind: "count"; unit: string; atLeast: number }
    | { kind: "artifact"; mustExist: string }
    /**
     * `bareLine` is the value that only just reaches the outcome the person wants, worked out backwards from that outcome; `value` is the
     * line actually set, with a margin beyond it. Absent on criteria written before this existed, and on the hand-edited ones.
     */
    | { kind: "threshold"; unit: string; comparator: "gte" | "lte"; value: number; bareLine?: number }
    | { kind: "judgement"; rubric: string; failsWhen: string };
};

export type MilestoneGateResult = {
  /** `partial`: the contract is covered but the delivery breaks the person's own line skill (`fit.violated` says which rules). */
  verdict: "pass" | "partial" | "insufficient" | "refuted";
  criteriaVerdict: Array<{
    criterionId: string;
    met: "met" | "partial" | "unmet" | "unverifiable";
    observed: string;
    evidenceQuote: string;
    shortfall: string | null;
  }>;
  contractCoverage: Array<{ requirement: string; satisfiedBy: string | null; reasoning: string; quote: string }>;
  unplannedGains: Array<{ finding: string; evidenceQuote: string; mayEnable: string[] }>;
  improvements: Array<{ area: "evidence" | "method" | "scope" | "pace"; observation: string; suggestion: string }>;
  incomplete: Array<{ what: string; blocksWhich: string[]; isBlockingPass: boolean }>;
  flywheelAssessment: Array<{
    relationId: string;
    targetMilestoneId: string;
    targetIdentityId: string;
    supports: "advances" | "neutral" | "contradicts";
    whatIsNowPossible: string;
    whatIsStillMissing: string;
    evidenceQuote: string;
  }>;
  gaps: Array<{ code: string; whatWouldSatisfyIt: string }>;
  proposedNextMilestones: unknown[];
  blockers: Array<{ code: string; message: string }>;
  /** Against the person's line skill. Absent on judgements made before it existed, which read as fitting. */
  fit?: { fits: boolean; violated: string[]; why: string };
};

/**
 * The requirements `pass` is measured against: an item counts unless it says `required: false`. Items the
 * analysis marked optional are still shown and still judged, but cannot hold back the verdict — the gate
 * used to demand every listed item while the page labelled most of them 「（可选）」, so the label and the
 * bar disagreed. A contract written before the flag existed (or by hand) has no `required`, and fails
 * closed: it is required.
 *
 * A contract in which **every** item is explicitly optional is the shape older analyses produced (the
 * Skill was never told what `required` meant). Taken literally it would leave the gate nothing to check
 * and let an empty report pass, so such a contract is held to all of its items, as it always was. New
 * analyses cannot produce it: `validateAnalysisProposal` refuses an evidence contract with no required item.
 */
export function requiredContractRequirements(
  contract: Array<{ description?: string; kind?: string; required?: boolean }> | undefined
): string[] {
  const label = (item: { description?: string; kind?: string }) => (item.description ?? item.kind ?? "").trim();
  const items = contract ?? [];
  const required = items.filter((item) => item.required !== false);
  return (required.length ? required : items).map(label).filter(Boolean);
}

export function validateMilestoneGateResult(
  result: MilestoneGateResult,
  criteria: SuccessCriterion[],
  evidenceTexts: string[],
  /**
   * The work order's own `evidenceContract` requirements (the required ones — see
   * `requiredContractRequirements`), verbatim. This is what `pass` is measured against, so it
   * has to be supplied: without it the check degenerated into `contractCoverage.every(...)`, which an
   * empty array satisfies — a gate that accepted anything simply by reporting nothing.
   */
  contractRequirements: string[] = [],
  /** Whether the gate was given the person's line skill. Without one there is nothing to break, so `fit.fits` must be true. */
  hasMineSkill = false
): MilestoneGateResult {
  const ids = criteria.map((criterion) => criterion.id);
  const verdictIds = result.criteriaVerdict.map((item) => item.criterionId);
  // A quote backs a positive claim. Saying a criterion is `unmet` or `unverifiable` is a statement
  // about what the evidence does NOT contain, and demanding a verbatim quote for that left the model
  // one move: quote something unrelated, or fail. Now that an unmet milestone criterion is the normal
  // case — a milestone spans many work orders — that was a standing invitation to fabricate.
  const claimsEvidence = (met: string) => met === "met" || met === "partial";
  const quotes = [
    ...result.criteriaVerdict.filter((item) => claimsEvidence(item.met)).map((item) => item.evidenceQuote),
    ...result.contractCoverage.filter((item) => item.satisfiedBy).map((item) => item.quote),
    ...result.unplannedGains.map((item) => item.evidenceQuote),
    ...result.flywheelAssessment.map((item) => item.evidenceQuote)
  ];
  const complete = verdictIds.length === ids.length && new Set(verdictIds).size === ids.length
    && ids.every((id) => verdictIds.includes(id));
  // What `pass` means: this work order delivered what it promised. It used to mean the whole milestone
  // was met — every required measured criterion of the milestone `met` by this one submission — and on
  // a real ledger that is almost never true, because a milestone spans many work orders. The effect was
  // that doing the work correctly and submitting real evidence returned 「证据不足」 and blocked the
  // order. The milestone's own criteria are still judged, every one of them, and kept as the progress
  // record; they are just not the bar for accepting one piece of work.
  //
  // Measured against the requirements the order actually declared, matched on the exact requirement
  // string. A paraphrased or missing requirement fails closed, which is the right direction: the Skill
  // is handed these strings and told to copy them back.
  const declared = contractRequirements.map((requirement) => requirement.trim()).filter(Boolean);
  const satisfied = new Set(result.contractCoverage
    .filter((item) => item.satisfiedBy)
    .map((item) => item.requirement.trim()));
  const contractCovered = declared.every((requirement) => satisfied.has(requirement));
  const contractHolds = complete && contractCovered
    && !result.incomplete.some((item) => item.isBlockingPass)
    && result.blockers.length === 0;
  // The person's own play is part of the bar (decided 2026-10-14): a delivery that does what the contract says but not the way this
  // person does it — a research-report note on a line whose play is conflict and a sold solution — is sent back as `partial`.
  const fit = result.fit ?? { fits: true, violated: [], why: "" };
  const fits = fit.fits !== false;
  const mayPass = contractHolds && fits;
  // Verbatim in content, not in markup: evidence can be Markdown (what the assistant delivers), and a quote copied out of a bold phrase
  // or a table cell drops the `**` and `|` around it. Formatting marks and runs of whitespace are ignored on both sides; the words are not.
  const plain = (text: string) => text.replace(/[*_`#>|]+/g, "").replace(/\s+/g, " ").trim();
  const evidencePlain = evidenceTexts.map(plain);
  const quoteIsExact = (quote: string) => plain(quote).length > 0 && evidencePlain.some((text) => text.includes(plain(quote)));
  // Which rule broke, said back to the Skill as the repair's detail (and to the person if the repairs run out). A bare code gave the
  // model nothing to correct, and both repairs of a real judgement were spent on it (2026-10-14).
  const problem = !complete
    ? `每条达成标准恰好一条判定：缺 ${ids.filter((id) => !verdictIds.includes(id)).join("、") || "无"}${verdictIds.filter((id) => !ids.includes(id)).length ? `，多出 ${verdictIds.filter((id) => !ids.includes(id)).join("、")}` : ""}`
    : quotes.find((quote) => !quoteIsExact(quote)) !== undefined
      ? `这句引文在证据里找不到，须逐字摘自证据：「${(quotes.find((quote) => !quoteIsExact(quote)) ?? "").slice(0, 120)}」`
      : !hasMineSkill && !fits ? "没有给出本人的主线 skill，无规则可违背：fit.fits 应为 true、violated 为空"
      : !fits && !fit.violated.some((rule) => rule.trim()) ? "fit.fits 为 false 时，violated 须逐条写明违背了主线 skill 的哪条规则"
      : (result.verdict === "pass") !== mayPass
        ? mayPass ? "契约要求都已覆盖、没有阻塞项且符合本人主线 skill，verdict 应为 pass"
          : contractHolds ? `契约已覆盖，但不符合本人主线 skill（${fit.violated.join("；").slice(0, 200)}），verdict 应为 partial`
          : `verdict 为 pass，但${!contractCovered ? `这些要求未标出 satisfiedBy：${declared.filter((requirement) => !satisfied.has(requirement)).join("；")}` : "存在阻塞通过的未完成项或 blockers"}`
        : result.verdict === "partial" && !(contractHolds && !fits)
          ? contractHolds ? "契约已覆盖且符合主线 skill 时不是 partial" : "partial 只用于契约已覆盖、但违背本人主线 skill 的交付；契约未覆盖时用 insufficient"
        : contractHolds && !fits && result.verdict === "insufficient"
          ? `契约已覆盖，只是不符合本人主线 skill，verdict 应为 partial 而不是 insufficient`
        : "";
  if (problem) throw Object.assign(new Error("GATE_VERDICT_INCONSISTENT"), { detail: problem });
  return result;
}

export function validateSuccessCriteria(criteria: SuccessCriterion[]):
  | { ok: true; verifiability: "measurable" | "judgement_only" }
  | { ok: false; blocker: { code: string; message: string } } {
  if (!criteria.length) {
    return { ok: false, blocker: { code: "MILESTONE_NEEDS_CRITERIA", message: "里程碑必须声明至少一条达成标准" } };
  }
  for (const criterion of criteria) {
    if (!criterion.statement.trim()) {
      return { ok: false, blocker: { code: "CRITERION_EMPTY", message: "达成标准不能为空" } };
    }
    // "做得好" is not a standard; "没有给出任何反例检验" is.
    if (criterion.measure.kind === "judgement" && !criterion.measure.failsWhen.trim()) {
      return { ok: false, blocker: { code: "CRITERION_NOT_FALSIFIABLE", message: "判断型标准必须写明什么情况下判不过" } };
    }
  }
  const measurable = criteria.some((criterion) => criterion.measure.kind !== "judgement");
  return { ok: true, verifiability: measurable ? "measurable" : "judgement_only" };
}

/**
 * Whether anything here measures a real change rather than a document that now exists.
 *
 * Deliberately a warning and not a rule: the criteria belong to the user, and a system that refused to
 * save a milestone because it disagreed about what counts would be overriding the person it works for.
 * Surfaced wherever criteria are shown, so "all outputs" is visible rather than discovered later when
 * the gate passes something that never moved.
 */
export function criteriaCoverOutcome(criteria: SuccessCriterion[]): boolean {
  return criteria.some((criterion) => criterion.evidenceOf === "outcome");
}

export type WorkOrderState =
  | "captured"
  | "analyzing"
  | "awaiting_plan_approval"
  | "approved"
  | "preparing"
  | "ready_for_human"
  | "active"
  | "evidence_review"
  | "accepted"
  | "blocked"
  | "archived";

export type WorkOrder = {
  id: string;
  ownerId: string;
  workspaceId: string;
  identityId: string;
  projectId: string;
  milestoneId: string;
  intent: string;
  automationParts: Array<{ id: string; intent: string; reversibility: "local" | "external" }>;
  humanCore: Array<{ id: string; intent: string; energy: EnergyLevel; interruptible: boolean }>;
  // `why` is separate from `description` on purpose: without a slot for the reason, every real run
  // packed the reason into the description until it hit the length cap and was cut off.
  materialContract: Array<{ kind: Evidence["kind"]; description: string; why: string; required: boolean }>;
  evidenceContract: Array<{ kind: Evidence["kind"]; description: string; why: string; required: boolean }>;
  // Instantiated once, at `plan.approved`, from the bound milestone's own `evidenceQuestionBank` — see
  // `packages/db/src/index.ts`'s `transitionWorkOrder`. Absent or empty is normal: a milestone with no
  // template behind it, or no template-derived question bank, simply has nothing to pre-generate here,
  // and free-text/file evidence stays available regardless.
  evidenceChecklist?: EvidenceQuestionTemplate[];
  estimate: Estimate;
  // Groups this proposal into a reference class for duration calibration, independent of `identityId` —
  // "research paper reading" and "research deep writing" take wildly different real time, and lumping
  // them under one identity-wide statistic would blur exactly the distinction personal history exists
  // to capture. Reuses `packages/identity-packs`' own `durationPriors` vocabulary rather than a second one.
  family: "preparation" | "review" | "deep_work";
  riskTier: "routine" | "milestone" | "high_risk";
  state: WorkOrderState;
  // A recurring commitment can be honoured at its minimum size; skipping it needs a written reason.
  recurrence?: { fullMinutes: number; minimumMinutes: number };
  // Removal keeps a tombstone: the ledger never loses why something disappeared.
  tombstone?: { reason: string; createdAt: string };
};

export type WorkOrderEvent =
  | { type: "analysis.proposed"; proposalId: string }
  | { type: "analysis.accepted"; approvalId: string }
  | { type: "plan.approved"; approvalId: string }
  // Takes back an approval that nobody clicked (a default-effective one), before any work began.
  | { type: "approval.revoked"; reason: string }
  | { type: "automation.started" }
  | { type: "materials.ready" }
  | { type: "materials.not_required" }
  | { type: "human.started" }
  | { type: "human.completed" }
  // The assistant did the whole order (whole-task delegation) and hands in its files as the evidence.
  | { type: "agent.delivered"; taskId: string }
  // `onCompletion`: the person pressed 完成 and that is the acceptance (decided 2026-10-15, `completion.ts`); no evidence is required.
  | { type: "evidence.accepted"; approvalId?: string; onCompletion?: boolean }
  | { type: "acceptance.revoked"; reason: string }
  | { type: "blocked"; reason: string }
  | { type: "archived" }
  // Takes an archived order back to where it was when it was archived (an undo, or 恢复 in the archive drawer).
  | { type: "archive.restored"; to: WorkOrderState };

/** States an archived order may be restored to: anything but the transient ones. A session that was running when the order was
 * archived ended with it, so `active` comes back as `ready_for_human`; `preparing` and `analyzing` were runs, not resting places. */
export const RESTORABLE_STATES: readonly WorkOrderState[] = ["awaiting_plan_approval", "approved", "ready_for_human", "evidence_review", "accepted", "blocked"];
export function restoreTargetOf(from: string | undefined): WorkOrderState {
  if (from === "active") return "ready_for_human";
  if (from === "preparing") return "approved";
  return RESTORABLE_STATES.includes(from as WorkOrderState) ? from as WorkOrderState : "awaiting_plan_approval";
}

const WORK_ORDER_TRANSITIONS: Partial<Record<WorkOrderState, Partial<Record<WorkOrderEvent["type"], WorkOrderState>>>> = {
  captured: { "analysis.proposed": "analyzing", archived: "archived" },
  analyzing: { "analysis.accepted": "awaiting_plan_approval", blocked: "blocked", archived: "archived" },
  awaiting_plan_approval: { "plan.approved": "approved", blocked: "blocked", archived: "archived" },
  // `materials.not_required` records that nothing had to be prepared instead of pretending an AI
  // preparation run happened. The empty-material-contract precondition is enforced by the caller
  // (`startWorkOrderExecution`), not here — this table only knows about states.
  approved: { "automation.started": "preparing", "materials.not_required": "ready_for_human", "approval.revoked": "awaiting_plan_approval", "agent.delivered": "evidence_review", blocked: "blocked", archived: "archived" },
  preparing: { "materials.ready": "ready_for_human", "approval.revoked": "awaiting_plan_approval", "agent.delivered": "evidence_review", blocked: "blocked", archived: "archived" },
  ready_for_human: { "human.started": "active", "approval.revoked": "awaiting_plan_approval", "agent.delivered": "evidence_review", blocked: "blocked", archived: "archived" },
  active: { "human.completed": "evidence_review", blocked: "blocked", archived: "archived" },
  evidence_review: { "evidence.accepted": "accepted", blocked: "blocked", archived: "archived" },
  blocked: { "plan.approved": "approved", archived: "archived" },
  accepted: { "acceptance.revoked": "evidence_review", archived: "archived" }
};

export function advanceWorkOrder<T extends { state: WorkOrderState }>(workOrder: T, event: WorkOrderEvent):
  | { ok: true; workOrder: T; from: WorkOrderState; to: WorkOrderState }
  | { ok: false; blocker: { code: "INVALID_WORK_ORDER_TRANSITION"; message: string } } {
  const next = event.type === "archive.restored"
    ? (workOrder.state === "archived" && RESTORABLE_STATES.includes(event.to) ? event.to : undefined)
    : WORK_ORDER_TRANSITIONS[workOrder.state]?.[event.type];
  if (!next) {
    return {
      ok: false,
      blocker: {
        code: "INVALID_WORK_ORDER_TRANSITION",
        message: `不能从 ${workOrder.state} 通过 ${event.type} 转换状态`
      }
    };
  }
  return { ok: true, workOrder: { ...workOrder, state: next }, from: workOrder.state, to: next };
}

type BlockedResult = { ok: false; blocker: { code: string; message: string } };

/** A milestone-bound WorkOrder cannot be accepted on an empty evidence set. */
export function evidenceRequiredFor(workOrder: Pick<WorkOrder, "milestoneId">): boolean {
  return Boolean(workOrder.milestoneId);
}

/**
 * Every action this policy knows about, and the tier it gets.
 *
 * A closed table, not a chain of `includes` with a fall-through. The old shape answered `"automatic"`
 * for anything it did not recognise, which meant one typo at a call site — `publish_contents` — turned
 * the strictest tier into the weakest one, silently, in the function the whole codebase is told to
 * defer to. Nothing caught it because the parameter was `string`. Now an unknown name does not
 * type-check, and if one reaches here at runtime it is refused rather than waved through.
 */
const APPROVAL_TIERS = {
  // Permanently off by design; see the safety boundaries in CLAUDE.md.
  broker_order: "never",
  silent_source_calendar_write: "never",

  send_outreach_email: "per_item",
  publish_content: "per_item",
  research_submission: "per_item",
  high_risk_external_use: "per_item",

  // Candidate relations are reviewed together in the weekly pass, so batch is the honest mode: they
  // are cheap individually and only mean anything compared against each other.
  approve_milestones: "batch",
  // Work-order proposals can be approved together (「全部批准」); any proposal takes effect by itself with a
  // 24-hour undo unless it is the person's own choice, needs a login or permission, acts outside the machine,
  // or was taken back before (see `autoApprovalEligible`). Milestones and targets stay a click each.
  approve_work_orders: "batch",
  auto_approve_internal_order: "automatic",
  approve_milestone_relations: "batch",
  // The approved plan's own blocks follow it onto the calendar named Crossline without a click — the person's
  // choice (2026-10-06). What may be written did not move: only that calendar, only events this app made and
  // the person has not changed, deletes only in the future, previews never. See CLAUDE.md, Safety boundaries.
  write_focus_block: "automatic",
  // Dates read out of the person's own files, confirmed as one batch. Never automatic: a wrong date on a
  // calendar is worse than a missing one, so the person sees every item with its quote first.
  import_dated_items: "batch",
  // Saving the full text of a page the model found: only from an open-access host on the short list in
  // `openAccessVerdict`; any other page keeps its link and summary, and keeping its text is never permitted.
  download_open_access: "automatic",
  download_other: "never",

  // Reads. Listed rather than left to a default, because being a read is the reason, and a reason that
  // lives in a fall-through is a reason nobody can check.
  read_sync: "automatic"
} as const satisfies Record<string, "automatic" | "batch" | "per_item" | "never">;

export type ApprovalAction = keyof typeof APPROVAL_TIERS;

export function requiredApproval(action: ApprovalAction): "automatic" | "batch" | "per_item" | "never" {
  // Fail closed. An action that is not in the table is not known to be safe.
  return APPROVAL_TIERS[action] ?? "per_item";
}

export function budgetPolicy(_usedPercent: number): {
  mode: "normal" | "economy" | "manual_core_only";
  warning: boolean;
} {
  if (_usedPercent >= 100) return { mode: "manual_core_only", warning: true };
  if (_usedPercent >= 85) return { mode: "economy", warning: true };
  return { mode: "normal", warning: _usedPercent >= 70 };
}

export type CommandEnvelope = {
  ownerId: string;
  workspaceId: string;
  clientCommandId: string;
  clientSequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export function validateCommandEnvelope(value: unknown):
  | { ok: true; command: CommandEnvelope }
  | { ok: false; blocker: { code: "INVALID_COMMAND_ENVELOPE"; message: string } } {
  if (!value || typeof value !== "object") {
    return { ok: false, blocker: { code: "INVALID_COMMAND_ENVELOPE", message: "离线命令缺少必填字段" } };
  }
  const candidate = value as Record<string, unknown>;
  const valid =
    typeof candidate.ownerId === "string" && candidate.ownerId.length > 0 &&
    typeof candidate.workspaceId === "string" && candidate.workspaceId.length > 0 &&
    typeof candidate.clientCommandId === "string" && candidate.clientCommandId.length > 0 &&
    Number.isInteger(candidate.clientSequence) && Number(candidate.clientSequence) >= 0 &&
    typeof candidate.type === "string" && candidate.type.length > 0 &&
    Object.hasOwn(candidate, "payload") &&
    typeof candidate.createdAt === "string" && !Number.isNaN(Date.parse(candidate.createdAt));
  if (!valid) {
    return { ok: false, blocker: { code: "INVALID_COMMAND_ENVELOPE", message: "离线命令缺少必填字段" } };
  }
  return { ok: true, command: candidate as CommandEnvelope };
}
export * from "./asks";
export * from "./archetypes";
export * from "./steps";
export * from "./concierge";
export * from "./nudges";
export * from "./granularity";
export * from "./energy-model";
export * from "./efficiency";
export * from "./energy-covariates";
export * from "./camera-signals";
export * from "./relevance";
export * from "./task-title";
export * from "./calendar-lines";
export * from "./belonging";
export * from "./sentences";
export * from "./onboarding-refs";
export * from "./interview-checklist";
export * from "./fixed-events";
export * from "./portrait";
export * from "./portrait-type";
export * from "./assess";
export * from "./assess-link";
export * from "./energy-rhythm";
export * from "./energy-advice";
export * from "./schedule-frozen";
export * from "./calendar-apps";
export * from "./onboarding-attention";
export * from "./portrait-say-do";
export * from "./background";
export * from "./mine-skill";
export * from "./public-skills";
export * from "./workflows";
export * from "./ai-tools";
export * from "./provider-conformance";
export * from "./local-stamp";
export * from "./onboarding-progress";
export * from "./calendar-subscriptions";
export * from "./source-folders";
export * from "./info-request";
export * from "./tutorial-worth";
export * from "./completion";
export * from "./task-merge";
export * from "./plain-voice";
