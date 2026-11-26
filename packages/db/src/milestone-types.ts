import type { SuccessCriterion, MilestoneTemplateKind, EvidenceQuestionTemplate, MilestoneTemplateSource } from "@crossline/core";

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

export type StoredMilestoneAnchor = {
  workspaceId: string; milestoneId: string; stage: number; deadline: string; baseline: string; target: string;
  stakeholders: string[]; sourceFactIds: string[]; dependsOn: string[]; updatedAt: string;
  /**
   * Artifact ids (`StoredArtifactPlan`) this milestone produces for other lines and the ones it uses from them; the cross-line relations
   * are derived from these. Always present when read; left out of a save, the stored ones are kept.
   */
  outputs?: string[]; inputs?: string[];
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

export type RelationExtras = "evidence" | "counterexample" | "costMinutes" | "lastValidatedAt" | "explanation" | "refutedWhen"
  | "artifactId" | "transfer" | "checkOn" | "counterfactual";
