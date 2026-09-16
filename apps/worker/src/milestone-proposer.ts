import { randomUUID } from "node:crypto";
import {
  MILESTONE_PROPOSAL_SCHEMA, validateMilestoneProposal,
  type MilestoneProposal, type MilestoneProposalContext
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import type { CrosslineStore } from "@crossline/db";

const OWNER_ID = "local-owner";
export const MILESTONE_ARCHITECT_SKILL = "crossline:crossline-milestone-architect";

const INSTRUCTIONS = "Propose milestones for the supplied identities. Return only the requested JSON. "
  + "A milestone is a state of the world the user could argue they had reached, not a task. Each needs "
  + "two to four criteria, and at least one criterion must have evidenceOf=\"outcome\" — something that "
  + "changed, not something that now exists — because a milestone whose criteria are all outputs passes "
  + "on a productive afternoon of writing documents while the goal stands still. Do not invent numbers "
  + "the user never gave you: when the honest measure is a judgement, use a judgement measure and say in "
  + "failsWhen what would make it not met. Do not duplicate an existing milestone. If the input is too "
  + "vague to produce a checkable criterion, return a blocker naming what is missing.";

export type ProposalOutcome =
  | { state: "proposed"; drafts: Array<{ id: string; identityId: string; title: string }>; assumptions: string[] }
  | { state: "blocked"; code: string; message: string };

export function buildProposalContext(store: CrosslineStore, workspaceId: string, request: string): MilestoneProposalContext {
  const milestones = store.listMilestones(workspaceId);
  return {
    version: "crossline.milestone-proposal.v1",
    identities: defaultIdentityPacks()
      .filter((pack) => pack.kind === "identity")
      .map((pack) => ({ id: pack.id, label: pack.label, summary: pack.workflowTemplates.join(", ") })),
    // Drafts are included so the Skill does not re-propose something already waiting for a decision.
    existingMilestones: milestones.map((milestone) => ({
      id: milestone.id, identityId: milestone.identityId, title: milestone.title, status: milestone.status
    })),
    recentWork: store.listWorkOrders(workspaceId).slice(-20).map((order) => ({
      milestoneId: order.milestoneId ?? "", intent: order.intent, state: order.state
    })),
    request: request.slice(0, 2000)
  };
}

/**
 * Asks the architect Skill for new milestones and stores them as drafts.
 *
 * Drafts, never approved ones: analysis only offers approved milestones and the gate only judges
 * against them, so a draft is inert until the user says otherwise. A system that could approve its own
 * milestones would be choosing what the person is working towards, which is the one decision that
 * cannot be delegated here.
 */
export function createMilestoneProposer(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function propose(request: string, signal?: AbortSignal): Promise<ProposalOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };

    const context = buildProposalContext(store, workspaceId, request);
    if (!context.identities.length) {
      return { state: "blocked", code: "NO_IDENTITIES", message: "没有身份包，无法提议里程碑。" };
    }

    const result = await runCodexSkill<MilestoneProposal>(client, context, {
      skillName: MILESTONE_ARCHITECT_SKILL,
      cwd,
      developerInstructions: INSTRUCTIONS,
      outputSchema: MILESTONE_PROPOSAL_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateMilestoneProposal(output, context),
      onAudit: () => {},
      ...(signal ? { signal } : {}),
      timeoutMs: 10 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    const drafts: Array<{ id: string; identityId: string; title: string }> = [];
    for (const proposal of result.output.milestones) {
      const id = `proposed-${randomUUID()}`;
      store.saveMilestone({
        id, ownerId: OWNER_ID, workspaceId,
        identityId: proposal.identityId, projectId: proposal.projectId,
        title: proposal.title, version: 1, status: "draft",
        successCriteria: proposal.successCriteria
      });
      store.appendEvent({
        ownerId: OWNER_ID, workspaceId,
        idempotencyKey: `milestone:proposed:${id}`,
        type: "milestone.proposed", entityId: id,
        // The rationale is kept with the proposal: judging a milestone without knowing why it was
        // suggested is the same problem as approving a relation with no stated claim.
        payload: { rationale: proposal.rationale, request: context.request }
      });
      drafts.push({ id, identityId: proposal.identityId, title: proposal.title });
    }
    return { state: "proposed", drafts, assumptions: result.output.assumptions };
  };
}
