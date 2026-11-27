import { randomUUID } from "node:crypto";
import { addDays, courseCodeOf, normalizeTaskTitle, taskTitleOf, textSimilarity, TASK_MERGE_REVIEW_SCHEMA, validateTaskMergeReview, tFor, type TaskMergeReview } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { buildLedgerBrief, type BriefTime } from "./ledger-brief";
import { localeOf } from "./locale";
import { ownerOf } from "./owner";

/**
 * Tasks that are the same thing as something already on the person's calendar (docs/plans/near-term-and-mail-bar-1120.md §3.4, new on
 * 2026-11-20): 「参加组会」 made from an invitation mail while the weekly meeting was already there. Code only circles candidates on cheap
 * signals — a course code in both, or titles alike, the calendar item within 14 days of the task's due day — and the model decides which
 * pairs are the same. The task is archived by the system, the calendar item kept; each one is its own undoable operation.
 */
export const MEETING_JUDGED_SETTING = "tasks.dedupe.meetingJudged";
const REVIEWER = "crossline:crossline-validation-reviewer";
const MAX_PAIRS = 12;
const PER_TASK = 2;
const SIMILAR = 0.3;
const WINDOW_DAYS = 14;
const OPEN = new Set(["awaiting_plan_approval", "approved", "ready_for_human", "blocked"]);

/** The time item's series: one weekly meeting is one candidate, whichever Tuesday's occurrence was circled. */
const seriesOf = (item: BriefTime) => item.id.split("@")[0]!;

export function meetingCandidates(store: CrosslineStore, workspaceId: string, now: Date): Array<{ taskId: string; time: BriefTime; score: number }> {
  const brief = buildLedgerBrief(store, workspaceId, now);
  const timed = brief.time.filter((item) => item.start);
  const judged = readJudged(store, workspaceId);
  const out: Array<{ taskId: string; time: BriefTime; score: number }> = [];
  for (const task of brief.openTasks.filter((item) => OPEN.has(item.state))) {
    const title = normalizeTaskTitle(task.title);
    const code = courseCodeOf(task.title);
    const near = (item: BriefTime) => !task.due || (item.day >= addDays(task.due, -WINDOW_DAYS) && item.day <= addDays(task.due, WINDOW_DAYS));
    const seen = new Set<string>();
    const scored = timed.filter(near).map((item) => ({ item, score: Math.max(textSimilarity(title, normalizeTaskTitle(item.title)),
      code && courseCodeOf(item.title) === code ? SIMILAR : 0) }))
      .filter(({ item, score }) => score >= SIMILAR && judged[`${task.id}|${seriesOf(item)}`] === undefined)
      .sort((a, b) => b.score - a.score || a.item.day.localeCompare(b.item.day))
      .filter(({ item }) => { const series = seriesOf(item); if (seen.has(series)) return false; seen.add(series); return true; })
      .slice(0, PER_TASK);
    for (const { item, score } of scored) out.push({ taskId: task.id, time: item, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_PAIRS);
}

const readJudged = (store: CrosslineStore, workspaceId: string): Record<string, boolean> => {
  try { return JSON.parse(store.getSetting(workspaceId, MEETING_JUDGED_SETTING) ?? "{}") as Record<string, boolean>; } catch { return {}; }
};

/** Asks the reviewer about the circled pairs once each, and archives every task it calls the same as its calendar item. */
export async function meetingDuplicatePass(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary, cwd: string, now = new Date()):
  Promise<Array<{ taskId: string; title: string; calendar: string }>> {
  const pairs = meetingCandidates(store, workspaceId, now);
  if (!pairs.length) return [];
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone.title]));
  const input = { version: "crossline.task-merge-review.v1", pairs: pairs.map((pair, index) => {
    const order = orders.get(pair.taskId)!;
    return { id: `p${index + 1}`,
      a: { title: taskTitleOf(order), intent: order.intent, milestone: milestones.get(order.milestoneId) ?? "", due: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "" },
      // i18n-ignore: model-facing
      b: { title: pair.time.title, intent: `已在本人日历上（${pair.time.source}）：${pair.time.day} ${pair.time.start}–${pair.time.end}`, milestone: "", due: pair.time.day },
      rule: "task_vs_calendar" };
  }) };
  const result = await runCodexSkill<TaskMergeReview>(client, input, { skillName: REVIEWER, cwd,
    developerInstructions: "Each pair is an open task (a) and an item already on the person's calendar (b). same: true only when the task is "
      + "nothing but going to that meeting or event (attending it, joining it): the calendar already holds it. A task that prepares or delivers "
      + "something for it (slides, a report, revision for an exam) is not the same, however close the words. When unsure, false. Return only the requested JSON.",
    outputSchema: TASK_MERGE_REVIEW_SCHEMA as unknown as Record<string, unknown>, prepareInput: () => input,
    validateOutput: (output) => validateTaskMergeReview(output, input.pairs.map((pair) => pair.id)), onAudit: () => {}, timeoutMs: 30 * 60_000 });
  if (!result.ok) return [];
  const judged = readJudged(store, workspaceId);
  const same: Array<(typeof pairs)[number]> = [];
  for (const answer of result.output.pairs) {
    const pair = pairs[Number(answer.id.slice(1)) - 1];
    if (!pair) continue;
    judged[`${pair.taskId}|${seriesOf(pair.time)}`] = answer.same;
    if (answer.same && !same.some((item) => item.taskId === pair.taskId)) same.push(pair);
  }
  store.setSetting(workspaceId, MEETING_JUDGED_SETTING, JSON.stringify(judged));
  const t = tFor(localeOf(store, workspaceId));
  const owner = ownerOf(store, workspaceId);
  const done: Array<{ taskId: string; title: string; calendar: string }> = [];
  for (const pair of same) {
    const order = store.listWorkOrders(workspaceId).find((item) => item.id === pair.taskId);
    if (!order || !OPEN.has(order.state)) continue;
    const title = taskTitleOf(order);
    const attempt = store.listEvents(workspaceId, { type: "work_order.changed", change: "archived", entityId: order.id }).length;
    const suffix = attempt ? `:${attempt}` : "";
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `archive-reason:${order.id}${suffix}`, type: "work_order.changed", entityId: order.id,
      payload: { reason: t("与日历上的「{{title}}」是同一件", { title: pair.time.title }), from: order.state, bySystem: true, change: "archived" } });
    store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}${suffix}`);
    // One undoable operation per task, in the shape the web's undo log reads (apps/web/lib/undo.ts): the task comes back, nothing else changed.
    const opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
      payload: { bySystem: true, label: t("归档任务：「{{task}}」已在日历上（{{calendar}}）", { task: title, calendar: pair.time.title }).slice(0, 160),
        inverse: { kind: "task.unmerge", keepId: "", payload: null, plan: null, restore: [order.id] } } });
    done.push({ taskId: order.id, title, calendar: pair.time.title });
  }
  return done;
}
