import {
  PLAN_EXPLAINER_OUTPUT_SCHEMA, validatePlanExplanation, goalSettingKey,
  type PlanExplainerContext, type PlanExplanation
} from "@crossline/core";
import { recommendNextActions } from "@crossline/planner";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

import { ownerOf } from "./owner";
export const PLAN_EXPLAINER_SKILL = "crossline:crossline-plan-explainer";
const ACTIONABLE = ["approved", "preparing", "ready_for_human", "active"];

const INSTRUCTIONS = "Explain the supplied schedule in plain language. The ordering is already decided "
  + "lexicographically by the app's own scheduler — you narrate why it looks the way it does, you never "
  + "invent a weighted score or re-rank anything yourself. `nextActionReason` explains why `nextActionId` "
  + "is first; each entry in `alternatives` explains why that other id is not. Cite the real facts you "
  + "were given (estimate, energy, deadline, importance) rather than restating them as a list. If nothing "
  + "was supplied to explain, return a blocker instead of guessing.";

type ExplainerOutcome =
  | { state: "ready"; explanation: PlanExplanation }
  | { state: "blocked"; code: string; message: string };

const humanCoreOf = (order: { payload: unknown }) =>
  ((order.payload as { humanCore?: Array<{ energy?: string }> }).humanCore ?? [])[0];

/** The same context the app itself already reasons with, assembled independently of the web boundary
 * so the worker package does not depend on `apps/web`. */
export function buildPlanExplainerContext(store: CrosslineStore, workspaceId: string, today: string): PlanExplainerContext {
  const capacityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const orders = store.listWorkOrders(workspaceId)
    .filter((order) => !capacityIds.has(order.identityId) && ACTIONABLE.includes(order.state));
  const milestones = store.listMilestones(workspaceId);
  const goalOf = (milestoneId: string) => {
    const raw = store.getSetting(workspaceId, goalSettingKey(milestoneId));
    if (!raw) return null;
    try { return JSON.parse(raw) as { importance?: string; confirmedDeadline?: string }; } catch { return null; }
  };
  const tasks = orders.map((order) => ({
    id: order.id, title: order.intent, identityId: order.identityId, milestoneId: order.milestoneId,
    estimate: order.estimate,
    ...(humanCoreOf(order)?.energy ? { energy: humanCoreOf(order)!.energy as "low" | "medium" | "high" } : {}),
    inputsReady: order.state === "ready_for_human" || order.state === "active",
    deadlineTier: (goalOf(order.milestoneId)?.importance === "important" ? 1 : 3) as 1 | 3,
    interruptible: true
  }));
  const actions = recommendNextActions(tasks, 40, undefined, new Date(`${today}T12:00:00`), {});
  const latestSelfReport = [...store.listEnergyObservations(workspaceId)]
    .filter((item) => item.source === "self_report" && item.level !== "uncalibrated")
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt)).at(-1);
  return {
    version: "crossline.plan-explainer.v1",
    today,
    nextActionId: actions.primary?.id ?? null,
    alternativeIds: [actions.higherPriority?.id, actions.lowEnergy?.id, actions.shortGap?.id]
      .filter((id): id is string => Boolean(id)),
    activeWorkOrders: orders.map((order) => {
      const goal = goalOf(order.milestoneId);
      return {
        id: order.id, intent: order.intent, identityId: order.identityId,
        estimateP50Minutes: order.estimate.p50Minutes,
        energy: (humanCoreOf(order)?.energy as "low" | "medium" | "high" | undefined) ?? null,
        important: goal?.importance === "important",
        confirmedDeadline: goal?.confirmedDeadline ?? null
      };
    }),
    currentEnergy: (latestSelfReport?.level as "low" | "medium" | "high" | undefined) ?? "uncalibrated",
    approvedMilestones: milestones.filter((milestone) => milestone.status === "approved")
      .map((milestone) => ({ id: milestone.id, identityId: milestone.identityId, title: milestone.title }))
  };
}

export function createPlanExplainer(store: CrosslineStore, workspaceId: string, projectRoot: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function explain(today: string): Promise<ExplainerOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const context = buildPlanExplainerContext(store, workspaceId, today);
    if (!context.activeWorkOrders.length) return { state: "blocked", code: "PLAN_EXPLAINER_NOTHING_TO_EXPLAIN", message: "当前没有可排程的作业。" };

    const result = await runCodexSkill<PlanExplanation>(client, context, {
      skillName: PLAN_EXPLAINER_SKILL,
      cwd: projectRoot,
      developerInstructions: INSTRUCTIONS,
      outputSchema: PLAN_EXPLAINER_OUTPUT_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validatePlanExplanation(output, context),
      onAudit: () => {},
      timeoutMs: 60 * 60_000
    });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    store.appendEvent({
      ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `plan-explainer:${today}:${Date.now()}`,
      type: "plan.explained", entityId: today, payload: result.output
    });
    return { state: "ready", explanation: result.output };
  };
}
