import "server-only";
import type { AccessContext, SuccessCriterion } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { getStore, resolvedEstimate, relationKindLabel, accents } from "./crossline";

/**
 * One canonical shape for "everything about this task", read once here instead of being assembled
 * separately by Workbench, Today, Milestones and Approvals — every entry point into a task's detail
 * (drawer or standalone page, see `task-detail-view.tsx`) renders exactly this.
 */
export type TaskDetail = {
  id: string;
  ownerId: string;
  workspaceId: string;
  paused: boolean;
  identityId: string;
  identityLabel: string;
  accent: string;
  intent: string;
  state: string;
  riskTier: "routine" | "milestone" | "high_risk";
  estimate: ReturnType<typeof resolvedEstimate>;
  manualPromotion: boolean;
  milestone?: { id: string; title: string };
  materialContract: Array<{ kind: string; description: string; why: string; required: boolean }>;
  evidenceContract: Array<{ kind: string; description: string; why: string; required: boolean }>;
  preparedMaterials: Array<{ id: string; uri: string; fileName: string; mediaType: string }>;
  executions: Array<{
    id: string; startedAt: string; endedAt?: string; pauseMinutes: number; durationObserved: boolean;
    outcome?: string; interruptions: Array<{ pausedAt: string; resumedAt?: string; reason: string }>;
  }>;
  blocker?: { reason: string };
  materialBlocker?: { message: string };
  gateReview?: {
    verdict: string;
    criteriaVerdict: Array<{ criterionId: string; met: string; observed: string; shortfall?: string }>;
    gaps: Array<{ code: string; whatWouldSatisfyIt: string }>;
  };
  discardReason?: string;
  relatedFlywheel: Array<{ id: string; fromTitle: string; toTitle: string; kindLabel: string; explanation: string | null; pending: boolean }>;
  /** Placeholder for the project-context pipeline (onboarding + per-capture compaction) — a later,
   * separately-planned phase. Until then the detail view shows "未设置背景资料" rather than the section
   * simply not existing, so wiring the real data in later needs no layout change. */
  background: null;
};

export type MilestoneDetail = {
  id: string;
  identityId: string;
  identityLabel: string;
  accent: string;
  title: string;
  status: string;
  rationale?: string;
  successCriteria: SuccessCriterion[];
  relatedWorkOrders: Array<{ id: string; intent: string; state: string }>;
  relatedFlywheel: Array<{ id: string; fromTitle: string; toTitle: string; kindLabel: string; explanation: string | null; pending: boolean }>;
  background: null;
};

function identityInfo(identityId: string): { label: string; accent: string } {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId);
  return { label: pack?.label ?? identityId, accent: accents[identityId] ?? "#5A5B54" };
}

function flywheelTouching(ctx: AccessContext, milestoneId: string | undefined) {
  if (!milestoneId) return [];
  const store = getStore();
  const milestones = store.listMilestones(ctx.workspaceId);
  const titleOf = (id: string) => milestones.find((item) => item.id === id)?.title ?? id;
  return store.listMilestoneRelations(ctx.workspaceId)
    .filter((relation) => (relation.status === "approved" || relation.status === "candidate")
      && (relation.fromMilestoneId === milestoneId || relation.toMilestoneId === milestoneId))
    .map((relation) => ({
      id: relation.id, fromTitle: titleOf(relation.fromMilestoneId), toTitle: titleOf(relation.toMilestoneId),
      kindLabel: relationKindLabel[relation.kind] ?? relation.kind,
      explanation: relation.explanation ?? null, pending: relation.status === "candidate"
    }));
}

export function loadTaskDetail(ctx: AccessContext, workOrderId: string): TaskDetail | undefined {
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === workOrderId);
  if (!order) return undefined;
  const payload = order.payload as {
    manualPromotion?: boolean; materialContract?: TaskDetail["materialContract"]; evidenceContract?: TaskDetail["evidenceContract"];
    blocker?: { reason: string }; gateReview?: TaskDetail["gateReview"];
  };
  const { label: identityLabel, accent } = identityInfo(order.identityId);
  const milestone = store.listMilestones(ctx.workspaceId).find((item) => item.id === order.milestoneId);
  const materials = store.listMaterials(ctx.workspaceId).filter((item) => item.workOrderId === workOrderId);
  const executions = store.listExecutions(ctx.workspaceId).filter((item) => item.workOrderId === workOrderId);
  // Same read `materialStatus` in Workbench uses — the latest materials.blocked/retry_requested for this
  // order, last-word-wins over the event trail rather than trusting a single snapshot field.
  let materialBlocker: TaskDetail["materialBlocker"];
  for (const event of store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"] })) {
    if (event.entityId !== workOrderId) continue;
    if (event.type === "materials.blocked") {
      const detail = event.payload as { code?: string; message?: string };
      materialBlocker = { message: detail.message ?? detail.code ?? "材料准备被阻塞" };
    } else materialBlocker = undefined;
  }
  const discardReason = order.state === "archived"
    ? [...store.listEvents(ctx.workspaceId, { type: "work_order.archived" })]
      .reverse().find((event) => event.entityId === workOrderId)?.payload as { reason?: string } | undefined
    : undefined;
  // Same "is there an open execution with an unresolved interruption" read Workbench's own card does —
  // duplicated here (not exported from workbench/page.tsx, which is a route file, not a library) so the
  // detail view can embed the real `ExecutionActions` instead of only ever being read-only.
  const openExecution = executions.find((item) => !item.endedAt);
  const paused = Boolean(openExecution?.interruptions.at(-1) && !openExecution.interruptions.at(-1)!.resumedAt);

  return {
    id: order.id, ownerId: order.ownerId, workspaceId: order.workspaceId, paused,
    identityId: order.identityId, identityLabel, accent, intent: order.intent, state: order.state,
    riskTier: order.riskTier, estimate: resolvedEstimate(ctx, order), manualPromotion: Boolean(payload.manualPromotion),
    ...(milestone ? { milestone: { id: milestone.id, title: milestone.title } } : {}),
    materialContract: payload.materialContract ?? [], evidenceContract: payload.evidenceContract ?? [],
    preparedMaterials: materials.map((item) => ({ id: item.id, uri: item.uri, fileName: item.uri.split("/").pop() ?? item.uri, mediaType: item.mediaType })),
    executions: executions.map((item) => ({
      id: item.id, startedAt: item.startedAt, ...(item.endedAt ? { endedAt: item.endedAt } : {}),
      pauseMinutes: item.pauseMinutes, durationObserved: item.durationObserved,
      ...(item.outcome ? { outcome: item.outcome } : {}), interruptions: item.interruptions
    })),
    ...(payload.blocker ? { blocker: payload.blocker } : {}),
    ...(materialBlocker ? { materialBlocker } : {}),
    ...(payload.gateReview ? { gateReview: payload.gateReview } : {}),
    ...(discardReason?.reason ? { discardReason: discardReason.reason } : {}),
    relatedFlywheel: flywheelTouching(ctx, order.milestoneId), background: null
  };
}

export function loadMilestoneDetail(ctx: AccessContext, milestoneId: string): MilestoneDetail | undefined {
  const store = getStore();
  const milestone = store.listMilestones(ctx.workspaceId).find((item) => item.id === milestoneId);
  if (!milestone) return undefined;
  const { label: identityLabel, accent } = identityInfo(milestone.identityId);
  const rationale = [...store.listEvents(ctx.workspaceId, { type: "milestone.proposed" })]
    .find((event) => event.entityId === milestoneId)?.payload as { rationale?: string } | undefined;
  const relatedWorkOrders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.milestoneId === milestoneId)
    .map((order) => ({ id: order.id, intent: order.intent, state: order.state }));
  return {
    id: milestone.id, identityId: milestone.identityId, identityLabel, accent, title: milestone.title,
    status: milestone.status, ...(rationale?.rationale ? { rationale: rationale.rationale } : {}),
    successCriteria: milestone.successCriteria,
    relatedWorkOrders, relatedFlywheel: flywheelTouching(ctx, milestoneId), background: null
  };
}
