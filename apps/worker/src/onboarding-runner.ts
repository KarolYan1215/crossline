import { randomUUID } from "node:crypto";
import {
  ONBOARDING_OUTPUT_SCHEMA, validateOnboardingProposal,
  type OnboardingContext, type OnboardingProposal
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import type { CrosslineStore } from "@crossline/db";

const OWNER_ID = "local-owner";
export const ONBOARDING_SKILL = "crossline:crossline-onboarding";

const INSTRUCTIONS = "You are interviewing a brand-new Crossline user, one identity at a time. Pick the "
  + "first identity to focus on (set `focusIdentityId`), and before proposing anything for it, ask in "
  + "`reply` whatever you genuinely need to know to ground a *specific, business-linked* milestone — what "
  + "they are actually building, for whom, what a real outcome would look like, not a generic template. "
  + "Only include `milestoneProposals`/`relationProposals` for an identity once you have enough to be "
  + "concrete; an empty proposal list with a real follow-up question in `reply` is a normal turn, not a "
  + "failure. Once an identity has at least one grounded milestone, move `focusIdentityId` to the next "
  + "identity in your next turn's `reply` rather than staying stuck. A relation between two milestones "
  + "(same identity or crossing identities) is worth proposing whenever the interview surfaces a real "
  + "dependency or reuse, not only when directly asked. Every proposal needs sourceRefs naming the "
  + "answer/source id(s) it is actually grounded in — never invent a reason not present in what the user "
  + "told you. A milestone is a state of the world the user could argue they had reached, not a task, and "
  + "at least one criterion per milestone must have evidenceOf=\"outcome\". Set `allIdentitiesCovered` "
  + "true only once every identity has at least one grounded milestone or the user has said to skip it. "
  + "If the answers are too thin to ground even one checkable milestone for the very first identity, "
  + "return a blocker naming what is missing instead of guessing.";

export type OnboardingTurn =
  | {
    state: "asking" | "proposed"; reply: string; focusIdentityId: string | null; allIdentitiesCovered: boolean;
    drafts: Array<{ id: string; identityId: string; title: string }>; relationCount: number; threadId?: string;
  }
  | { state: "blocked"; code: string; message: string };

export function buildOnboardingContext(store: CrosslineStore, workspaceId: string,
  answers: Array<{ question: string; answer: string }>,
  sources: Array<{ label: string; excerpt: string }> = [], focusIdentityId: string | null = null): OnboardingContext {
  return {
    version: "crossline.onboarding.v1",
    answers: answers.map((item, index) => ({ id: `answer-${index}`, question: item.question, answer: item.answer })),
    sources: sources.map((item, index) => ({ id: `source-${index}`, label: item.label, excerpt: item.excerpt })),
    identities: defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label })),
    existingMilestones: store.listMilestones(workspaceId).map((milestone) =>
      ({ id: milestone.id, identityId: milestone.identityId, title: milestone.title, status: milestone.status })),
    focusIdentityId
  };
}

/** Saves whatever a turn's validated output proposed — milestone drafts (same store path
 * `crossline-milestone-architect` uses) and milestone relations as `candidate` (same store path the
 * nightly flywheel scout uses) — and returns enough to report back to the person. */
function saveProposal(store: CrosslineStore, workspaceId: string, output: OnboardingProposal, source: string):
  { drafts: Array<{ id: string; identityId: string; title: string }>; relationCount: number } {
  const drafts: Array<{ id: string; identityId: string; title: string }> = [];
  const idByTitle = new Map<string, string>();
  for (const milestone of store.listMilestones(workspaceId)) idByTitle.set(milestone.title.trim(), milestone.id);
  for (const proposal of output.milestoneProposals) {
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
      payload: { rationale: proposal.rationale, request: source }
    });
    idByTitle.set(proposal.title.trim(), id);
    drafts.push({ id, identityId: proposal.identityId, title: proposal.title });
  }
  let relationCount = 0;
  for (const relation of output.relationProposals) {
    const fromMilestoneId = idByTitle.get(relation.fromTitle.trim());
    const toMilestoneId = idByTitle.get(relation.toTitle.trim());
    if (!fromMilestoneId || !toMilestoneId) continue;
    const id = `proposed-relation-${randomUUID()}`;
    store.saveMilestoneRelation({
      id, ownerId: OWNER_ID, workspaceId, fromMilestoneId, toMilestoneId, kind: relation.kind,
      status: "candidate", explanation: relation.explanation, refutedWhen: relation.refutedWhen
    });
    store.appendEvent({
      ownerId: OWNER_ID, workspaceId, idempotencyKey: `onboarding:relation:${id}`,
      type: "milestone_relation.proposed", entityId: id, payload: { request: source }
    });
    relationCount += 1;
  }
  return { drafts, relationCount };
}

/**
 * The first-login interview, now a real conversation instead of one free-text box submitted once: the
 * Skill asks what it needs per identity, proposing milestones and relations through the exact same
 * draft/candidate-then-approve paths `crossline-milestone-architect` and the nightly flywheel scout use —
 * this opens the thread; `createOnboardingConversation` below continues it.
 */
export function createOnboardingProposer(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function propose(answers: Array<{ question: string; answer: string }>,
    sources: Array<{ label: string; excerpt: string }> = [], signal?: AbortSignal): Promise<OnboardingTurn> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const context = buildOnboardingContext(store, workspaceId, answers, sources, null);
    if (!context.answers.some((item) => item.answer.trim()) && !context.sources.length) {
      return { state: "blocked", code: "ONBOARDING_NO_INPUT", message: "还没有填写任何访谈回答。" };
    }

    let threadId: string | undefined;
    const result = await runCodexSkill<OnboardingProposal>(client, context, {
      skillName: ONBOARDING_SKILL,
      cwd,
      developerInstructions: INSTRUCTIONS,
      outputSchema: ONBOARDING_OUTPUT_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateOnboardingProposal(output, context),
      onAudit: (audit) => { threadId = audit.threadId; },
      ...(signal ? { signal } : {}),
      timeoutMs: 10 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    const { drafts, relationCount } = saveProposal(store, workspaceId, result.output, "onboarding-interview");
    return {
      state: drafts.length ? "proposed" : "asking", reply: result.output.reply,
      focusIdentityId: result.output.focusIdentityId, allIdentitiesCovered: result.output.allIdentitiesCovered,
      drafts, relationCount, ...(threadId ? { threadId } : {})
    };
  };
}

/**
 * A follow-up turn on a thread `propose` already opened — where the actual interviewing happens: the
 * user answers the Skill's question, the Skill either asks the next one or, once it has enough for the
 * identity it is focused on, proposes for it and moves on.
 */
export function createOnboardingConversation(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function continueConversation(threadId: string, message: string, focusIdentityId: string | null,
    signal?: AbortSignal): Promise<OnboardingTurn> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    // Re-read fresh so a reply cannot duplicate a draft an earlier turn already produced, and so a
    // relation proposed this turn can resolve against a milestone an earlier turn just saved.
    const context = buildOnboardingContext(store, workspaceId, [], [], focusIdentityId);

    const result = await continueSkillTurn<OnboardingProposal>(client, threadId, message.slice(0, 2000), {
      skillName: ONBOARDING_SKILL,
      cwd,
      outputSchema: ONBOARDING_OUTPUT_SCHEMA,
      validateOutput: (output) => validateOnboardingProposal(output, context),
      onAudit: () => {},
      ...(signal ? { signal } : {}),
      timeoutMs: 10 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };

    const { drafts, relationCount } = saveProposal(store, workspaceId, result.output, "onboarding-interview");
    return {
      state: drafts.length ? "proposed" : "asking", reply: result.output.reply,
      focusIdentityId: result.output.focusIdentityId, allIdentitiesCovered: result.output.allIdentitiesCovered,
      drafts, relationCount
    };
  };
}
