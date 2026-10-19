import { randomUUID } from "node:crypto";
import {
  TASK_MERGE_REVIEW_SCHEMA, infoRequestSteps, planMerges, spendAllows, taskTitleOf, textSimilarity, normalizeTaskTitle, validateTaskMergeReview,
  type BackgroundKind, type BackgroundSpend, type InfoRequest, type MergeGroup, type MergeTask, type TaskMergeReview
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StepPlanInput, StoredWorkOrder } from "@crossline/db";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";

/**
 * The daily self-check (the owner's decision of 2026-10-15): near-identical open tasks are merged, and a standalone request for a fact is
 * folded into the task it serves as that task's first step. The rules are `planMerges` in core; a pair they cannot settle goes once to the
 * reviewer on the low tier, only while the quota is normal and the person is around. The task with the most progress is kept; the others'
 * open steps, requests and materials move into it, and they are archived by the system with the reason 「与「X」合并」. Every merge is one
 * undoable operation (`task.unmerge` in apps/web/lib/undo.ts), and the person is told in one message which tasks were merged.
 */
export const DEDUPE_DAY_SETTING = "tasks.dedupe.day";
/** Pairs the reviewer already judged, so a pair is never asked about twice: `{"a|b": true|false}`. */
export const DEDUPE_JUDGED_SETTING = "tasks.dedupe.judged";
/**
 * The day the reviewer was last asked. The rules run once a day, but the reviewer only while the quota is normal: a day whose run came
 * while it was not (the real account, 2026-10-15: 16 pairs left open by a run at 05:40 in economy) has those pairs reviewed, and what it
 * calls the same merged, on a later tick of the same day — once, so a failing review is not retried every tick.
 */
export const DEDUPE_REVIEW_DAY_SETTING = "tasks.dedupe.reviewDay";
const REVIEWER = "crossline:crossline-validation-reviewer";
const MAX_REVIEW_PAIRS = 12;

const localDay = (store: CrosslineStore, workspaceId: string, now: Date) => {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
};

/** The board as the merge rules see it. */
export function mergeTasks(store: CrosslineStore, workspaceId: string): MergeTask[] {
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const plans = new Map(store.listStepPlans(workspaceId).map((plan) => [plan.workOrderId, plan]));
  const started = new Set(store.listExecutions(workspaceId).map((execution) => execution.workOrderId));
  return store.listWorkOrders(workspaceId).filter((order) => !(order.payload as { seeded?: boolean } | undefined)?.seeded).map((order) => {
    const payload = (order.payload ?? {}) as { dueDate?: string; dependsOn?: string[] };
    const plan = plans.get(order.id);
    return { id: order.id, identityId: order.identityId, projectId: order.projectId, milestoneId: order.milestoneId, title: taskTitleOf(order),
      intent: order.intent, state: order.state, dueDate: payload.dueDate ?? "", milestoneDeadline: anchors.get(order.milestoneId) ?? "",
      progress: plan ? plan.steps.filter((step) => step.status !== "planned").reduce((sum, step) => sum + step.share, 0) : 0,
      hasStepPlan: Boolean(plan), started: started.has(order.id), dependsOn: payload.dependsOn ?? [] };
  });
}

/** A stored plan as saveStepPlan takes it back; steps keep their status, so done ones are recognised and kept. */
type PlanSnapshot = (Omit<StepPlanInput, "steps"> & { steps: Array<StepPlanInput["steps"][number] & { status?: string }> }) | null;
const snapshotOf = (store: CrosslineStore, workspaceId: string, orderId: string): PlanSnapshot => {
  const plan = store.getStepPlan(workspaceId, orderId);
  return plan ? { archetypeId: plan.archetypeId, quantity: plan.quantity, rationale: plan.rationale, units: plan.units, questions: plan.questions,
    ...(plan.importance ? { importance: plan.importance } : {}), steps: plan.steps.map((step) => ({ ...step })) } : null;
};

/**
 * One merge: `absorb` into `keep`. The kept task's open steps stay; a request becomes a drafted email and a send at the front; another
 * task's open steps are appended (a step whose title the kept plan already has is dropped). Without a plan of its own the kept task
 * carries the requests in `infoRequests` for the step planner, or takes over the absorbed task's plan.
 */
export function applyMerge(store: CrosslineStore, workspaceId: string, group: MergeGroup, now = new Date()): { keep: string; absorbed: string[]; label: string } | undefined {
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  const keep = orders.get(group.keep);
  const absorbed = group.absorb.map((id) => orders.get(id)).filter((order): order is StoredWorkOrder => Boolean(order) && order!.state !== "archived" && order!.state !== "accepted");
  if (!keep || !absorbed.length || ["archived", "accepted"].includes(keep.state)) return undefined;
  const owner = ownerOf(store, workspaceId);
  const beforePayload = keep.payload;
  const beforePlan = snapshotOf(store, workspaceId, keep.id);
  const payload = { ...((keep.payload ?? {}) as Record<string, unknown>) } as Record<string, unknown> & {
    infoRequests?: InfoRequest[]; mergedFrom?: Array<{ id: string; title: string; kind: string; at: string }>; alsoServes?: string[]; dueDate?: string };
  let plan = beforePlan ? { ...beforePlan, steps: [...beforePlan.steps] } : null;
  const fresh = (prefix: string) => `${prefix}${randomUUID().slice(0, 6)}`;
  for (const order of absorbed) {
    const other = (order.payload ?? {}) as { infoRequests?: InfoRequest[]; dueDate?: string };
    const requests: InfoRequest[] = [...(other.infoRequests ?? [])];
    const own = group.requests[order.id];
    if (own) requests.push(own);
    const otherPlan = snapshotOf(store, workspaceId, order.id);
    if (plan) {
      const front = requests.flatMap((request) => infoRequestSteps(request, { draft: fresh("m-d"), send: fresh("m-s") }));
      const titles = plan.steps.map((step) => normalizeTaskTitle(step.title));
      const carried = group.kind === "duplicate" && otherPlan ? otherPlan.steps.filter((step) => step.status === "planned"
        && !titles.some((title) => textSimilarity(title, normalizeTaskTitle(step.title)) >= 0.8)) : [];
      plan.steps = [...front, ...plan.steps, ...carried.map((step) => ({ ...step, id: fresh("m-c"), dependsOn: [] as string[],
        why: step.why || `由「${taskTitleOf(order)}」并入` }))];
    } else if (group.kind === "duplicate" && otherPlan) {
      plan = { ...otherPlan, steps: otherPlan.steps.filter((step) => step.status === "planned").map((step) => ({ ...step })) };
      payload.infoRequests = [...(payload.infoRequests ?? []), ...requests];
    } else {
      payload.infoRequests = [...(payload.infoRequests ?? []), ...requests];
    }
    payload.mergedFrom = [...(payload.mergedFrom ?? []), { id: order.id, title: taskTitleOf(order), kind: group.kind, at: now.toISOString() }];
    if (order.milestoneId && order.milestoneId !== keep.milestoneId) payload.alsoServes = [...new Set([...(payload.alsoServes ?? []), order.milestoneId])];
    // The earlier due day holds: the kept task now has to deliver what the absorbed one promised by then.
    if (other.dueDate && (!payload.dueDate || other.dueDate < payload.dueDate)) payload.dueDate = other.dueDate;
    for (const material of store.listMaterials(workspaceId, order.id))
      store.saveMaterial({ ...material, id: `merged-${randomUUID()}`, workOrderId: keep.id });
  }
  if (!payload.infoRequests?.length) delete payload.infoRequests;
  store.saveWorkOrder({ ...keep, payload });
  if (plan) {
    // The open steps share what is left of the task's progress.
    const open = plan.steps.filter((step) => !step.status || step.status === "planned");
    const remaining = 1 - plan.steps.filter((step) => step.status && step.status !== "planned").reduce((sum, step) => sum + step.share, 0);
    const total = open.reduce((sum, step) => sum + step.share, 0) || 1;
    for (const step of open) step.share = Math.round((step.share / total) * remaining * 1000) / 1000;
    store.saveStepPlan(workspaceId, keep.id, plan, owner, "merged");
  }
  const keepTitle = taskTitleOf(keep);
  for (const order of absorbed) {
    const attempt = store.listEvents(workspaceId, { type: "work_order.archived", entityId: order.id }).length;
    const suffix = attempt ? `:${attempt}` : "";
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `archive-reason:${order.id}${suffix}`, type: "work_order.archived", entityId: order.id,
      payload: { reason: `与「${keepTitle}」合并`, from: order.state, bySystem: true, mergedInto: keep.id } });
    store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}${suffix}`);
  }
  const label = `合并任务：${absorbed.map((order) => `「${taskTitleOf(order)}」`).join("、")}并入「${keepTitle}」`;
  // One undoable operation, in the shape the web's undo log reads (apps/web/lib/undo.ts).
  const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
    payload: { label: label.slice(0, 160), inverse: { kind: "task.unmerge", keepId: keep.id, payload: beforePayload, plan: beforePlan, restore: absorbed.map((order) => order.id) } } });
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `task.merged:${keep.id}:${opId}`, type: "task.merged", entityId: keep.id,
    payload: { kind: group.kind, absorbed: absorbed.map((order) => order.id), reason: group.reason, opId } });
  return { keep: keep.id, absorbed: absorbed.map((order) => order.id), label };
}

/** Asks the reviewer about the pairs the rules left open; remembers each answer so a pair is asked once. */
export async function reviewPairs(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary, cwd: string,
  pairs: Array<{ a: string; b: string; why: string }>): Promise<Set<string>> {
  const judged = readJudged(store, workspaceId);
  const pending = pairs.filter((pair) => judged[`${pair.a}|${pair.b}`] === undefined && judged[`${pair.b}|${pair.a}`] === undefined);
  for (let at = 0; at < pending.length; at += MAX_REVIEW_PAIRS) {
    const open = pending.slice(at, at + MAX_REVIEW_PAIRS);
    const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
    const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone.title]));
    const brief = (id: string) => { const order = orders.get(id)!; return { title: taskTitleOf(order), intent: order.intent, milestone: milestones.get(order.milestoneId) ?? "",
      due: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "" }; };
    const input = { version: "crossline.task-merge-review.v1", pairs: open.map((pair, index) => ({ id: `p${index + 1}`, a: brief(pair.a), b: brief(pair.b), rule: pair.why })) };
    const result = await runCodexSkill<TaskMergeReview>(client, input, { skillName: REVIEWER, cwd,
      developerInstructions: "Decide for each pair whether the two open tasks are the same piece of work, as the duplicate-task section of the "
        + "crossline-validation-reviewer Skill describes, and return only the requested JSON. `same: true` merges them into one task that serves both "
        + "milestones; doing one must also deliver the other. Different deliverables are never the same however close the words; when unsure, false.",
      outputSchema: TASK_MERGE_REVIEW_SCHEMA as unknown as Record<string, unknown>, prepareInput: () => input,
      validateOutput: (output) => validateTaskMergeReview(output, input.pairs.map((pair) => pair.id)), onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (result.ok) {
      for (const answer of result.output.pairs) {
        const pair = open[Number(answer.id.slice(1)) - 1];
        if (pair) judged[`${pair.a}|${pair.b}`] = answer.same;
      }
      store.setSetting(workspaceId, DEDUPE_JUDGED_SETTING, JSON.stringify(judged));
    }
  }
  return new Set(Object.entries(judged).filter(([, same]) => same).map(([key]) => key));
}
const readJudged = (store: CrosslineStore, workspaceId: string): Record<string, boolean> => {
  try { return JSON.parse(store.getSetting(workspaceId, DEDUPE_JUDGED_SETTING) ?? "{}") as Record<string, boolean>; } catch { return {}; }
};

/**
 * Once a day per workspace: merge what the rules (and, for unclear pairs, the reviewer) call the same, and tell the person. A later tick
 * the same day only asks the reviewer about pairs left open because the quota was not normal at the first run (`DEDUPE_REVIEW_DAY_SETTING`).
 */
export async function dedupePass(deps: { store: CrosslineStore; workspaceId: string; cwd: string; client: () => CodexRpcBoundary | undefined;
  spend: () => Promise<BackgroundSpend>; paused: (kind: BackgroundKind) => boolean; enterUsage: (workspaceId: string) => void; now?: Date }) {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const day = localDay(store, workspaceId, now);
  if (deps.paused("planning")) return [];
  const catchUp = store.getSetting(workspaceId, DEDUPE_DAY_SETTING) === day;
  if (catchUp && store.getSetting(workspaceId, DEDUPE_REVIEW_DAY_SETTING) === day) return [];
  const judged = readJudged(store, workspaceId);
  const sameKeys = () => new Set(Object.entries(readJudged(store, workspaceId)).filter(([, same]) => same).map(([key]) => key));
  let { groups, unsure } = planMerges(mergeTasks(store, workspaceId), sameKeys());
  const open = unsure.filter((pair) => judged[`${pair.a}|${pair.b}`] === undefined && judged[`${pair.b}|${pair.a}`] === undefined);
  if (catchUp && !open.length) return [];
  if (!catchUp) store.setSetting(workspaceId, DEDUPE_DAY_SETTING, day);
  const client = deps.client();
  if (open.length && client && spendAllows(await deps.spend(), "discretionary")) {
    store.setSetting(workspaceId, DEDUPE_REVIEW_DAY_SETTING, day);
    deps.enterUsage(workspaceId);
    const same = await reviewPairs(store, workspaceId, client, deps.cwd, open).catch(() => undefined);
    if (same?.size) ({ groups, unsure } = planMerges(mergeTasks(store, workspaceId), same));
  } else if (catchUp) return [];
  // Requests first, so a task that took one in and is then merged as a duplicate carries it along.
  const ordered = [...groups.filter((group) => group.kind === "info_request"), ...groups.filter((group) => group.kind === "duplicate")];
  const done = ordered.map((group) => applyMerge(store, workspaceId, group, now)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (done.length) sayToPerson(store, workspaceId, `今天的自检合并了 ${done.reduce((sum, item) => sum + item.absorbed.length, 0)} 个重复或只需一封邮件的任务：\n${done.map((item) => `- ${item.label.replace(/^合并任务：/, "")}`).join("\n")}\n可在任务页「已归档」的「已合并」里撤销。`,
    "tasks_merged", catchUp ? `merged:${day}:review` : `merged:${day}`, [{ label: "查看", href: "/approvals" }], now);
  return done;
}
