import { EXISTING_TASKS_LIMIT, comparePair, duplicateOf, tFor, type ExistingTask, type Locale, type MergeTask } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { applyMerge, mergeTasks } from "./dedupe";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";
import { localeOf, tOfWorkspace } from "./locale";

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

export type Fold = { kind: "duplicate" | "extends"; keep: string; keepTitle: string; why: string };

/** Whether `candidate` should go into an open task instead of standing on its own: the Skill's `extendsTaskId` first, then the rules. */
export function decideFold(open: readonly MergeTask[], candidate: MergeTask, extendsTaskId = "", locale?: Locale): Fold | undefined {
  const t = tFor(locale);
  const others = open.filter((task) => task.id !== candidate.id);
  const target = extendsTaskId ? others.find((task) => task.id === extendsTaskId) : undefined;
  if (target) return { kind: "extends", keep: target.id, keepTitle: target.title, why: t("「{{title}}」是「{{target}}」的补充", { title: candidate.title, target: target.title }) };
  const same = duplicateOf(candidate, others);
  // The rule's own reason, in this language (`duplicateOf` gives it in Chinese).
  const why = same && locale ? comparePair(candidate, same.keep, locale).why : same?.why;
  return same && { kind: "duplicate", keep: same.keep.id, keepTitle: same.keep.title, why: t("与「{{title}}」重复（{{why}}）", { title: same.keep.title, why }) };
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
    // i18n-ignore: the brief for the next plan (model-facing)
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
  const t = tOfWorkspace(store, workspaceId);
  const fold = decideFold(open, candidate, extendsTaskId, localeOf(store, workspaceId));
  if (!fold) return undefined;
  const merged = applyMerge(store, workspaceId, { kind: "duplicate", keep: fold.keep, absorb: [id], reason: fold.why, requests: {} }, now);
  if (!merged) return undefined;
  recordFold(store, workspaceId, fold, { id, title: candidate.title, intent: candidate.intent, source: "analysis" });
  const values = { title: candidate.title, keep: fold.keepTitle };
  sayToPerson(store, workspaceId, fold.kind === "extends"
    ? t("「{{title}}」是已有任务「{{keep}}」的补充，已并入它的步骤。可在任务页「已归档」里撤销。", values)
    : t("「{{title}}」和已有任务「{{keep}}」是同一件事，没有新建，已并入。可在任务页「已归档」里撤销。", values),
  "task_duplicate_prevented", `prevented:${id}`, [{ label: t("查看", { context: "view" }), href: `/workbench/${encodeURIComponent(fold.keep)}` }], now);
  return fold;
}
