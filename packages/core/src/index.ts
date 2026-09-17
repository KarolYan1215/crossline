export * from "./availability";
export * from "./analysis";
export * from "./capacity";
export * from "./cost";
export * from "./flywheel";
export * from "./flywheel-schema";
export * from "./materials-schema";
export * from "./milestone-gate-schema";
export * from "./reality";
export * from "./replay";
export type EnergyLevel = "low" | "medium" | "high";

export type Estimate = {
  p25Minutes: number;
  p50Minutes: number;
  p85Minutes: number;
  // `legacy_task` marks a number carried over from a v1 row: real, but never a prior anyone authored.
  source: "identity_prior" | "llm_prior" | "personal_history" | "legacy_task";
  observationCount: number;
  confidence: "low" | "medium" | "high";
};

export type Evidence = {
  id: string;
  kind: "file" | "link" | "record" | "telemetry";
  uri: string;
};

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
    | { kind: "threshold"; unit: string; comparator: "gte" | "lte"; value: number }
    | { kind: "judgement"; rubric: string; failsWhen: string };
};

export type MilestoneGateResult = {
  verdict: "pass" | "insufficient" | "refuted";
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
};

export function validateMilestoneGateResult(
  result: MilestoneGateResult,
  criteria: SuccessCriterion[],
  evidenceTexts: string[],
  /**
   * The work order's own `evidenceContract`, verbatim. This is what `pass` is measured against, so it
   * has to be supplied: without it the check degenerated into `contractCoverage.every(...)`, which an
   * empty array satisfies — a gate that accepted anything simply by reporting nothing.
   */
  contractRequirements: string[] = []
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
  const mayPass = complete && contractCovered
    && !result.incomplete.some((item) => item.isBlockingPass)
    && result.blockers.length === 0;
  const quoteIsExact = (quote: string) => quote.length > 0 && evidenceTexts.some((text) => text.includes(quote));
  if (!complete || quotes.some((quote) => !quoteIsExact(quote)) || (result.verdict === "pass") !== mayPass) {
    throw new Error("GATE_VERDICT_INCONSISTENT");
  }
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
  estimate: Estimate;
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
  | { type: "automation.started" }
  | { type: "materials.ready" }
  | { type: "materials.not_required" }
  | { type: "human.started" }
  | { type: "human.completed" }
  | { type: "evidence.accepted"; approvalId?: string }
  | { type: "acceptance.revoked"; reason: string }
  | { type: "blocked"; reason: string }
  | { type: "archived" };

const WORK_ORDER_TRANSITIONS: Partial<Record<WorkOrderState, Partial<Record<WorkOrderEvent["type"], WorkOrderState>>>> = {
  captured: { "analysis.proposed": "analyzing", archived: "archived" },
  analyzing: { "analysis.accepted": "awaiting_plan_approval", blocked: "blocked", archived: "archived" },
  awaiting_plan_approval: { "plan.approved": "approved", blocked: "blocked", archived: "archived" },
  // `materials.not_required` records that nothing had to be prepared instead of pretending an AI
  // preparation run happened. The empty-material-contract precondition is enforced by the caller
  // (`startWorkOrderExecution`), not here — this table only knows about states.
  approved: { "automation.started": "preparing", "materials.not_required": "ready_for_human", blocked: "blocked", archived: "archived" },
  preparing: { "materials.ready": "ready_for_human", blocked: "blocked", archived: "archived" },
  ready_for_human: { "human.started": "active", blocked: "blocked", archived: "archived" },
  active: { "human.completed": "evidence_review", blocked: "blocked", archived: "archived" },
  evidence_review: { "evidence.accepted": "accepted", blocked: "blocked", archived: "archived" },
  blocked: { "plan.approved": "approved", archived: "archived" },
  accepted: { "acceptance.revoked": "evidence_review", archived: "archived" }
};

export function advanceWorkOrder<T extends { state: WorkOrderState }>(workOrder: T, event: WorkOrderEvent):
  | { ok: true; workOrder: T; from: WorkOrderState; to: WorkOrderState }
  | { ok: false; blocker: { code: "INVALID_WORK_ORDER_TRANSITION"; message: string } } {
  const next = WORK_ORDER_TRANSITIONS[workOrder.state]?.[event.type];
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

export function skipRecurringWorkOrder<T extends Pick<WorkOrder, "recurrence">>(workOrder: T, reason: string):
  | BlockedResult
  | { ok: true; workOrder: T & { state: WorkOrderState }; reason: string } {
  if (!workOrder.recurrence) return { ok: false, blocker: { code: "NOT_RECURRING", message: "条目不是重复条目" } };
  if (!reason.trim()) return { ok: false, blocker: { code: "SKIP_REASON_REQUIRED", message: "跳过重复条目必须填写原因" } };
  return { ok: true, workOrder: { ...workOrder, state: "archived" as const }, reason: reason.trim() };
}

export function tombstoneWorkOrder<T extends object>(workOrder: T, reason: string):
  T & { state: WorkOrderState; tombstone: { reason: string; createdAt: string } } {
  return { ...workOrder, state: "archived", tombstone: { reason: reason.trim(), createdAt: new Date().toISOString() } };
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
  approve_milestone_relations: "batch",
  approve_plan_changes: "batch",
  write_focus_block: "batch",

  // Reads. Listed rather than left to a default, because being a read is the reason, and a reason that
  // lives in a fall-through is a reason nobody can check.
  read_sync: "automatic"
} as const satisfies Record<string, "automatic" | "batch" | "per_item" | "never">;

export type ApprovalAction = keyof typeof APPROVAL_TIERS;

export function requiredApproval(action: ApprovalAction): "automatic" | "batch" | "per_item" | "never" {
  // Fail closed. An action that is not in the table is not known to be safe.
  return APPROVAL_TIERS[action] ?? "per_item";
}

export function notificationForTransition(_from: string, _to: string, _entityId: string): {
  entityId: string;
  from: string;
  to: string;
  title: string;
} | null {
  if (_from === _to) return null;
  const titles: Record<string, string> = {
    blocked: "任务已阻塞",
    completed: "任务已完成",
    awaiting_approval: "任务等待审批",
    failed: "任务执行失败"
  };
  return {
    entityId: _entityId,
    from: _from,
    to: _to,
    title: titles[_to] ?? "任务状态已更新"
  };
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
