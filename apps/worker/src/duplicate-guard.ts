import { EXISTING_TASKS_LIMIT, doneDuplicateOf, duplicateOf, type ExistingTask, type MergeTask } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { applyMerge, mergeTasks } from "./dedupe";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";

/**
 * Duplicates are prevented where tasks are written, not only merged afterwards (the owner's direction of 2026-10-15: 「确认在规划任务时就
 * 已经审阅过目前已有的任务，并不会生成重复的任务」). Two layers: the task-writing Skills (capture analysis, backplanner) are shown the open
 * tasks and say when an item only adds to one (`extendsTaskId`); and before a new task is kept it is compared with the open ones by the
 * daily merge's own rules (`duplicateOf`). A match is folded into the task already there and recorded as `task.duplicate_prevented`; a pair
 * the rules leave unsure is created as usual and left to the daily merge.
 */
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active"]);

/** The open tasks (the task library included) a Skill is shown: nearest due first, undated last. */
export function existingTasksFor(store: CrosslineStore, workspaceId: string, scope: { identityId?: string; projectId?: string } = {},
  limit = EXISTING_TASKS_LIMIT): ExistingTask[] {
  return openTasks(store, workspaceId)
    .filter((task) => (!scope.identityId || task.identityId === scope.identityId) && (!scope.projectId || task.projectId === scope.projectId))
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))
    .slice(0, limit)
    .map((task) => ({ id: task.id, title: task.title.slice(0, 120) || task.id, intent: task.intent.slice(0, 160) || task.title || task.id,
      lineId: task.identityId, projectId: task.projectId, dueDate: task.dueDate, state: task.state }));
}

export function openTasks(store: CrosslineStore, workspaceId: string): MergeTask[] {
  return mergeTasks(store, workspaceId).filter((task) => OPEN.has(task.state));
}

/** How far back finished work counts: an item the same as work accepted within this many days is already done. */
export const RECENTLY_DONE_DAYS = 30;

/** Tasks accepted within `RECENTLY_DONE_DAYS` (newest first): work a planner should not write again. */
export function recentlyDoneTasks(store: CrosslineStore, workspaceId: string, now = new Date(), days = RECENTLY_DONE_DAYS): MergeTask[] {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const acceptedAt = new Map<string, string>();
  for (const event of store.listEvents(workspaceId, { type: "work_order.transitioned" }))
    if ((event.payload as { to?: string }).to === "accepted") acceptedAt.set(event.entityId, event.createdAt);
  return mergeTasks(store, workspaceId).filter((task) => task.state === "accepted" && (acceptedAt.get(task.id) ?? "") >= since)
    .sort((a, b) => (acceptedAt.get(b.id) ?? "").localeCompare(acceptedAt.get(a.id) ?? ""));
}

export type Fold = { kind: "duplicate" | "extends" | "done"; keep: string; keepTitle: string; why: string };

/**
 * Whether `candidate` should go into an open task instead of standing on its own: the Skill's `extendsTaskId` first, then the rules;
 * last, whether it repeats work already finished (`done`, recently accepted tasks), which is then not written at all.
 */
export function decideFold(open: readonly MergeTask[], candidate: MergeTask, extendsTaskId = "", done: readonly MergeTask[] = []): Fold | undefined {
  const others = open.filter((task) => task.id !== candidate.id);
  const target = extendsTaskId ? others.find((task) => task.id === extendsTaskId) : undefined;
  if (target) return { kind: "extends", keep: target.id, keepTitle: target.title, why: `「${candidate.title}」是「${target.title}」的补充` };
  const same = duplicateOf(candidate, others);
  if (same) return { kind: "duplicate", keep: same.keep.id, keepTitle: same.keep.title, why: `与「${same.keep.title}」重复（${same.why}）` };
  const finished = doneDuplicateOf(candidate, done);
  return finished && { kind: "done", keep: finished.keep.id, keepTitle: finished.keep.title, why: `「${finished.keep.title}」已完成（${finished.why}）` };
}

/**
 * Records a prevented duplicate on the kept task. An addition reaches the kept task's steps through a replan whose feedback names it
 * (the step planner reads every earlier request, so this holds even when the task has no plan yet).
 */
export function recordFold(store: CrosslineStore, workspaceId: string, fold: Fold,
  added: { id: string; title: string; intent: string; source: "analysis" | "backplan" | "datepair" }): void {
  const ownerId = ownerOf(store, workspaceId);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `task.duplicate_prevented:${added.id}`, type: "task.duplicate_prevented", entityId: fold.keep,
    payload: { kind: fold.kind, keep: fold.keep, candidate: { id: added.id, title: added.title, intent: added.intent }, source: added.source, why: fold.why } });
  if (fold.kind === "extends") store.appendEvent({ ownerId, workspaceId, idempotencyKey: `task.extended:${added.id}`, type: "task.steps_replan_requested",
    entityId: fold.keep, payload: { feedback: `并入补充内容「${added.title}」：${added.intent}`.slice(0, 600) } });
}

/**
 * A task just written by the capture analysis, checked against the open ones: folded into the one it duplicates or adds to (an ordinary,
 * undoable merge — the capture is the person's own words, so it stays recoverable from 已归档), and the person told once.
 */
export function foldNewTask(store: CrosslineStore, workspaceId: string, id: string, extendsTaskId = "", now = new Date()): Fold | undefined {
  const open = openTasks(store, workspaceId);
  const candidate = open.find((task) => task.id === id);
  if (!candidate) return undefined;
  const fold = decideFold(open, candidate, extendsTaskId);
  if (!fold) return undefined;
  const merged = applyMerge(store, workspaceId, { kind: "duplicate", keep: fold.keep, absorb: [id], reason: fold.why, requests: {} }, now);
  if (!merged) return undefined;
  recordFold(store, workspaceId, fold, { id, title: candidate.title, intent: candidate.intent, source: "analysis" });
  sayToPerson(store, workspaceId, fold.kind === "extends"
    ? `「${candidate.title}」是已有任务「${fold.keepTitle}」的补充，已并入它的步骤。可在任务页「已归档」里撤销。`
    : `「${candidate.title}」和已有任务「${fold.keepTitle}」是同一件事，没有新建，已并入。可在任务页「已归档」里撤销。`,
  "task_duplicate_prevented", `prevented:${id}`, [{ label: "查看", href: `/workbench/${encodeURIComponent(fold.keep)}` }], now);
  return fold;
}
