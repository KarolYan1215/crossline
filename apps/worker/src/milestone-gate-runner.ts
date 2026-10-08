import {
  MILESTONE_GATE_OUTPUT_SCHEMA, requiredContractRequirements, validateMilestoneGateResult,
  type MilestoneGateContext, type MilestoneGateResult
} from "@crossline/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

import { ownerOf } from "./owner";
export const MILESTONE_GATE_SKILL = "crossline:crossline-milestone-gate";
// Enough of an artifact to judge, bounded so one large file cannot crowd out the rest of the evidence.
const ARTIFACT_TEXT_LIMIT = 40_000;

const INSTRUCTIONS = "Judge the submitted evidence. Return only the requested JSON. Every quote must be "
  + "copied verbatim from the supplied evidence text — never paraphrased, never invented. `verdict` "
  + "answers one question only: did this work order deliver what its evidenceContract promised? `pass` "
  + "is allowed exactly when every supplied evidenceContract requirement with required=true appears in "
  + "contractCoverage with a non-null satisfiedBy, nothing incomplete blocks passing, and there are no "
  + "blockers; requirements with required=false are still reported but never hold back pass. Copy "
  + "each requirement string back verbatim; a paraphrased or omitted requirement counts as uncovered. "
  + "Separately, judge every milestone criterion exactly once and report it honestly; a milestone spans "
  + "many work orders, so an unmet criterion is normal and is not a reason to withhold pass, and a "
  + "criterion must never be marked met to justify a verdict. Quote verbatim only for met or partial; "
  + "for unmet or unverifiable leave evidenceQuote empty and explain in observed and shortfall. Do not "
  + "modify criteria, do not perform missing work, and do not accept external effects.";

type GateOutcome =
  | { state: "accepted" | "held"; workOrderId: string; verdict: MilestoneGateResult["verdict"] }
  | { state: "blocked"; workOrderId: string; code: string; message: string };

export function buildMilestoneGateContext(store: CrosslineStore, workspaceId: string, workOrderId: string):
  { context: MilestoneGateContext; evidenceTexts: string[] } | { blocker: { code: string; message: string } } {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
  if (!order) return { blocker: { code: "WORK_ORDER_NOT_FOUND", message: "找不到该作业。" } };
  if (order.state !== "evidence_review") return { blocker: { code: "EVIDENCE_REVIEW_NOT_READY", message: "该作业不在证据审阅阶段。" } };
  const milestone = store.listMilestones(workspaceId).find((item) => item.id === order.milestoneId && item.status === "approved");
  if (!milestone) return { blocker: { code: "MILESTONE_NOT_FOUND", message: "找不到已批准的里程碑。" } };
  // A milestone with no stated criteria is judged all the same. `pass` has meant "this work order
  // delivered what its own evidenceContract promised" since the gate stopped requiring the whole
  // milestone to be met by one submission, so the refusal that used to sit here was a leftover of the old
  // meaning: it stopped every order bound to a starter milestone at the last step. The gate still invents
  // no standard — with no criteria there is simply no milestone progress to record, and the bar is the
  // order's own contract, which the person approved with the plan.

  const claims = store.listEvidenceClaims(workspaceId).filter((claim) => claim.workOrderId === workOrderId);
  const execution = store.listExecutions(workspaceId).find((item) => item.workOrderId === workOrderId);
  const relations = store.listMilestoneRelations(workspaceId)
    .filter((relation) => relation.fromMilestoneId === milestone.id && relation.status !== "archived");
  const milestonesById = new Map(store.listMilestones(workspaceId).map((item) => [item.id, item]));
  const requiredSet = new Set(requiredContractRequirements(
    (order.payload as { evidenceContract?: Array<{ description?: string; kind?: string; required?: boolean }> }).evidenceContract));
  const payload = order.payload as {
    evidenceContract?: Array<{ description?: string; kind?: string; required?: boolean }>;
    evidenceChecklist?: Array<{ id: string; prompt: string }>;
  };

  // Readable artifact text, as the Skill contract expects. Only materials this app wrote itself are
  // read: their paths come from the `materials` table, never from anything the model supplied.
  const artifacts: Array<{ id: string; kind: string; text: string }> = [];
  for (const material of store.listMaterials(workspaceId, workOrderId)) {
    if (!material.uri.startsWith("file://")) continue;
    try {
      artifacts.push({ id: material.id, kind: "artifact",
        text: readFileSync(fileURLToPath(material.uri), "utf8").slice(0, ARTIFACT_TEXT_LIMIT) });
    } catch { /* a material removed from disk simply cannot be quoted */ }
  }

  // A `kind:"file"` evidence claim's own `description` is just the label the person typed, not its
  // content — this reads the file itself so the gate can quote what is actually inside it. Only plain text
  // (`.txt`, and the Markdown/CSV/JSON an assistant hands in) is attempted: the upload route (`saveEvidenceFile`) also allows images and PDFs, and
  // neither can be turned into quotable text without OCR, which stays out of scope here (see 工作块 E) —
  // they still count as "a file was submitted", just not as something the gate can quote from.
  const fileEvidence: Array<{ id: string; kind: string; text: string }> = [];
  for (const claim of claims) {
    if (claim.kind !== "file" || !claim.uri.startsWith("file://") || !/\.(txt|md|markdown|csv|tsv|json)$/i.test(claim.uri)) continue;
    try {
      fileEvidence.push({ id: `${claim.id}:content`, kind: "file",
        text: readFileSync(fileURLToPath(claim.uri), "utf8").slice(0, ARTIFACT_TEXT_LIMIT) });
    } catch { /* a file removed from disk simply cannot be quoted */ }
  }

  // Pre-generated completion-time answers, flattened to quotable "Q: … A: …" text — see 工作块 E. The
  // question's own prompt comes from the order's own `evidenceChecklist`, not from the answer itself,
  // since `checklistAnswers` only ever carries `{questionId, answer}`.
  const checklistPrompts = new Map((payload.evidenceChecklist ?? []).map((question) => [question.id, question.prompt]));
  const checklistEvidence = (execution?.checklistAnswers ?? []).map((item) => ({
    id: `checklist:${item.questionId}`, kind: "record",
    text: `Q: ${checklistPrompts.get(item.questionId) ?? item.questionId} A: ${item.answer}`
  }));

  const evidenceClaims = [
    ...claims.map((claim) => ({ id: claim.id, kind: claim.kind, text: claim.description })),
    ...artifacts, ...fileEvidence, ...checklistEvidence
  ];
  // Exactly the strings the gate may quote. This same array goes to the Skill and to the validator: a
  // quote check against different text would prove nothing.
  const evidenceTexts = evidenceClaims.map((claim) => claim.text);

  return {
    evidenceTexts,
    context: {
      version: "crossline.milestone-gate.v1",
      milestone: {
        id: milestone.id, title: milestone.title, version: milestone.version,
        successCriteria: milestone.successCriteria
      },
      evidencePolicy: "tiered",
      evidenceClaims,
      // The same helper the write path uses, so the Skill is told exactly the bar `applyMilestoneGate` will
      // enforce — computing it twice let the two disagree on a legacy all-optional contract.
      evidenceContract: (payload.evidenceContract ?? [])
        .map((item) => (item.description ?? item.kind ?? "").trim())
        .filter(Boolean)
        .map((requirement) => ({ requirement, required: requiredSet.has(requirement) })),
      execution: {
        startedAt: execution?.startedAt ?? null,
        endedAt: execution?.endedAt ?? null,
        pauseMinutes: execution?.pauseMinutes ?? 0,
        interruptions: (execution?.interruptions ?? []).map((item) => ({ reason: item.reason }))
      },
      outgoingRelations: relations.map((relation) => ({
        id: relation.id,
        targetMilestoneId: relation.toMilestoneId,
        targetIdentityId: milestonesById.get(relation.toMilestoneId)?.identityId ?? "",
        kind: relation.kind,
        status: relation.status
      }))
    }
  };
}

/**
 * Runs the milestone gate for one WorkOrder sitting in `evidence_review`.
 *
 * A `pass` auto-accepts without asking, which is a deliberate decision — and the reason the checks
 * around it are strict: the verdict must be internally consistent, every quote must really appear in
 * the submitted evidence, the acceptance is revocable, and a relation the evidence contradicts is
 * refuted rather than quietly left standing. All of that lives in `applyMilestoneGate`.
 */
/** Keyed on how many refusals this order already has: a code-only key made the second identical refusal
 * (after a 「现在判定」 retry) a silent no-op, leaving the retry request as the last word and the page
 * saying 「等待」 again with no reason. */
function recordGateBlock(store: CrosslineStore, workspaceId: string, workOrderId: string,
  blocker: { code: string; message: string }): void {
  const attempt = store.listEvents(workspaceId, { type: "milestone_gate.blocked", entityId: workOrderId }).length;
  store.appendEvent({
    ownerId: ownerOf(store, workspaceId), workspaceId,
    idempotencyKey: `milestone-gate:blocked:${workOrderId}:${attempt}`,
    type: "milestone_gate.blocked", entityId: workOrderId, payload: blocker
  });
}

export function createMilestoneGate(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function judge(workOrderId: string): Promise<GateOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", workOrderId, code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };

    const built = buildMilestoneGateContext(store, workspaceId, workOrderId);
    if ("blocker" in built) {
      // Recorded like a failed run: this refusal (no criteria yet, no evidence) used to be returned to the
      // caller only, so the approvals page kept saying 「等待里程碑闸门」 for a verdict already given.
      recordGateBlock(store, workspaceId, workOrderId, built.blocker);
      return { state: "blocked", workOrderId, ...built.blocker };
    }
    const { context, evidenceTexts } = built;

    const result = await runCodexSkill<MilestoneGateResult>(client, context, {
      skillName: MILESTONE_GATE_SKILL,
      cwd,
      developerInstructions: INSTRUCTIONS,
      outputSchema: MILESTONE_GATE_OUTPUT_SCHEMA,
      prepareInput: () => context,
      // Quotes are checked against the submitted evidence before the verdict is allowed to mean
      // anything, so a fluent judgement built on invented text cannot accept the work.
      validateOutput: (output) => validateMilestoneGateResult(output as MilestoneGateResult,
        context.milestone.successCriteria, evidenceTexts,
        context.evidenceContract.filter((item) => item.required).map((item) => item.requirement)),
      onAudit: () => {},
      timeoutMs: 60 * 60_000
    });
    if (!result.ok) {
      // A gate that could not run (timeout, quota, runtime gone) leaves the order in `evidence_review`.
      // Recorded so the tick stops re-running it: judging is premium spend, and fifteen minutes later
      // with the same inputs would fail the same way. `pendingMilestoneGates` reopens it on request.
      recordGateBlock(store, workspaceId, workOrderId, result.blocker);
      return { state: "blocked", workOrderId, code: result.blocker.code, message: result.blocker.message };
    }

    // Keyed on the attempt, not just the milestone version. With only the version, a second judgement
    // of the same order — after the person added evidence and resubmitted — reused a spent key, the
    // transition became a no-op, and the order stayed in `evidence_review` while the ledger recorded
    // an acceptance that never happened.
    const attempt = store.listEvents(workspaceId, { type: "milestone_gate.judged", entityId: workOrderId }).length;
    // The identity pack's static prior for this order's `(identityId, family)` — the "zero-personal-
    // data" baseline `applyMilestoneGate` freezes onto the duration observation it records on a pass.
    // `undefined` for a pre-`family` order or an order whose identity has no matching pack; either way
    // `applyMilestoneGate` simply records no observation for this acceptance.
    const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    const family = (order?.payload as { family?: string } | undefined)?.family;
    const durationCalibrationBaseline = order && family
      ? (defaultIdentityPacks().find((pack) => pack.id === order.identityId) ?? defaultIdentityPacks()[0]!).durationPriors[family]
      : undefined;
    const applied = store.applyMilestoneGate(workspaceId, workOrderId, result.output, evidenceTexts,
      `milestone-gate:${workOrderId}:${context.milestone.version}:${attempt}`, durationCalibrationBaseline);
    return {
      state: applied.state === "accepted" ? "accepted" : "held",
      workOrderId,
      verdict: result.output.verdict
    };
  };
}

/** Every WorkOrder waiting on the milestone gate whose judging has not already failed. */
export function pendingMilestoneGates(store: CrosslineStore, workspaceId: string): string[] {
  // Same last-word-wins rule material preparation uses: a recorded failure closes the order to the
  // timer, and an explicit request from the person reopens it.
  const decided = new Map<string, "closed" | "retry">();
  for (const event of store.listEvents(workspaceId, {
    type: ["milestone_gate.blocked", "milestone_gate.auto_acceptance_revoked", "milestone_gate.retry_requested"]
  })) {
    // A revoked acceptance closes the order to the timer just as a failed run does. Without it the
    // gate re-judged the same unchanged evidence on the next tick, passed it again, and undid the
    // person's override — a revoke button that revokes for fifteen minutes is not a revoke button.
    if (event.type === "milestone_gate.blocked" || event.type === "milestone_gate.auto_acceptance_revoked") {
      decided.set(event.entityId, "closed");
    } else if (event.type === "milestone_gate.retry_requested") decided.set(event.entityId, "retry");
  }
  return store.listWorkOrders(workspaceId)
    .filter((order) => order.state === "evidence_review" && order.milestoneId && decided.get(order.id) !== "closed")
    .map((order) => order.id);
}
