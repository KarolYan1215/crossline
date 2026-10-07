import { randomUUID } from "node:crypto";
import { BACKPLAN_SCHEMA, mentionsExternalAction, validateBackplan, type BackplanAnswer as Answer } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

import { ownerOf } from "./owner";
import { autoApproveEligible } from "./auto-approval";
const SKILL = "crossline:crossline-goal-backplanner";
/** A proposal version is expanded once; repeating the request returns its existing draft IDs. */
export function createGoalBackplanner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function backplan(milestoneId: string, signal?: AbortSignal) {
    const milestone = store.listMilestones(workspaceId).find((item) => item.id === milestoneId &&
      item.status === "approved" && item.projectId);
    if (!milestone || !defaultIdentityPacks().some((pack) => pack.id === milestone.identityId && pack.kind === "identity"))
      return { state: "blocked", code: "BACKPLAN_GOAL_NOT_APPROVED", message: "需要已批准且绑定真实身份、项目的里程碑。" };
    const key = `goal:backplan:${milestone.id}:${milestone.version}`;
    const existing = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .find((event) => event.idempotencyKey === key);
    if (existing) {
      const payload = existing.payload as { workOrderIds: string[]; dateCandidates?: Answer["dateCandidates"] };
      return { state: "proposed", workOrderIds: payload.workOrderIds,
        dateCandidates: payload.dateCandidates ?? [] };
    }
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const request = store.listEvents(workspaceId, { type: "milestone.proposed", entityId: milestone.id })
      .at(-1)?.payload as { request?: string } | undefined;
    const decisions = store.listEvents(workspaceId, { type: ["insight.approved", "insight.revoked"] });
    const accepted = new Set(decisions.filter((event) => event.type === "insight.approved")
      .map((event) => event.entityId));
    for (const event of decisions.filter((item) => item.type === "insight.revoked")) accepted.delete(event.entityId);
    const approvedInsights = store.listEvents(workspaceId, { type: "flywheel.finding" })
      .filter((event) => accepted.has(event.eventId) && event.entityId === milestone.id)
      .map((event) => event.payload as { summary: string; sourceUrl: string; staleWhen: string });
    const dateSources = [milestone.title, ...milestone.successCriteria.map((item) => item.statement), request?.request ?? ""]
      .filter(Boolean);
    const sources = [...dateSources, ...approvedInsights.map((item) => item.summary)];
    const context = { version: "crossline.goal-backplan.v1", milestone: {
      id: milestone.id, version: milestone.version, identityId: milestone.identityId,
      projectId: milestone.projectId, title: milestone.title, successCriteria: milestone.successCriteria
    }, sourceText: request?.request ?? "", approvedInsights,
      existingWork: store.listWorkOrders(workspaceId)
      .filter((order) => order.milestoneId === milestone.id).map((order) => ({ id: order.id, intent: order.intent, state: order.state })) };
    const result = await runCodexSkill<Answer>(client, context, { skillName: SKILL, cwd,
      developerInstructions: "Work backwards from the approved milestone. Return only sourced step drafts; never set a goal or deadline. Block if the supplied source cannot justify a step.",
      outputSchema: BACKPLAN_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateBackplan(output, sources, dateSources), onAudit: () => {},
      ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000 });
    if (!result.ok) {
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `goal:backplan:blocked:${milestone.id}:${milestone.version}`,
        type: "goal.backplan_blocked", entityId: milestone.id,
        payload: { milestoneVersion: milestone.version, code: result.blocker.code, message: result.blocker.message.slice(0, 400) } });
      return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    }
    const ids = new Map(result.output.steps.map((step) => [step.id, `backplan-${randomUUID()}`]));
    const drafts: StoredWorkOrder[] = result.output.steps.map((step) => {
      const id = ids.get(step.id)!;
      const external = /\b(email|publish|submit|purchase|sell|buy|sign|legal|transfer|delete)\b|发送|发布|提交|购买|出售|签署|法律|转账|删除/i
        .test(`${step.intent} ${step.rationale} ${step.evidence}`);
      const riskTier = external ? "high_risk" : step.riskTier;
      return { id, ownerId: ownerOf(store, workspaceId), workspaceId,
        identityId: milestone.identityId, projectId: milestone.projectId!, milestoneId: milestone.id,
        intent: step.intent, state: "awaiting_plan_approval", riskTier,
        estimate: { ...step.estimate, source: "llm_prior", observationCount: 0, confidence: "low" },
        payload: { family: step.family, backplan: { milestoneVersion: milestone.version, sourceQuote: step.sourceQuote,
          rationale: step.rationale, stepId: step.id }, dependsOn: step.dependsOn.map((dep) => ids.get(dep)!),
          automationParts: [], humanCore: [{ id: `${id}-core`, intent: step.intent, quote: step.sourceQuote,
            rationale: step.rationale, energy: step.energy, interruptible: step.interruptible }],
          materialContract: [], evidenceContract: [{ kind: "record", description: step.evidence,
            why: "反推步骤的交付证据", required: true }],
          audit: { threadId: result.audit.threadId ?? "unavailable", turnId: result.audit.turnId ?? "unavailable" },
          contextVersion: context.version } };
    });
    const workOrderIds = drafts.map((draft) => draft.id);
    const inserted = store.saveBackplanDrafts(workspaceId, drafts, { ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: key,
      type: "goal.backplan_proposed", entityId: milestone.id,
      payload: { milestoneVersion: milestone.version, workOrderIds,
        dateCandidates: result.output.dateCandidates, source: SKILL } });
    if (inserted) {
      autoApproveEligible(store, workspaceId, workOrderIds);
      return { state: "proposed", workOrderIds, dateCandidates: result.output.dateCandidates };
    }
    const saved = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .find((event) => event.idempotencyKey === key);
    return { state: "proposed", workOrderIds: (saved?.payload as { workOrderIds?: string[] })?.workOrderIds ?? [],
      dateCandidates: (saved?.payload as { dateCandidates?: Answer["dateCandidates"] })?.dateCandidates ?? [] };
  };
}

/** How far ahead a milestone's deadline may be for the system to work backwards from it on its own. */
export const AUTO_BACKPLAN_HORIZON_DAYS = 21;

/**
 * Approved milestones the system should work backwards from without being asked: due within three weeks,
 * nothing open serving them yet, and not already backplanned at this version. This is what turns 「按线批准
 * 里程碑」 into a week with real steps on it — before, the only route from a milestone to work was a button
 * per milestone (which never worked on a real account) or the person typing every step themselves.
 */
export function milestonesAwaitingBackplan(store: CrosslineStore, workspaceId: string, now = new Date(), limit = 3): string[] {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + AUTO_BACKPLAN_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const deadlines = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const open = new Set(store.listWorkOrders(workspaceId).filter((order) => !["archived", "accepted"].includes(order.state))
    .map((order) => order.milestoneId));
  // Proposed, or tried and refused (the model said the milestone's own text cannot justify a step): either way this
  // version is not tried again on a timer — a refusal repeated every fifteen minutes is quota spent on the same answer.
  const done = new Set(store.listEvents(workspaceId, { type: ["goal.backplan_proposed", "goal.backplan_blocked"] }).map((event) =>
    event.type === "goal.backplan_blocked" ? `goal:backplan:${event.entityId}:${(event.payload as { milestoneVersion?: number }).milestoneVersion}` : event.idempotencyKey));
  const identities = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => pack.id));
  return store.listMilestones(workspaceId)
    .filter((milestone) => milestone.status === "approved" && milestone.projectId && identities.has(milestone.identityId))
    .filter((milestone) => { const deadline = deadlines.get(milestone.id); return Boolean(deadline && deadline >= today && deadline <= horizon); })
    .filter((milestone) => !open.has(milestone.id) && !done.has(`goal:backplan:${milestone.id}:${milestone.version}`))
    .sort((a, b) => deadlines.get(a.id)!.localeCompare(deadlines.get(b.id)!))
    .slice(0, limit).map((milestone) => milestone.id);
}
