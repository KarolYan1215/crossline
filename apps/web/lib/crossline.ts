import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CrosslineStore, type EvidenceClaimInput, type StoredMilestone } from "@crossline/db";
import { deriveCapacity, requiredApproval, type SuccessCriterion } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { recommendNextActions } from "@crossline/planner";
import type { DashboardAction, DashboardData } from "../app/dashboard-view";

export type PersistedScheduleBlock = {
  id: string;
  lane: "human" | "ai";
  title: string;
  /** Absent on seeded examples: they illustrate a typical day rather than claiming a date. */
  day?: string;
  start: string;
  end: string;
  source: string;
  readOnly: boolean;
};

/** The local day the plan is centred on. One definition, so B, A and the sync cannot disagree. */
export function planToday(now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago" }).format(now);
}

export type PersistedPlan = {
  id: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  blocks: PersistedScheduleBlock[];
  changes: Array<{
    id: string;
    kind: "add" | "move" | "remove" | "conflict";
    explanation: string;
    afterBlockId?: string;
    status: "pending" | "approved" | "excluded";
  }>;
};

const OWNER_ID = "local-owner";
export const WORKSPACE_ID = "personal-crossline";
// The master clock is declared by a pack, so any pack set has one. Hardcoding "research" meant a
// different pack set silently had no deadline-tier identity at all.
const PRIMARY_CLOCK_ID = process.env.CROSSLINE_PRIMARY_CLOCK_ID
  ?? defaultIdentityPacks().find((pack) => pack.kind === "identity" && pack.masterClock)?.id
  ?? "";

const accents: Record<string, string> = {
  research: "#6D5EF5",
  startup: "#FF8A5B",
  media: "#E85D9E",
  investment: "#23A989"
};

/**
 * Which identities get seeded is decided by the installed packs, never by a fixed list. A hardcoded
 * list meant that swapping the packs seeded milestones for identities that no longer existed, and
 * `validateAnalysisContext` then refused every single analysis with `ANALYSIS_CONTEXT_INVALID`.
 */
const seedIdentities = () => defaultIdentityPacks().filter((pack) => pack.kind === "identity");

// Example content for the packs this repo happens to ship. Keyed by id, so an unknown identity falls
// back to a generic starter written from the pack's own label instead of being skipped.
const starterMilestoneTitles: Record<string, string> = {
  research: "稳定推进当前实验与论文",
  startup: "验证一个可付费的真实问题",
  media: "建立一次可复用的内容闭环",
  investment: "形成有证据的每周研究备忘录"
};

// `priorFamily` names which labelled prior in the identity pack this seed belongs to, so the estimate
// is read from `durationPriors` instead of being derived from a hand-written minute count.
type StarterWorkOrder = { title: string; energy: "low" | "medium" | "high"; priorFamily: string };
const starterWorkOrders: Record<string, StarterWorkOrder> = {
  research: { title: "梳理本周科研下一步", energy: "high", priorFamily: "deep_work" },
  startup: { title: "写下当前创业里程碑的一个可验证假设", energy: "medium", priorFamily: "preparation" },
  media: { title: "从本周工作中提取一个可公开选题", energy: "low", priorFamily: "review" },
  investment: { title: "整理当前美股与 ETF 关注清单", energy: "medium", priorFamily: "review" }
};

// A prior is honest only when it really comes from the pack. Deriving p25/p85 from one hand-written
// number and labelling the result `identity_prior` was a fabricated interval wearing a real label.
function identityPrior(identityId: string, family: string) {
  const pack = defaultIdentityPacks().find((item) => item.id === identityId && item.kind === "identity");
  const prior = pack?.durationPriors[family] ?? pack?.durationPriors.review;
  return { ...(prior ?? { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 }),
    source: "identity_prior" as const, observationCount: 0, confidence: "low" as const };
}

// Naming a connector here would claim an import that never happened: no calendar is authorised and no
// Codex material run exists. These blocks only exist to show what the B/C/A lens looks like.
const SEED_SOURCE = "示例数据";
// Kept as constants so the repair below can tell a stale seed from an edited one. The earlier text
// said the AI "will have prepared the inputs by 08:50" — a promise about these example blocks that
// nothing was ever going to keep. Material preparation is real now, but it only runs for work orders
// the user approved into `preparing`; it will never fire because of a demo block.
const SEED_CHANGE_TEXT: Record<string, string> = {
  "personal-plan-v1-change-1": "示例：新增 10:30 人工审阅块。这是演示数据，不会被真实执行。",
  "personal-plan-v1-change-2": "示例：新增组会材料准备块。真实材料准备只对已批准的作业运行，不会因这块触发。"
};
const starterPlanBlocks: PersistedScheduleBlock[] = [
  { id: "class", lane: "human", title: "课程 / 主时钟", start: "09:00", end: "10:15", source: SEED_SOURCE, readOnly: true },
  { id: "meeting", lane: "human", title: "组会", start: "14:00", end: "15:00", source: SEED_SOURCE, readOnly: true },
  { id: "deep-work", lane: "human", title: "审阅实验结论", start: "10:30", end: "11:30", source: SEED_SOURCE, readOnly: false },
  { id: "prep", lane: "ai", title: "汇总论文与实验异常", start: "08:10", end: "08:50", source: SEED_SOURCE, readOnly: false },
  { id: "brief", lane: "ai", title: "生成组会材料包", start: "12:45", end: "13:25", source: SEED_SOURCE, readOnly: false }
];

declare global {
  // eslint-disable-next-line no-var
  var crosslineStore: CrosslineStore | undefined;
}

export function getStore(): CrosslineStore {
  if (globalThis.crosslineStore) return globalThis.crosslineStore;
  const dataDir = process.env.CROSSLINE_DATA_DIR
    ? path.resolve(process.env.CROSSLINE_DATA_DIR)
    : path.resolve(process.cwd(), "../../data");
  mkdirSync(dataDir, { recursive: true });
  globalThis.crosslineStore = new CrosslineStore(path.join(dataDir, "crossline.db"));
  return globalThis.crosslineStore;
}

export function ensureSeeded(): void {
  const store = getStore();
  // Earlier seeds wrote no projectId, and analysis only offers milestones that have one, so an existing
  // database would stay permanently unanalysable. Re-seeding is idempotent and repairs those rows.
  const seeded = store.listMilestones(WORKSPACE_ID);
  if (seeded.length === 0 || seeded.some((milestone) => milestone.id.endsWith("-starter") && !milestone.projectId)) {
    for (const pack of seedIdentities()) {
      store.saveMilestone({
        id: `${pack.id}-starter`, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
        identityId: pack.id, projectId: `${pack.id}-default`,
        title: starterMilestoneTitles[pack.id] ?? `为「${pack.label}」确定第一个可验收的里程碑`,
        version: 1, status: "approved"
      });
    }
  }
  if (store.listMilestoneRelations(WORKSPACE_ID).length === 0) {
    const relations = [
      ["research-startup", "research-starter", "startup-starter", "informs", "approved"],
      ["startup-media", "startup-starter", "media-starter", "reuses", "approved"],
      ["media-research", "media-starter", "research-starter", "recurring_feedback", "approved"],
      ["research-investment", "research-starter", "investment-starter", "informs", "candidate"]
    ] as const;
    // These example relations describe the four packs this repo ships. Under a different pack set
    // their endpoints do not exist, and a relation pointing at a missing milestone is worse than no
    // relation at all — so it is skipped rather than seeded dangling.
    const seededMilestoneIds = new Set(store.listMilestones(WORKSPACE_ID).map((milestone) => milestone.id));
    for (const [id, fromMilestoneId, toMilestoneId, kind, status] of relations) {
      if (!seededMilestoneIds.has(fromMilestoneId) || !seededMilestoneIds.has(toMilestoneId)) continue;
      store.saveMilestoneRelation({ id, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, fromMilestoneId, toMilestoneId, kind, status });
    }
  }
  if (store.listWorkOrders(WORKSPACE_ID).length === 0) {
    for (const pack of seedIdentities()) {
      const identityId = pack.id;
      const { title, energy, priorFamily } = starterWorkOrders[identityId]
        ?? { title: `写下「${pack.label}」当前最该推进的一件事`, energy: "medium" as const, priorFamily: "review" };
      const id = `${identityId}-starter-work-order`;
      const milestoneId = store.listMilestones(WORKSPACE_ID).find((item) => item.identityId === identityId)?.id ?? `${identityId}-unassigned`;
      store.saveWorkOrder({
        id, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, identityId,
        projectId: `${identityId}-default`, milestoneId, intent: title,
        state: "ready_for_human", riskTier: "milestone",
        estimate: identityPrior(identityId, priorFamily),
        payload: { seeded: true, materialContract: [], evidenceContract: [{ kind: "record", required: true }],
          humanCore: [{ id: `${id}-core`, intent: title, energy, interruptible: true }] }
      });
    }
  }
  if (store.listPlanVersions(WORKSPACE_ID).length === 0) {
    const planId = "personal-plan-v1";
    store.savePlanVersion({
      id: planId, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      version: 1, status: "draft", payload: { blocks: starterPlanBlocks }
    });
    store.savePlanChange({
      id: "personal-plan-v1-change-1", ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      planVersionId: planId, kind: "add", triggerEventId: "seed:plan:constraints",
      explanation: SEED_CHANGE_TEXT["personal-plan-v1-change-1"]!,
      after: { blockId: "deep-work" }, status: "pending"
    });
    store.savePlanChange({
      id: "personal-plan-v1-change-2", ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      planVersionId: planId, kind: "add", triggerEventId: "seed:plan:materials",
      explanation: SEED_CHANGE_TEXT["personal-plan-v1-change-2"]!,
      after: { blockId: "brief" }, status: "pending"
    });
  }

  // Earlier seeds labelled the example blocks "UW Outlook" and "Codex" — naming connectors that were
  // never authorised, so the plan claimed imports that never happened while the page above it said the
  // opposite. Changing `SEED_SOURCE` fixed new databases only; existing rows kept the old claim, so
  // they are repaired here. Only the known seed block ids are touched: a real imported block carries
  // its own id prefix and must never be relabelled as an example.
  for (const [changeId, text] of Object.entries(SEED_CHANGE_TEXT)) {
    const change = store.listPlanChanges("personal-plan-v1").find((item) => item.id === changeId);
    if (change && change.explanation !== text) store.savePlanChange({ ...change, explanation: text });
  }
  const seedBlockIds = new Set(starterPlanBlocks.map((block) => block.id));
  for (const plan of store.listPlanVersions(WORKSPACE_ID)) {
    const blocks = (plan.payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? [];
    if (!blocks.some((block) => seedBlockIds.has(block.id) && block.source !== SEED_SOURCE)) continue;
    store.savePlanVersion({
      ...plan,
      payload: {
        blocks: blocks.map((block) => seedBlockIds.has(block.id) ? { ...block, source: SEED_SOURCE } : block)
      }
    });
  }
}

export function loadCurrentPlan(): PersistedPlan {
  ensureSeeded();
  const store = getStore();
  const stored = store.listPlanVersions(WORKSPACE_ID)[0];
  if (!stored) throw new Error("PLAN_VERSION_NOT_FOUND");
  const payload = stored.payload as { blocks?: PersistedScheduleBlock[] };
  return {
    id: stored.id,
    version: stored.version,
    status: stored.status,
    blocks: payload.blocks ?? [],
    changes: store.listPlanChanges(stored.id).map((change) => {
      const after = change.after as { blockId?: string } | undefined;
      return {
        id: change.id,
        kind: change.kind,
        explanation: change.explanation,
        ...(after?.blockId ? { afterBlockId: after.blockId } : {}),
        status: change.status
      };
    })
  };
}

export type CalendarConnectorState = {
  /** A stored delta cursor is proof a sync really completed; nothing else writes one. */
  synced: boolean;
  importedBlocks: number;
  lastChangeAt: string | null;
  lastChangeCount: number;
};

/**
 * What the calendar connector has actually done, read from the ledger rather than declared.
 *
 * The Connections page used to say "未配置凭据，未执行探测" for every row including the one connector
 * that was working — the page whose whole job is "what is connected" was wrong about the only thing
 * that was. Declared status and observed status are different claims, and only the second is useful.
 */
export function loadCalendarConnectorState(): CalendarConnectorState {
  const store = getStore();
  const cursor = store.readSyncCursor(WORKSPACE_ID, "graph_calendar", "calendarView");
  const plan = store.listPlanVersions(WORKSPACE_ID)[0];
  const blocks = ((plan?.payload as { blocks?: Array<{ id?: string }> } | undefined)?.blocks ?? [])
    .filter((block) => String(block.id).startsWith("graph_calendar:"));
  const last = store.listEvents().filter((event) => event.type === "plan.reality_changed").at(-1);
  return {
    synced: Boolean(cursor),
    importedBlocks: blocks.length,
    lastChangeAt: last?.createdAt ?? null,
    lastChangeCount: ((last?.payload as { changes?: unknown[] } | undefined)?.changes ?? []).length
  };
}

export type MilestoneInput = {
  id?: string;
  identityId: string;
  projectId: string;
  title: string;
  status: StoredMilestone["status"];
  successCriteria: SuccessCriterion[];
};

/**
 * Creates a milestone, or writes a new version of one that exists.
 *
 * Editing never overwrites: the primary key is `(id, version)`, so a change writes `version + 1` and
 * the version a gate already judged against stays readable forever. Without that, re-reading an old
 * acceptance would show it judged against criteria that did not exist at the time.
 */
export function saveMilestoneEdit(input: MilestoneInput): { ok: true; id: string; version: number } | { ok: false; code: string } {
  const title = input.title.trim();
  if (!title || title.length > 200) return { ok: false, code: "MILESTONE_TITLE_REQUIRED" };
  if (!defaultIdentityPacks().some((pack) => pack.id === input.identityId && pack.kind === "identity")) {
    return { ok: false, code: "MILESTONE_IDENTITY_UNKNOWN" };
  }
  const projectId = input.projectId.trim() || `${input.identityId}-default`;
  const store = getStore();
  const existing = input.id ? store.listMilestones(WORKSPACE_ID).find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, code: "MILESTONE_NOT_FOUND" };

  const version = existing ? existing.version + 1 : 1;
  const id = existing?.id ?? `milestone-${randomUUID()}`;
  try {
    store.saveMilestone({
      id, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      identityId: input.identityId, projectId, title,
      version, status: input.status, successCriteria: input.successCriteria
    });
  } catch (error) {
    // `saveMilestone` throws the criterion blocker code, which is the specific thing the person needs
    // to fix — collapsing it into a generic failure would hide which criterion was rejected.
    return { ok: false, code: error instanceof Error ? error.message : "MILESTONE_SAVE_FAILED" };
  }
  store.appendEvent({
    ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `milestone:saved:${id}:${version}`,
    type: existing ? "milestone.revised" : "milestone.created", entityId: id,
    payload: { version, status: input.status, title, criteria: input.successCriteria.length }
  });
  return { ok: true, id, version };
}

/**
 * Batch decision on candidate milestone relations, which is the mode `requiredApproval` asks for.
 *
 * Only candidates move. An id that is already approved, refuted or simply unknown comes back in
 * `skipped` — reporting it as decided would tell the person their click did something it did not.
 */
export function decideMilestoneRelations(ids: string[], decision: "approved" | "archived"):
  | { ok: true; decided: string[]; skipped: string[] }
  | { ok: false; code: string } {
  if (requiredApproval("approve_milestone_relations") !== "batch") return { ok: false, code: "APPROVAL_MODE_UNEXPECTED" };
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200))];
  if (!unique.length) return { ok: false, code: "NO_RELATIONS_SELECTED" };
  const store = getStore();
  // Keyed on the decision and the exact set, so a double-submitted form writes one event, and a
  // genuinely different selection later is still recorded.
  const key = `relations:${decision}:${[...unique].sort().join(",")}`.slice(0, 400);
  const result = store.decideMilestoneRelations(WORKSPACE_ID, unique, decision, key);
  return { ok: true, ...result };
}

/**
 * Resolves one pending plan change.
 *
 * Without this a conflict was a dead end: `approvePlanVersion` refuses while one is pending, and nothing
 * could move it out of `pending` — so a single calendar change would have made the plan permanently
 * unapprovable. Excluding a change is a decision, and the ledger records it as one.
 */
export function resolvePlanChange(changeId: string, status: "approved" | "excluded"):
  | { ok: true; changed: boolean } | { ok: false; code: string } {
  if (!changeId || changeId.length > 200) return { ok: false, code: "PLAN_CHANGE_NOT_FOUND" };
  const result = getStore().resolvePlanChange(WORKSPACE_ID, changeId, status, `plan-change:${changeId}:${status}`);
  return { ok: true, changed: result.changed };
}

export function approvePlanVersion(planId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const plan = store.listPlanVersions(WORKSPACE_ID).find((item) => item.id === planId);
  if (!plan) return { ok: false, code: "PLAN_VERSION_NOT_FOUND" };
  if (plan.status === "approved") return { ok: true };
  if (plan.status !== "draft") return { ok: false, code: "PLAN_VERSION_NOT_APPROVABLE" };

  const changes = store.listPlanChanges(planId);
  if (changes.some((change) => change.kind === "conflict" && change.status === "pending")) {
    return { ok: false, code: "PLAN_HAS_UNRESOLVED_CONFLICT" };
  }
  for (const change of changes) {
    store.savePlanChange({ ...change, status: change.status === "pending" ? "approved" : change.status });
  }
  store.savePlanVersion({ ...plan, status: "approved" });
  store.appendEvent({
    ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `plan-approved:${planId}`, type: "plan.approved", entityId: planId,
    payload: { from: "draft", to: "approved", approvedChangeIds: changes.filter((change) => change.status === "pending").map((change) => change.id) }
  });
  return { ok: true };
}

export function addCapturedTask(input: { title: string; context?: string }): string {
  return addCapturedTaskWithId(input, randomUUID(), `capture:${randomUUID()}`);
}

export function addCapturedTaskWithId(
  input: { title: string; context?: string },
  id: string,
  idempotencyKey: string
): string {
  getStore().capture({ id, ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    title: input.title, context: input.context ?? "" }, idempotencyKey);
  return id;
}

export type ExecutionResult = { ok: true } | { ok: false; code: string };

// A WorkOrder can be executed more than once (blocked → approved → restarted), so every execution-scoped
// idempotency key is numbered by how many executions that WorkOrder already has.
function executionRun(workOrderId: string): number {
  return getStore().listExecutions(WORKSPACE_ID).filter((item) => item.workOrderId === workOrderId).length;
}

function findWorkOrder(workOrderId: string) {
  return getStore().listWorkOrders(WORKSPACE_ID).find((item) => item.id === workOrderId);
}

export function approveWorkOrderProposal(workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "approved") return { ok: true };
  // A blocked WorkOrder is recoverable by the same human approval that admitted it; the transition table
  // has always allowed it, and refusing here would strand a real item with no way back.
  if (workOrder.state !== "awaiting_plan_approval" && workOrder.state !== "blocked") return { ok: false, code: "PROPOSAL_NOT_APPROVABLE" };
  getStore().transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "plan.approved", approvalId: OWNER_ID },
    `proposal-approved:${workOrderId}:${executionRun(workOrderId)}`);
  return { ok: true };
}

/**
 * Materials are ready. `source` records who actually prepared them: until AI preparation lands the
 * honest answer is "the human did", and a preparation that never finishes must not strand the item.
 */
export function markMaterialsReady(workOrderId: string, source: "human" | "ai"): ExecutionResult {
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "ready_for_human") return { ok: true };
  if (workOrder.state !== "preparing") return { ok: false, code: "MATERIALS_NOT_PREPARING" };
  getStore().transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "materials.ready" },
    `materials-ready:${workOrderId}:${executionRun(workOrderId)}:${source}`);
  return { ok: true };
}

/**
 * Asks for material preparation to be tried again.
 *
 * A failed preparation is deliberately not retried on a timer, so without this an order blocked by a
 * transient failure — or by a bug that has since been fixed — stayed blocked forever with only the
 * "I prepared them myself" escape.
 */
export function retryMaterialPreparation(workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "preparing") return { ok: false, code: "MATERIALS_NOT_PREPARING" };
  getStore().appendEvent({
    ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `materials:retry:${workOrderId}:${Date.now()}`,
    type: "materials.retry_requested", entityId: workOrderId, payload: { requestedBy: OWNER_ID }
  });
  return { ok: true };
}

/**
 * Discards a WorkOrder the person does not want, with their reason on the record.
 *
 * Every state in the machine has always allowed `archived`, but nothing in the app ever emitted it, so
 * a proposal the analysis got wrong stayed on the board forever with only "approve it" or "leave it
 * sitting there" as options. An accepted WorkOrder is excluded: discarding finished work would be
 * rewriting history rather than cleaning up an inbox.
 */
export function archiveWorkOrder(workOrderId: string, reason: string): ExecutionResult {
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "archived") return { ok: true };
  if (workOrder.state === "accepted") return { ok: false, code: "WORK_ORDER_ALREADY_ACCEPTED" };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, code: "ARCHIVE_REASON_REQUIRED" };
  const store = getStore();
  // The reason rides on its own event rather than the transition: `transitionWorkOrder` carries only
  // the fields the state machine itself validates, and a discard reason is a note, not a state input.
  store.appendEvent({
    ownerId: OWNER_ID, workspaceId: WORKSPACE_ID, idempotencyKey: `archive-reason:${workOrderId}`,
    type: "work_order.archived", entityId: workOrderId, payload: { reason: trimmed.slice(0, 200) }
  });
  const result = store.transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "archived" }, `archive:${workOrderId}`);
  if (!result.changed) return { ok: false, code: "WORK_ORDER_NOT_ARCHIVABLE" };
  return { ok: true };
}

/** Discards a raw capture. The WorkOrder equivalent is `archiveWorkOrder`; captures had no exit. */
export function discardCapture(captureId: string, reason: string): ExecutionResult {
  try {
    getStore().discardCapture(WORKSPACE_ID, captureId, reason);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CAPTURE_DISCARD_FAILED";
    return { ok: false, code };
  }
}

export function startWorkOrderExecution(workOrderId: string): ExecutionResult {
  const store = getStore();
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "active") return { ok: true };
  const run = executionRun(workOrderId);
  if (workOrder.state === "approved") {
    // Needing materials used to be a dead end: nothing emitted `automation.started`, so any WorkOrder
    // whose analysis did its job was stuck forever. Preparation is now a real state you pass through.
    const materials = (workOrder.payload as { materialContract?: unknown[] }).materialContract ?? [];
    // Already prepared once. Sending it back to `preparing` would strand it: the worker skips orders
    // that already have materials, so nothing would ever move it on, and the person would be looking at
    // 「材料准备中」 for materials sitting on disk. This is the path a restored-from-blocked order takes.
    if (materials.length && store.listMaterials(WORKSPACE_ID, workOrderId).length === 0) {
      store.transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "automation.started" }, `materials-preparing:${workOrderId}:${run}`);
      return { ok: false, code: "MATERIALS_PREPARING" };
    }
    store.transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "materials.not_required" }, `materials-not-required:${workOrderId}:${run}`);
  } else if (workOrder.state !== "ready_for_human") {
    return { ok: false, code: "EXECUTION_NOT_STARTABLE" };
  }
  store.transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "human.started" }, `execution:${workOrderId}:${run}:started`,
    { durationObserved: true });
  return { ok: true };
}

export function pauseWorkOrderExecution(workOrderId: string, reason: string): ExecutionResult {
  if (!reason.trim()) return { ok: false, code: "INTERRUPTION_REASON_REQUIRED" };
  if (findWorkOrder(workOrderId)?.state !== "active") return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().pauseExecution(WORKSPACE_ID, workOrderId, reason.trim());
  return { ok: true };
}

export function resumeWorkOrderExecution(workOrderId: string): ExecutionResult {
  if (findWorkOrder(workOrderId)?.state !== "active") return { ok: false, code: "NO_ACTIVE_EXECUTION" };
  getStore().resumeExecution(WORKSPACE_ID, workOrderId);
  return { ok: true };
}

export function completeWorkOrderExecution(workOrderId: string, evidence: EvidenceClaimInput[]): ExecutionResult {
  const store = getStore();
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "evidence_review") return { ok: true };
  if (workOrder.state !== "active") return { ok: false, code: "EXECUTION_NOT_ACTIVE" };
  store.transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "human.completed" },
    `execution:${workOrderId}:${executionRun(workOrderId) - 1}:completed`, { evidence });
  return { ok: true };
}

export function acceptWorkOrderEvidence(workOrderId: string): ExecutionResult {
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state === "accepted") return { ok: true };
  if (workOrder.state !== "evidence_review") return { ok: false, code: "EVIDENCE_REVIEW_NOT_READY" };
  if (workOrder.milestoneId) return { ok: false, code: "MILESTONE_GATE_REQUIRED" };
  getStore().transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "evidence.accepted", approvalId: OWNER_ID },
    `evidence-accepted:${workOrderId}:${executionRun(workOrderId)}`);
  return { ok: true };
}

export function revokeAutoAcceptedWorkOrder(workOrderId: string, reason: string): ExecutionResult {
  try {
    getStore().revokeAutoAcceptance(WORKSPACE_ID, workOrderId, reason, `auto-acceptance-revoked:${workOrderId}`);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "AUTO_ACCEPTANCE_REVOKE_FAILED";
    return { ok: false, code };
  }
}

export function blockWorkOrderEvidence(workOrderId: string, reason: string): ExecutionResult {
  if (!reason.trim()) return { ok: false, code: "BLOCK_REASON_REQUIRED" };
  const workOrder = findWorkOrder(workOrderId);
  if (!workOrder) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (workOrder.state !== "evidence_review") return { ok: false, code: "EVIDENCE_REVIEW_NOT_READY" };
  getStore().transitionWorkOrder(WORKSPACE_ID, workOrderId, { type: "blocked", reason: reason.trim() },
    `evidence-blocked:${workOrderId}:${executionRun(workOrderId)}`);
  return { ok: true };
}

// Estimates live on the WorkOrder, where they carry their own source, observation count and confidence.
// A task without one falls back to the pack's labelled prior rather than to a number invented here.
// Today reads work_orders, not tasks. Reading tasks meant a capture that was successfully analysed
// vanished from the home page, because analysis only ever writes a WorkOrder.
const ACTIONABLE = ["approved", "preparing", "ready_for_human", "active"];

type ActionableOrder = ReturnType<CrosslineStore["listWorkOrders"]>[number];

const humanCoreOf = (order: ActionableOrder) =>
  ((order.payload as { humanCore?: Array<{ energy?: string; interruptible?: boolean }> }).humanCore ?? [])[0];

const plannerTaskOf = (order: ActionableOrder) => ({
  id: order.id,
  title: order.intent,
  identityId: order.identityId,
  estimate: order.estimate,
  ...(humanCoreOf(order)?.energy ? { energy: humanCoreOf(order)!.energy as "low" | "medium" | "high" } : {}),
  // Inputs are ready once materials no longer stand between the item and the human.
  inputsReady: order.state === "ready_for_human" || order.state === "active",
  // The master clock is a declared policy, not a measurement; there are no real deadlines yet.
  deadlineTier: (order.state === "approved" ? 3 : order.identityId === PRIMARY_CLOCK_ID ? 1 : 2) as 1 | 2 | 3,
  interruptible: humanCoreOf(order)?.interruptible ?? true
});

export const LOCAL_ACTIVITY_CONSENT = "localActivity.consent";

/**
 * What last night's expansion actually did. A night that did not run says so with its reason — the
 * alternative is showing an older expansion as if it were this morning's, which is the same class of
 * lie as a fabricated metric.
 */
function lastNight(now: Date): DashboardData["lastNight"] {
  const since = new Date(now.getTime() - 36 * 60 * 60_000).toISOString();
  const event = [...getStore().listEvents()]
    .reverse()
    .find((item) => item.type.startsWith("flywheel.nightly.") && item.createdAt >= since);
  if (!event) return { state: "none" };
  const payload = event.payload as { code?: string; message?: string; proposals?: number };
  if (event.type === "flywheel.nightly.ran") return { state: "ran", proposals: payload.proposals ?? 0 };
  return { state: "skipped", reason: payload.message ?? payload.code ?? "未记录原因" };
}

const dayOf = (iso: string) => iso.slice(0, 10);

/** Interruptions per active hour, per day, from real executions — never from a guess about the day. */
function interruptionDensity(): Array<{ day: string; perActiveHour: number }> {
  const byDay = new Map<string, { interruptions: number; activeMinutes: number }>();
  for (const execution of getStore().listExecutions(WORKSPACE_ID)) {
    if (!execution.endedAt || !execution.durationObserved) continue;
    const wall = (Date.parse(execution.endedAt) - Date.parse(execution.startedAt)) / 60_000;
    const activeMinutes = Math.max(0, wall - execution.pauseMinutes);
    const day = dayOf(execution.startedAt);
    const bucket = byDay.get(day) ?? { interruptions: 0, activeMinutes: 0 };
    bucket.interruptions += execution.interruptions.length;
    bucket.activeMinutes += activeMinutes;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .filter(([, bucket]) => bucket.activeMinutes > 0)
    .map(([day, bucket]) => ({ day, perActiveHour: bucket.interruptions / (bucket.activeMinutes / 60) }));
}

function latestCapacity(now: Date): DashboardData["capacity"] {
  const store = getStore();
  const observations = store.listEnergyObservations(WORKSPACE_ID);
  const consent = store.getSetting(WORKSPACE_ID, LOCAL_ACTIVITY_CONSENT);
  return deriveCapacity({
    now: now.toISOString(),
    selfReports: observations
      .filter((item) => item.source === "self_report" && item.level !== "uncalibrated")
      .map((item) => ({ level: item.level as "low" | "medium" | "high", confidence: item.confidence, observedAt: item.observedAt })),
    dailyActivity: observations
      .filter((item) => item.source === "local_activity")
      .map((item) => ({ day: dayOf(item.observedAt), activeMinutes: item.aggregate.activeMinutes ?? 0, windowSwitches: item.aggregate.windowSwitches ?? 0 })),
    interruptionDensity: interruptionDensity(),
    localActivityConsent: consent === "granted" ? "granted" : consent === "denied" ? "denied" : "unasked"
  });
}

const toAction = (order: ActionableOrder | undefined, reason: string): DashboardAction | undefined => order ? ({
  id: order.id,
  title: order.intent,
  identityId: order.identityId,
  estimate: order.estimate,
  ...(humanCoreOf(order)?.energy ? { energy: humanCoreOf(order)!.energy as "low" | "medium" | "high" } : {}),
  reason,
  milestone: getStore().listMilestones(WORKSPACE_ID).find((item) => item.id === order.milestoneId)?.title ?? "等待确认",
  inputsReady: order.state === "ready_for_human" || order.state === "active"
}) : undefined;

export function loadDashboard(): DashboardData {
  ensureSeeded();
  const store = getStore();
  const orders = store.listWorkOrders(WORKSPACE_ID);
  // Row order must not leak into the page: `updated_at` ties break on id, so whether the clock
  // ticked mid-seed decided the order and Today reshuffled between loads.
  // Capacity is a constraint, not an identity competing for the same list. Keyed on the pack's `kind`
  // rather than the literal id "health", so a different pack set keeps the same distinction.
  const capacityIdentityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const active = orders
    .filter((order) => !capacityIdentityIds.has(order.identityId) && ACTIONABLE.includes(order.state))
    .sort((a, b) => ACTIONABLE.indexOf(a.state) - ACTIONABLE.indexOf(b.state) || a.id.localeCompare(b.id));
  const actions = recommendNextActions(active.map(plannerTaskOf), 40);
  const milestones = store.listMilestones(WORKSPACE_ID);
  const identityPacks = defaultIdentityPacks().filter((pack) => pack.kind === "identity");
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  // One declared zone for the whole day head, shared with the calendar sync rather than hardcoded
  // twice: a board whose dial, clock label and date could disagree is worse than one that is simply in
  // the wrong city. `CROSSLINE_TIME_ZONE` is the same variable `graph-sync` already reads.
  const timeZone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  const time = new Intl.DateTimeFormat("zh-CN", {
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone
  }).format(now);

  // The ordering really used is inputs-ready, then deadline tier, then estimate. There are no real
  // deadlines and no energy-window matching, so the reason may not claim either.
  const primary = toAction(active.find((task) => task.id === actions.primary?.id), "输入已就绪，且在主时钟身份中估时最短（无截止数据）");
  const lowEnergy = toAction(active.find((task) => task.id === actions.lowEnergy?.id), "标注为低精力任务，启动阻力最小");
  const shortGap = toAction(active.find((task) => task.id === actions.shortGap?.id), "先验 p85 在 40 分钟以内，可放进短空档");
  return {
    nowLabel: time,
    nowIso: now.toISOString(),
    timeZone,
    clockPinned: Boolean(process.env.CROSSLINE_FIXED_NOW),
    dateLabel: new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone }).format(now),
    monthLabel: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone }).format(now).toUpperCase(),
    capacity: latestCapacity(now),
    // Absent means never asked, so the prompt appears exactly once and the answer is remembered.
    localActivityAsked: store.getSetting(WORKSPACE_ID, LOCAL_ACTIVITY_CONSENT) !== undefined,
    lastNight: lastNight(now),
    ...(primary ? { primary } : {}),
    ...(lowEnergy ? { lowEnergy } : {}),
    ...(shortGap ? { shortGap } : {}),
    care: store.listCapacityCommitments(WORKSPACE_ID).map((item) => ({ title: item.title, minimumMinutes: item.minimumMinutes })),
    identities: identityPacks.map((pack) => {
      const identityOrders = orders.filter((order) => order.identityId === pack.id);
      const completed = identityOrders.filter((order) => order.state === "accepted").length;
      return {
        id: pack.id,
        label: pack.label,
        accent: accents[pack.id] ?? "#6D5EF5",
        completedCount: completed,
        activeMilestone: milestones.find((milestone) => milestone.identityId === pack.id)?.title ?? "等待批准里程碑",
        taskCount: identityOrders.length - completed
      };
    }),
    // Ordered by what needs the person next, then capped — not captures first, then whatever fits.
    // With captures first, six raw notes filled the whole list and the proposal that had just come back
    // from analysis was pushed off the page, which is the same broken link as never listing it at all.
    // A `discarded` capture is not listed at all; it used to fall through to the 「正在分析」 branch and
    // come back as though the system were still working on something the person had thrown away.
    upcoming: [
      ...orders.filter((order) => order.state === "awaiting_plan_approval").map((order) => ({
        id: order.id, title: order.intent, identityId: order.identityId, startsAt: "待你批准 · Approvals"
      })),
      ...active.map((order) => ({
        id: order.id, title: order.intent, identityId: order.identityId,
        startsAt: order.state === "approved" ? "已批准 · 等待材料"
          : order.state === "preparing" ? "材料准备中"
          : order.state === "active" ? "执行中"
          : `${order.estimate.p50Minutes} 分钟 · 待排程`
      })),
      ...store.listCaptures(WORKSPACE_ID)
        .filter((item) => item.state === "blocked" || item.state === "captured" || item.state === "analyzing")
        .map((item) => ({
          id: item.id, title: item.title, identityId: "unclassified",
          startsAt: item.state === "captured" ? "已保存 · 未分类 / 未估时 · Workbench 分析"
            : item.state === "blocked" ? "分析阻塞 · 可人工处理" : "正在分析"
        }))
    ].slice(0, 6),
    milestonePulse: milestones.slice(0, 4).map((milestone) => ({
      id: milestone.id,
      identity: identityPacks.find((pack) => pack.id === milestone.identityId)?.label ?? milestone.identityId,
      title: milestone.title,
      evidence: milestone.status === "approved" ? "已批准 · 等待新证据" : "等待批准"
    }))
  };
}
