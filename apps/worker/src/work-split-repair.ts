import { randomUUID } from "node:crypto";
import {
  isPersonCoreOrder, isPreparationOnlyMilestone, isWorkOwner, resplitOpenSteps, taskTitleOf, workOwner, type PlannedStep, type StepOwnerChange, type StepQuestion,
  tFor, type Locale, type WorkOwnerCode
} from "@crossline/core";
import { localeOf } from "./locale";
import { listAgentTasks, type CrosslineStore, type StepPlanInput, type StoredStepPlan, type StoredWorkOrder } from "@crossline/db";
import { localToday } from "./analysis";
import { ownerOf } from "./owner";
import { sayToPerson, type SayButton } from "./workflow-smith";

/**
 * The one-time reorganisation of the task list (docs/work-split.md §5, the owner's decision of 2026-10-21): the board was written before
 * work had an owner, so most of it was collecting and compiling the person did by hand. Once per workspace, on the tick after start:
 *
 * 1. every open order is judged by `workOwner`, except what the person is doing or has done themselves: one under way (`active`), one
 *    with a timer session of theirs, or one with a step the person marked done or partly done (the assistant's preparation steps do not
 *    count). What the assistant can make from what exists becomes the assistant's (`payload.owner = "assistant"`, pointed at the person's
 *    core task of the same milestone it prepares, its done steps and earlier outputs carried along as `payload.priorWork`); what needs one
 *    thing only the person holds becomes a question (`owner = "ask"`, shown on 待决事项); the rest stays the person's;
 * 2. the open steps of every task left to the person (not one under way) are judged again by the rules a new plan goes through
 *    (`resplitOpenSteps`): the assistant's work becomes its step (off the calendar), a step needing the person's data becomes the
 *    assistant's plus a question, a review-only step is folded into the next person's step. A task whose open steps are then all the
 *    assistant's goes to the assistant whole (as in 1), unless the person is doing it;
 * 3. duplicates are merged now (the daily dedupe, run at once; each merge keeps its own undo);
 * 4. an approved milestone left with open work but no core task of the person's is worked backwards again (`goal.backplan_rerun_requested`;
 *    the model call is core spend). A milestone that is only preparation (`isPreparationOnlyMilestone`) is not: the next milestone of the
 *    same line and project with a result of the person's own is, and when there is none the person is told the milestone could be one;
 * 5. one message says what was done, with an undo that puts the payloads and the step plans (and so the board) back. Backplans already
 *    requested and merges are not undone by it; the merges carry their own undo.
 *
 * `planWorkSplit` is the reading alone (no write), for `scripts/work-split-dry-run.ts`.
 */
// v2 (2026-10-22): run again once approving the assistant's output became a review step whatever its words (`ACCEPTS_OUTPUT` in steps.ts).
// v3 (2026-10-22 evening): a step the plan calls a decision stays the person's, one it calls gathering goes to the assistant.
export const WORK_SPLIT_REPAIR_MARKER = "repair.work-split.v3";
const CANDIDATE_STATES = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human"]);
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active", "blocked", "evidence_review"]);

export type SplitMove = { order: StoredWorkOrder; title: string; owner: "assistant" | "ask"; code: WorkOwnerCode | "steps"; reason: string; prepares: string;
  question?: string; priorWork?: { done: string[]; outputs: string[] } };
export type StepSplit = { order: StoredWorkOrder; title: string; plan: StoredStepPlan; steps: PlannedStep[]; questions: StepQuestion[]; changes: StepOwnerChange[] };
export type SplitPlan = {
  moves: SplitMove[];
  person: Array<{ order: StoredWorkOrder; title: string; code: WorkOwnerCode }>;
  /** Left alone as a whole: under way, timed by the person, with steps the person did, blocked or handed in. Their open steps may still move. */
  untouched: Array<{ order: StoredWorkOrder; title: string; why: string }>;
  /** Tasks left to the person whose open steps were judged again, with what changed. */
  steps: StepSplit[];
  /** Approved milestones that are only preparation, with the next milestone of their line and project that has a result of the person's. */
  prepOnly: Array<{ id: string; title: string; next?: { id: string; title: string } }>;
  /** Approved milestones to work backwards again: open work before, no open core task of the person's after. */
  backplan: Array<{ id: string; title: string; why: string }>;
};

const fileName = (path: string) => path.split("/").at(-1)?.split("\\").at(-1) ?? path;

export function planWorkSplit(store: CrosslineStore, workspaceId: string, now = new Date()): SplitPlan {
  const today = localToday(store, workspaceId, now);
  const orders = store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && !(order.payload as { seeded?: boolean } | undefined)?.seeded);
  const timed = new Set(store.listExecutions(workspaceId).map((execution) => execution.workOrderId));
  const plans = new Map(store.listStepPlans(workspaceId).map((plan) => [plan.workOrderId, plan]));
  // Who last moved each step's progress: the assistant (`agent`) or anyone else (the person, their report, their confirmation).
  const lastSource = new Map<string, string>();
  for (const event of store.listEvents(workspaceId, { type: "task.step_progress" })) {
    const payload = event.payload as { stepId?: string; source?: string };
    lastSource.set(`${event.entityId}#${payload.stepId ?? ""}`, String(payload.source ?? ""));
  }
  const personDid = (order: StoredWorkOrder) => (plans.get(order.id)?.steps ?? []).some((step) => step.executor !== "agent"
    && (step.status === "done" || (step.progressQuarter ?? 0) > 0) && lastSource.get(`${order.id}#${step.id}`) !== "agent");
  // What exists already, handed to the assistant with the work: the steps done and the files the assistant made for it.
  const outputs = new Map<string, string[]>();
  for (const task of listAgentTasks(store, workspaceId).filter((row) => row.status === "accepted" || row.status === "needs_review"))
    outputs.set(task.workOrderId, [...(outputs.get(task.workOrderId) ?? []), ...task.artifacts.map((artifact) => fileName(artifact.path))]);
  const priorWork = (order: StoredWorkOrder): Pick<SplitMove, "priorWork"> => {
    const done = (plans.get(order.id)?.steps ?? []).filter((step) => step.status === "done").map((step) => step.title);
    const made = outputs.get(order.id) ?? [];
    return done.length || made.length ? { priorWork: { done, outputs: made } } : {};
  };
  const moves: SplitMove[] = [];
  const person: SplitPlan["person"] = [];
  const untouched: SplitPlan["untouched"] = [];
  const steps: StepSplit[] = [];
  /** The open steps of a task left to the person, judged again (kept in `steps` when something changed); whether all are the assistant's now. */
  const resplit = (order: StoredWorkOrder, title: string): { all: boolean; split?: StepSplit } => {
    const plan = plans.get(order.id);
    const open = (plan?.steps ?? []).filter((step) => step.status === "planned");
    if (!plan || !open.length) return { all: false };
    const result = resplitOpenSteps(open, plan.questions, title, plan.steps, localeOf(store, workspaceId));
    const split = result.changes.length ? { order, title, plan, ...result } : undefined;
    return { all: result.steps.length > 0 && result.steps.every((step) => step.executor === "agent"), ...(split ? { split } : {}) };
  };
  for (const order of orders) {
    if (!OPEN.has(order.state)) continue;
    const title = taskTitleOf(order);
    const recorded = (order.payload as { owner?: unknown } | undefined)?.owner;
    // Already judged when it was written (the backplanner since 2026-10-22): its owner stands, and a person's task has its steps judged.
    if (isWorkOwner(recorded)) {
      if (recorded !== "person") continue;
      person.push({ order, title, code: "model" });
      const { split } = CANDIDATE_STATES.has(order.state) ? resplit(order, title) : {};
      if (split) steps.push(split);
      continue;
    }
    /* i18n-ignore-start: why a task was left as it is, for the dry-run script */
    if (!CANDIDATE_STATES.has(order.state)) { untouched.push({ order, title, why: order.state === "active" ? "正在进行" : order.state === "evidence_review" ? "已交付待验收" : "已受阻" }); continue; }
    const doing = timed.has(order.id) ? "本人计过时" : personDid(order) ? "本人做过其中的步骤" : "";
    /* i18n-ignore-end */
    if (doing) {
      untouched.push({ order, title, why: doing });
      const { split } = resplit(order, title);
      if (split) steps.push(split);
      continue;
    }
    const verdict = workOwner(order);
    if (verdict.owner === "person") {
      const { all, split } = resplit(order, title);
      if (all) moves.push({ order, title, owner: "assistant", code: "steps", reason: tFor(localeOf(store, workspaceId))("未完成的步骤都是助手可做的准备"), prepares: "", ...priorWork(order) });
      else { person.push({ order, title, code: verdict.code }); if (split) steps.push(split); }
      continue;
    }
    moves.push({ order, title, owner: verdict.owner, code: verdict.code, reason: verdict.reason, prepares: "", ...priorWork(order),
      ...(verdict.owner === "ask" ? { question: verdict.question ?? tFor(localeOf(store, workspaceId))("「{{title}}」需本人提供哪些信息或文件？", { title }) } : {}) });
  }
  // What each move prepares: the person's core task of the same milestone that waits on it, else the soonest of that milestone (for work
  // with no milestone, of the same project); none, and it serves no task (the assistant still does it).
  const cores = [...person.map((item) => item.order), ...untouched.map((item) => item.order).filter((order) => CANDIDATE_STATES.has(order.state) || order.state === "active")];
  const coreList = [...new Map(cores.map((order) => [order.id, order])).values()].filter((order) => OPEN.has(order.state));
  const dueOf = (order: StoredWorkOrder) => (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "9999";
  for (const move of moves) {
    const sameMilestone = coreList.filter((order) => move.order.milestoneId && order.milestoneId === move.order.milestoneId);
    const waits = sameMilestone.find((order) => ((order.payload as { dependsOn?: string[] } | undefined)?.dependsOn ?? []).includes(move.order.id));
    const pick = (list: StoredWorkOrder[]) => [...list].sort((a, b) => dueOf(a).localeCompare(dueOf(b)))[0];
    // Another milestone's task in the same project is other work: only work with no milestone looks project-wide.
    move.prepares = (waits ?? pick(sameMilestone) ?? (move.order.milestoneId ? undefined : pick(coreList.filter((order) => order.projectId
      && order.projectId === move.order.projectId && order.identityId === move.order.identityId))))?.id ?? "";
  }

  // Milestones.
  const deadlines = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const approved = store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved");
  const prepIds = new Set(approved.filter((milestone) => isPreparationOnlyMilestone(milestone)).map((milestone) => milestone.id));
  const moved = new Set(moves.map((move) => move.order.id));
  const serves = (order: StoredWorkOrder) => [order.milestoneId, ...((order.payload as { alsoServes?: string[] } | undefined)?.alsoServes ?? [])];
  const openBefore = new Set(orders.filter((order) => OPEN.has(order.state)).flatMap(serves));
  const coreAfter = new Set(orders.filter((order) => OPEN.has(order.state) && !moved.has(order.id) && isPersonCoreOrder(order)).flatMap(serves));
  const live = (id: string) => { const deadline = deadlines.get(id); return !deadline || deadline >= today; };
  const backplan = new Map<string, { id: string; title: string; why: string }>();
  for (const milestone of approved) {
    if (prepIds.has(milestone.id) || !milestone.projectId || !live(milestone.id)) continue;
    if (openBefore.has(milestone.id) && !coreAfter.has(milestone.id))
      backplan.set(milestone.id, { id: milestone.id, title: milestone.title, why: "名下只剩准备工作，没有本人的核心任务" }); // i18n-ignore: the backplanner's brief
  }
  const prepOnly = approved.filter((milestone) => prepIds.has(milestone.id)).map((milestone) => {
    const from = deadlines.get(milestone.id) ?? today;
    const next = approved.filter((other) => !prepIds.has(other.id) && other.identityId === milestone.identityId && other.projectId === milestone.projectId
      && live(other.id) && (deadlines.get(other.id) ?? "9999") >= from).sort((a, b) => (deadlines.get(a.id) ?? "9999").localeCompare(deadlines.get(b.id) ?? "9999"))[0];
    if (next && !coreAfter.has(next.id)) backplan.set(next.id, { id: next.id, title: next.title, why: `「${milestone.title}」只是它的准备，由它来推动本人的核心工作` }); // i18n-ignore: the backplanner's brief
    return { id: milestone.id, title: milestone.title, ...(next ? { next: { id: next.id, title: next.title } } : {}) };
  });
  return { moves, person, untouched, steps, prepOnly, backplan: [...backplan.values()] };
}

/** A stored plan's open steps as `saveStepPlan` takes them: what the undo writes back (the done steps stay where they are). */
export function openStepsInput(plan: StoredStepPlan, steps: ReadonlyArray<StepPlanInput["steps"][number]> = plan.steps.filter((step) => step.status === "planned"),
  questions: StepPlanInput["questions"] = plan.questions): StepPlanInput {
  return { archetypeId: plan.archetypeId, quantity: plan.quantity, rationale: plan.rationale, units: plan.units, questions: questions ?? [],
    ...(plan.importance ? { importance: plan.importance } : {}),
    steps: steps.map((step) => ({ id: step.id, role: step.role, title: step.title, deliverable: step.deliverable, doneCriterion: step.doneCriterion, share: step.share,
      estimate: { ...step.estimate }, dependsOn: [...step.dependsOn], notBefore: step.notBefore, dueBy: step.dueBy, schedulable: step.schedulable, executor: step.executor,
      tickOutcome: step.tickOutcome, covers: step.covers ?? [], why: step.why ?? "", ...(step.aiAssist?.tool ? { aiAssist: step.aiAssist } : {}),
      ...(step.firstAction ? { firstAction: step.firstAction } : {}) })) };
}

export type SplitOutcome = { assistant: number; ask: number; steps: number; tasksWithSteps: number; merged: number; backplan: string[];
  prepOnly: SplitPlan["prepOnly"]; opId?: string };

export async function workSplitRepair(store: CrosslineStore, workspaceId: string, options: { now?: Date; mergeNow?: () => Promise<number> } = {}):
  Promise<SplitOutcome | undefined> {
  if (store.getSetting(workspaceId, WORK_SPLIT_REPAIR_MARKER)) return undefined;
  const now = options.now ?? new Date();
  // Marked first: a failure part way must not reorganise twice.
  store.setSetting(workspaceId, WORK_SPLIT_REPAIR_MARKER, now.toISOString());
  const plan = planWorkSplit(store, workspaceId, now);
  const owner = ownerOf(store, workspaceId);
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const entries: Array<{ id: string; payload: unknown; state: string }> = [];
  for (const move of plan.moves) {
    entries.push({ id: move.order.id, payload: move.order.payload, state: move.order.state });
    store.saveWorkOrder({ ...move.order, payload: { ...((move.order.payload ?? {}) as Record<string, unknown>), owner: move.owner, ownerReason: move.reason,
      prepares: move.prepares, reorganized: WORK_SPLIT_REPAIR_MARKER, ...(move.question ? { question: move.question } : {}),
      ...(move.priorWork ? { priorWork: move.priorWork } : {}) } });
  }
  // Steps: the plan's open steps as they were, for the undo, then the steps as judged again (done steps are kept by `saveStepPlan`).
  const plansBefore: Array<{ workOrderId: string; plan: StepPlanInput }> = [];
  for (const split of plan.steps) {
    plansBefore.push({ workOrderId: split.order.id, plan: openStepsInput(split.plan) });
    store.saveStepPlan(workspaceId, split.order.id, openStepsInput(split.plan, split.steps, split.questions), owner, "work-split");
  }
  const changedSteps = plan.steps.reduce((sum, split) => sum + split.changes.length, 0);
  let opId: string | undefined;
  if (entries.length || plansBefore.length) {
    opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    const items = [...(entries.length ? [{ kind: "work_order.payload", entries }] : []), ...(plansBefore.length ? [{ kind: "step_plan.restore", plans: plansBefore }] : [])];
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
      payload: { bySystem: true, label: t("任务分工整理：{{assistant}} 项转给助手、{{ask}} 项改为问题、{{steps}} 个步骤重新分工",
        { assistant: plan.moves.filter((move) => move.owner === "assistant").length, ask: plan.moves.filter((move) => move.owner === "ask").length, steps: changedSteps }),
        inverse: items.length === 1 ? items[0] : { kind: "batch", items } } });
  }
  const merged = options.mergeNow ? await options.mergeNow().catch(() => 0) : 0;
  for (const milestone of plan.backplan)
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `goal:backplan:rerun:${milestone.id}:work-split`, type: "goal.backplan_rerun_requested",
      entityId: milestone.id, payload: { reason: "work_split", why: milestone.why } });
  const assistant = plan.moves.filter((move) => move.owner === "assistant").length;
  const ask = plan.moves.filter((move) => move.owner === "ask").length;
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `work_split.reorganized:${WORK_SPLIT_REPAIR_MARKER}`, type: "work_split.reorganized", entityId: workspaceId,
    payload: { assistant: plan.moves.filter((move) => move.owner === "assistant").map((move) => move.order.id), ask: plan.moves.filter((move) => move.owner === "ask").map((move) => move.order.id),
      steps: plan.steps.map((split) => ({ workOrderId: split.order.id, changes: split.changes })), merged, backplan: plan.backplan.map((item) => item.id),
      prepOnly: plan.prepOnly.map((item) => item.id), ...(opId ? { opId } : {}) } });
  const lonely = plan.prepOnly.filter((item) => !item.next);
  const text = workSplitMessage({ assistant, ask, steps: changedSteps, tasksWithSteps: plan.steps.length, merged,
    backplan: plan.backplan.map((item) => item.title), lonely: lonely.map((item) => item.title) }, locale);
  if (text) {
    const buttons: SayButton[] = [
      ...(opId ? [{ label: t("撤销整理"), action: { action: "undo", summary: t("撤销任务分工整理"), args: { opId } } }] : []),
      ...(ask ? [{ label: t("回答问题"), href: "/approvals#asks" }] : []),
      ...lonely.slice(0, 2).map((item) => ({ label: t("看「{{title}}」", { title: item.title.slice(0, 12) }), href: `/milestones?open=${encodeURIComponent(item.id)}` }))
    ];
    sayToPerson(store, workspaceId, text, "work_split", `work-split:${WORK_SPLIT_REPAIR_MARKER}`, buttons, now);
  }
  return { assistant, ask, steps: changedSteps, tasksWithSteps: plan.steps.length, merged, backplan: plan.backplan.map((item) => item.id), prepOnly: plan.prepOnly,
    ...(opId ? { opId } : {}) };
}

/** The one message, in the app's words (third person, docs/copy-style.md); empty when nothing changed. */
export function workSplitMessage(input: { assistant: number; ask: number; steps?: number; tasksWithSteps?: number; merged: number; backplan: string[]; lonely: string[] },
  locale?: Locale): string {
  const t = tFor(locale);
  const names = (titles: string[]) => {
    const shown = titles.slice(0, 4).map((title) => locale === "en" ? `"${title.slice(0, 24)}"` : `「${title.slice(0, 24)}」`).join(locale === "en" ? ", " : "");
    return titles.length > 4 ? t("{{names}} 等 {{count}} 个", { names: shown, count: titles.length }) : shown;
  };
  const parts = [
    input.assistant ? t("{{count}} 项收集、整理类的准备转给助手做，结果放在要用它的任务的「已备好」里，不再占本人的日程", { count: input.assistant }) : "",
    input.ask ? t("{{count}} 项只需本人提供一点信息，改成了待决事项里的问题，答完由助手接着做", { count: input.ask }) : "",
    input.steps ? t("{{tasks}} 个本人任务里的 {{count}} 个步骤重新分工：收集整理交给助手，只验收的步骤并入开始时的一眼", { tasks: input.tasksWithSteps ?? 0, count: input.steps }) : "",
    input.merged ? t("合并了 {{count}} 个重复任务", { count: input.merged }) : "",
    input.backplan.length ? t("{{names}}名下没有本人的核心任务，正在重新倒推出来", { names: names(input.backplan) }) : "",
    input.lonely.length ? t("{{names}}只是准备，建议改成以本人的产出为标准的里程碑", { names: names(input.lonely) }) : ""
  ].filter(Boolean);
  if (!parts.length) return "";
  return t("任务清单已按「本人做核心、助手做准备」重新整理：{{parts}}。整理可以撤销。", { parts: parts.join(locale === "en" ? "; " : "；") });
}
