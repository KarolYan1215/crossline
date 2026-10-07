import "server-only";
import type { AccessContext, SuccessCriterion, EvidenceQuestionTemplate } from "@crossline/core";
import type { CrosslineStore, StoredMilestone, StoredWorkOrder, StoredMaterial, StoredExecution, StoredMilestoneRelation, StoredBackgroundFact } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { getStore, resolvedEstimate, relationKindLabel, accents } from "./crossline";

type StoredEvent = ReturnType<CrosslineStore["listEvents"]>[number];

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
  /** A starter work order the app wrote on first run, not something the person created. */
  seeded: boolean;
  milestone?: { id: string; title: string };
  /** What falls to the person and what the AI prepares, with the source each was read from — the same
   * analysis the approval card shows. The detail page used to leave these out, so the page a card links
   * to knew less about the task than the card did. */
  humanCore: Array<{ id: string; intent: string; quote?: string; rationale?: string }>;
  automationParts: Array<{ id: string; intent: string; quote?: string; rationale?: string }>;
  /** Focused minutes by step; their sum is the analysis's median. Empty for an order with no breakdown. */
  estimateBreakdown: Array<{ step: string; minutes: number }>;
  materialContract: Array<{ kind: string; description: string; why: string; required: boolean }>;
  evidenceContract: Array<{ kind: string; description: string; why: string; required: boolean }>;
  /** Pre-generated completion-time questions copied from the bound milestone at `plan.approved` — see
   * 工作块 E. Empty for an order whose milestone has no question bank; file/free-text evidence still works. */
  evidenceChecklist: EvidenceQuestionTemplate[];
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
  /** This work order's identity's background facts (onboarding + per-capture compaction), `null` when
   * none have been extracted yet — the detail view shows "未设置背景资料" for that case rather than the
   * section simply not existing. */
  background: StoredBackgroundFact[] | null;
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
  background: StoredBackgroundFact[] | null;
};

function identityInfo(identityId: string): { label: string; accent: string } {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId);
  return { label: pack?.label ?? identityId, accent: accents[identityId] ?? "#5A5B54" };
}

/**
 * Shared by both the single-id and batch tiers below: given the relations that touch one milestone and
 * a way to resolve a title for any other milestone id, produce the same `relatedFlywheel` shape either
 * tier assembles into `TaskDetail`/`MilestoneDetail`. Kept independent of how `titleOf` gets its answer
 * (a point query per id for the single-id tier, a pre-built Map for the batch tier) so neither tier is
 * forced into the other's read pattern.
 */
function flywheelTouching(relations: StoredMilestoneRelation[], milestoneId: string | undefined,
  titleOf: (id: string) => string): TaskDetail["relatedFlywheel"] {
  if (!milestoneId) return [];
  return relations
    .filter((relation) => (relation.status === "approved" || relation.status === "candidate")
      && (relation.fromMilestoneId === milestoneId || relation.toMilestoneId === milestoneId))
    .map((relation) => ({
      id: relation.id, fromTitle: titleOf(relation.fromMilestoneId), toTitle: titleOf(relation.toMilestoneId),
      kindLabel: relationKindLabel[relation.kind] ?? relation.kind,
      explanation: relation.explanation ?? null, pending: relation.status === "candidate"
    }));
}

/** Last-word-wins over a `materials.blocked`/`materials.retry_requested` trail already narrowed to one
 * work order (by SQL `entityId` in the single-id tier, by a pre-grouped Map in the batch tier) — same
 * read Workbench's own `materialStatus` does. */
function materialBlockerFrom(events: StoredEvent[]): TaskDetail["materialBlocker"] {
  let blocker: TaskDetail["materialBlocker"];
  for (const event of events) {
    if (event.type === "materials.blocked") {
      const detail = event.payload as { code?: string; message?: string };
      blocker = { message: detail.message ?? detail.code ?? "材料准备被阻塞" };
    } else blocker = undefined;
  }
  return blocker;
}

function discardReasonFrom(state: string, events: StoredEvent[]): string | undefined {
  if (state !== "archived") return undefined;
  return (events.at(-1)?.payload as { reason?: string } | undefined)?.reason;
}

/** Same "is there an open execution with an unresolved interruption" read Workbench's own card does —
 * duplicated here (not exported from workbench/page.tsx, which is a route file, not a library) so the
 * detail view can embed the real `ExecutionActions` instead of only ever being read-only. */
function pausedFrom(executions: TaskDetail["executions"]): boolean {
  const open = executions.find((item) => !item.endedAt);
  return Boolean(open?.interruptions.at(-1) && !open.interruptions.at(-1)!.resumedAt);
}

/** The one place a `StoredWorkOrder` plus its already-resolved dependencies becomes a `TaskDetail` —
 * shared by the single-id and batch tiers so their output is byte-identical regardless of which one a
 * caller used to get here. */
function assembleTaskDetail(ctx: AccessContext, order: StoredWorkOrder, deps: {
  milestone: StoredMilestone | undefined; materials: StoredMaterial[]; executions: StoredExecution[];
  materialEvents: StoredEvent[]; archivedEvents: StoredEvent[]; relatedFlywheel: TaskDetail["relatedFlywheel"];
  background: StoredBackgroundFact[];
}): TaskDetail {
  const payload = order.payload as {
    manualPromotion?: boolean; seeded?: boolean; materialContract?: TaskDetail["materialContract"]; evidenceContract?: TaskDetail["evidenceContract"];
    evidenceChecklist?: TaskDetail["evidenceChecklist"];
    humanCore?: TaskDetail["humanCore"]; automationParts?: TaskDetail["automationParts"];
    estimateBreakdown?: TaskDetail["estimateBreakdown"];
    blocker?: { reason: string }; gateReview?: TaskDetail["gateReview"];
  };
  const { label: identityLabel, accent } = identityInfo(order.identityId);
  const executions = deps.executions.map((item) => ({
    id: item.id, startedAt: item.startedAt, ...(item.endedAt ? { endedAt: item.endedAt } : {}),
    pauseMinutes: item.pauseMinutes, durationObserved: item.durationObserved,
    ...(item.outcome ? { outcome: item.outcome } : {}), interruptions: item.interruptions
  }));
  const materialBlocker = materialBlockerFrom(deps.materialEvents);
  const discardReason = discardReasonFrom(order.state, deps.archivedEvents);

  return {
    id: order.id, ownerId: order.ownerId, workspaceId: order.workspaceId, paused: pausedFrom(executions),
    identityId: order.identityId, identityLabel, accent, intent: order.intent, state: order.state,
    riskTier: order.riskTier, estimate: resolvedEstimate(ctx, order), manualPromotion: Boolean(payload.manualPromotion), seeded: Boolean(payload.seeded),
    ...(deps.milestone ? { milestone: { id: deps.milestone.id, title: deps.milestone.title } } : {}),
    humanCore: payload.humanCore ?? [], automationParts: payload.automationParts ?? [],
    estimateBreakdown: payload.estimateBreakdown ?? [],
    materialContract: payload.materialContract ?? [], evidenceContract: payload.evidenceContract ?? [],
    evidenceChecklist: payload.evidenceChecklist ?? [],
    preparedMaterials: deps.materials.map((item) => ({ id: item.id, uri: item.uri, fileName: item.uri.split("/").pop() ?? item.uri, mediaType: item.mediaType })),
    executions,
    ...(payload.blocker ? { blocker: payload.blocker } : {}),
    ...(materialBlocker ? { materialBlocker } : {}),
    ...(payload.gateReview ? { gateReview: payload.gateReview } : {}),
    ...(discardReason ? { discardReason } : {}),
    relatedFlywheel: deps.relatedFlywheel, background: deps.background.length ? deps.background : null
  };
}

function assembleMilestoneDetail(milestone: StoredMilestone, rationale: string | undefined,
  relatedWorkOrders: MilestoneDetail["relatedWorkOrders"], relatedFlywheel: TaskDetail["relatedFlywheel"],
  background: StoredBackgroundFact[]): MilestoneDetail {
  const { label: identityLabel, accent } = identityInfo(milestone.identityId);
  return {
    id: milestone.id, identityId: milestone.identityId, identityLabel, accent, title: milestone.title,
    status: milestone.status, ...(rationale ? { rationale } : {}),
    successCriteria: milestone.successCriteria, relatedWorkOrders, relatedFlywheel,
    background: background.length ? background : null
  };
}

/**
 * Single-id tier: every read is an indexed point query (or, for `listMilestoneRelations`, the one
 * unavoidable full-table read — the table carries no `from`/`to` index and is small enough on every
 * workspace this app has ever run against that adding one isn't worth it yet). Used by the two
 * standalone detail pages (`/workbench/[id]`, `/milestones/[id]`) and as the fallback a `TaskPreview`/
 * `MilestonePreview` takes when a page hasn't precomputed a batch (see `loadTaskDetailsBatch` below for
 * the tier list pages use instead, so N cards on one page don't mean N times this work).
 */
export function loadTaskDetail(ctx: AccessContext, workOrderId: string): TaskDetail | undefined {
  const store = getStore();
  const order = store.getWorkOrder(ctx.workspaceId, workOrderId);
  if (!order) return undefined;
  const milestone = order.milestoneId ? store.getMilestone(ctx.workspaceId, order.milestoneId) : undefined;
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  // Every relation touching this milestone needs the OTHER endpoint's title too — resolved by point
  // query per distinct id encountered (memoized), rather than a full `listMilestones` scan.
  const titleCache = new Map<string, string>(milestone ? [[milestone.id, milestone.title]] : []);
  const titleOf = (id: string) => {
    const cached = titleCache.get(id);
    if (cached !== undefined) return cached;
    const title = store.getMilestone(ctx.workspaceId, id)?.title ?? id;
    titleCache.set(id, title);
    return title;
  };
  return assembleTaskDetail(ctx, order, {
    milestone, materials: store.listMaterials(ctx.workspaceId, workOrderId),
    executions: store.listExecutions(ctx.workspaceId, workOrderId),
    materialEvents: store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"], entityId: workOrderId }),
    archivedEvents: order.state === "archived"
      ? store.listEvents(ctx.workspaceId, { type: "work_order.archived", entityId: workOrderId }) : [],
    relatedFlywheel: flywheelTouching(relations, order.milestoneId, titleOf),
    background: store.getBackgroundFacts(ctx.workspaceId, order.identityId)
  });
}

export function loadMilestoneDetail(ctx: AccessContext, milestoneId: string): MilestoneDetail | undefined {
  const store = getStore();
  const milestone = store.getMilestone(ctx.workspaceId, milestoneId);
  if (!milestone) return undefined;
  const rationale = store.listEvents(ctx.workspaceId, { type: "milestone.proposed", entityId: milestoneId })
    .at(-1)?.payload as { rationale?: string } | undefined;
  const relatedWorkOrders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.milestoneId === milestoneId)
    .map((order) => ({ id: order.id, intent: order.intent, state: order.state }));
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const titleCache = new Map<string, string>([[milestone.id, milestone.title]]);
  const titleOf = (id: string) => {
    const cached = titleCache.get(id);
    if (cached !== undefined) return cached;
    const title = store.getMilestone(ctx.workspaceId, id)?.title ?? id;
    titleCache.set(id, title);
    return title;
  };
  return assembleMilestoneDetail(milestone, rationale?.rationale, relatedWorkOrders,
    flywheelTouching(relations, milestoneId, titleOf), store.getBackgroundFacts(ctx.workspaceId, milestone.identityId));
}

/**
 * Batch tier: one read per underlying table for the whole workspace, then one assembly per requested
 * id from in-memory Maps — the same "read once, look up in a loop" pattern `workbench/page.tsx` and
 * `loadDashboard` already use for their own fields. A list page rendering N cards' preview drawers
 * should call this once with all N ids rather than let each `TaskPreview` call `loadTaskDetail`
 * separately, which is what turned this into an N+1 the first time it shipped.
 */
export function loadTaskDetailsBatch(ctx: AccessContext, workOrderIds: string[]): Map<string, TaskDetail> {
  const result = new Map<string, TaskDetail>();
  if (!workOrderIds.length) return result;
  const store = getStore();
  const ids = new Set(workOrderIds);
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => ids.has(order.id));
  if (!orders.length) return result;
  const milestoneById = new Map(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item]));
  const materialsByOrder = groupBy(store.listMaterials(ctx.workspaceId), (item) => item.workOrderId);
  const executionsByOrder = groupBy(store.listExecutions(ctx.workspaceId), (item) => item.workOrderId);
  const materialEventsByOrder = groupBy(
    store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"] }),
    (event) => event.entityId);
  const archivedEventsByOrder = groupBy(
    store.listEvents(ctx.workspaceId, { type: "work_order.archived" }), (event) => event.entityId);
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const titleOf = (id: string) => milestoneById.get(id)?.title ?? id;
  // Facts are per-identity, not per-order — a handful of distinct identities across however many orders
  // are in this batch, so one cached read per identity rather than one per order.
  const backgroundByIdentity = new Map<string, StoredBackgroundFact[]>();
  const backgroundOf = (identityId: string) => {
    const cached = backgroundByIdentity.get(identityId);
    if (cached) return cached;
    const facts = store.getBackgroundFacts(ctx.workspaceId, identityId);
    backgroundByIdentity.set(identityId, facts);
    return facts;
  };

  for (const order of orders) {
    const milestone = order.milestoneId ? milestoneById.get(order.milestoneId) : undefined;
    result.set(order.id, assembleTaskDetail(ctx, order, {
      milestone, materials: materialsByOrder.get(order.id) ?? [], executions: executionsByOrder.get(order.id) ?? [],
      materialEvents: materialEventsByOrder.get(order.id) ?? [], archivedEvents: archivedEventsByOrder.get(order.id) ?? [],
      relatedFlywheel: flywheelTouching(relations, order.milestoneId, titleOf),
      background: backgroundOf(order.identityId)
    }));
  }
  return result;
}

export function loadMilestoneDetailsBatch(ctx: AccessContext, milestoneIds: string[]): Map<string, MilestoneDetail> {
  const result = new Map<string, MilestoneDetail>();
  if (!milestoneIds.length) return result;
  const store = getStore();
  const ids = new Set(milestoneIds);
  const milestones = store.listMilestones(ctx.workspaceId).filter((item) => ids.has(item.id));
  if (!milestones.length) return result;
  const milestoneById = new Map(milestones.map((item) => [item.id, item]));
  const rationaleByMilestone = groupBy(
    store.listEvents(ctx.workspaceId, { type: "milestone.proposed" }), (event) => event.entityId);
  const workOrdersByMilestone = groupBy(
    store.listWorkOrders(ctx.workspaceId).filter((order) => order.milestoneId && ids.has(order.milestoneId)),
    (order) => order.milestoneId);
  const relations = store.listMilestoneRelations(ctx.workspaceId);
  const titleOf = (id: string) => milestoneById.get(id)?.title ?? id;
  const backgroundByIdentity = new Map<string, StoredBackgroundFact[]>();
  const backgroundOf = (identityId: string) => {
    const cached = backgroundByIdentity.get(identityId);
    if (cached) return cached;
    const facts = store.getBackgroundFacts(ctx.workspaceId, identityId);
    backgroundByIdentity.set(identityId, facts);
    return facts;
  };

  for (const milestone of milestones) {
    const rationale = (rationaleByMilestone.get(milestone.id) ?? []).at(-1)?.payload as { rationale?: string } | undefined;
    const relatedWorkOrders = (workOrdersByMilestone.get(milestone.id) ?? [])
      .map((order) => ({ id: order.id, intent: order.intent, state: order.state }));
    result.set(milestone.id, assembleMilestoneDetail(milestone, rationale?.rationale, relatedWorkOrders,
      flywheelTouching(relations, milestone.id, titleOf), backgroundOf(milestone.identityId)));
  }
  return result;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  return groups;
}
