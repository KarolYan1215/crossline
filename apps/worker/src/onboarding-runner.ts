import { randomUUID } from "node:crypto";
import {
  ONBOARDING_OUTPUT_SCHEMA, validateOnboardingProposal,
  type OnboardingContext, type OnboardingProposal
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import type { CrosslineStore } from "@crossline/db";

const OWNER_ID = "local-owner";
export const ONBOARDING_SKILL = "crossline:crossline-onboarding";

const INSTRUCTIONS = "Turn the supplied interview answers into milestone proposals for a brand-new "
  + "Crossline user. Every proposal needs sourceRefs naming the answer id(s) it is actually grounded in "
  + "— never invent a reason not present in the answers. A milestone is a state of the world the user "
  + "could argue they had reached, not a task, and at least one criterion per milestone must have "
  + "evidenceOf=\"outcome\". If the answers are too thin to ground even one checkable milestone, return "
  + "a blocker naming what is missing rather than guessing.";

export type OnboardingOutcome =
  | { state: "proposed"; drafts: Array<{ id: string; identityId: string; title: string }> }
  | { state: "blocked"; code: string; message: string };

export function buildOnboardingContext(store: CrosslineStore, workspaceId: string,
  answers: Array<{ question: string; answer: string }>): OnboardingContext {
  return {
    version: "crossline.onboarding.v1",
    answers: answers.map((item, index) => ({ id: `answer-${index}`, question: item.question, answer: item.answer })),
    identities: defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label })),
    existingMilestones: store.listMilestones(workspaceId).map((milestone) =>
      ({ id: milestone.id, identityId: milestone.identityId, title: milestone.title, status: milestone.status }))
  };
}

/**
 * The first-login interview, turned into milestone drafts through the exact same propose-then-approve
 * path `crossline-milestone-architect` uses — this is not a second write path, just a different prompt
 * and a different front door (a short Q&A instead of one free-text box).
 */
export function createOnboardingProposer(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function propose(answers: Array<{ question: string; answer: string }>, signal?: AbortSignal): Promise<OnboardingOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const context = buildOnboardingContext(store, workspaceId, answers);
    if (!context.answers.some((item) => item.answer.trim())) {
      return { state: "blocked", code: "ONBOARDING_NO_INPUT", message: "还没有填写任何访谈回答。" };
    }

    const result = await runCodexSkill<OnboardingProposal>(client, context, {
      skillName: ONBOARDING_SKILL,
      cwd,
      developerInstructions: INSTRUCTIONS,
      outputSchema: ONBOARDING_OUTPUT_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateOnboardingProposal(output, context),
      onAudit: () => {},
      ...(signal ? { signal } : {}),
      timeoutMs: 10 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    const drafts: Array<{ id: string; identityId: string; title: string }> = [];
    for (const proposal of result.output.milestoneProposals) {
      const id = `proposed-${randomUUID()}`;
      store.saveMilestone({
        id, ownerId: OWNER_ID, workspaceId,
        identityId: proposal.identityId, projectId: proposal.projectId,
        title: proposal.title, version: 1, status: "draft",
        successCriteria: proposal.successCriteria
      });
      store.appendEvent({
        ownerId: OWNER_ID, workspaceId, idempotencyKey: `onboarding:proposed:${id}`,
        type: "milestone.proposed", entityId: id,
        payload: { rationale: proposal.rationale, request: "onboarding-interview" }
      });
      drafts.push({ id, identityId: proposal.identityId, title: proposal.title });
    }
    return { state: "proposed", drafts };
  };
}
