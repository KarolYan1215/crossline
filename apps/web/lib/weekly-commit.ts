import "server-only";
import {
  COMMIT_GROUPS, commitWeekOf, deferTarget, groupMinutes, onPersonsBoard, parseWeeklyCommit, proposeWeeklyCommit, taskTitleOf, WEEKLY_COMMIT_SETTING, weeklyCommitDue,
  type AccessContext, type CommitGroup, type CommitSuggestion, type CommitTask, type WeeklyCommitRecord
} from "@crossline/core";
import { formatInTimeZone } from "date-fns-tz";
import { appNow, archiveWorkOrder, effectiveSchedulePreferences, effectiveWeight, firstAcceptedAt, getStore, milestoneDeadline, netCapacity, planToday, remainingMinutesOf } from "./crossline";
import { UPCOMING_SETTING } from "./schedule-memory";
import { previewOverrides, type Impact } from "./impact";
import { tOf } from "./locale";

/**
 * The weekly commitment (the owner's decision of 2026-10-28; docs/rituals.md): the week's usable hours, the week's work, and each task in
 * 保 / 推 / 砍 — suggested by `proposeWeeklyCommit` and confirmed by the person on `/commit` in one undoable step.
 */
const DAY = 86_400_000;
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const ACTIONABLE = ["approved", "preparing", "ready_for_human", "active"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CommitRow = CommitTask & { title: string; line: string; overdueDays: number; suggestion: CommitSuggestion };
export type WeeklyCommitView = {
  /** The Monday of the committed week, and its Sunday. */
  week: string; weekEnd: string;
  /** Usable minutes left in that week (calendar, fixed events and travel taken out), and the week's work in the person's minutes. */
  capacityMinutes: number; demandMinutes: number;
  rows: CommitRow[];
  /** Why it is asked now, or undefined when the page was opened by hand with nothing due. */
  due?: "weekly" | "overload";
  last?: WeeklyCommitRecord;
  /** One line about the week before (its detail is the weekly review's): what its commitment kept, pushed and cut, and what was finished. */
  lastWeek?: LastWeekRecap;
};
export type LastWeekRecap = { week: string; committed: boolean; keptMinutes: number; deferred: number; dropped: number; accepted: number };

/**
 * The week before `week`: its latest `week.committed` (if it was committed) and the tasks first accepted in it, by the person's own days.
 * Undefined when nothing was committed and nothing finished, so a new account is not shown a row of zeros.
 */
export function lastWeekRecap(ctx: AccessContext, week: string): LastWeekRecap | undefined {
  const store = getStore();
  const previous = plusDays(week, -7);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const committed = store.listEvents(ctx.workspaceId, { type: "week.committed" })
    .filter((event) => (event.payload as { week?: string }).week === previous).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const payload = (committed?.payload ?? {}) as { keptMinutes?: number; deferred?: number; dropped?: number };
  const accepted = [...firstAcceptedAt(ctx.workspaceId).values()].filter((iso) => {
    const day = formatInTimeZone(new Date(iso), zone, "yyyy-MM-dd");
    return day >= previous && day < week;
  }).length;
  if (!committed && !accepted) return undefined;
  return { week: previous, committed: Boolean(committed), keptMinutes: payload.keptMinutes ?? 0, deferred: payload.deferred ?? 0, dropped: payload.dropped ?? 0, accepted };
}

/**
 * The week's work: on the person's board and open, not held past the week (`notBefore`), and either due by the week's end (overdue
 * included), already started, or given a time this week by the scheduler (`schedule.upcoming`, the web's timer). Undated work the
 * scheduler did not place this week is not the week's demand.
 */
export function loadWeeklyCommit(ctx: AccessContext, now = appNow()): WeeklyCommitView {
  const store = getStore();
  const today = planToday(ctx, now);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const clock = formatInTimeZone(now, zone, "HH:mm");
  const last = parseWeeklyCommit(store.getSetting(ctx.workspaceId, WEEKLY_COMMIT_SETTING));
  const week = commitWeekOf(today, clock);
  const weekEnd = plusDays(week, 6);
  const horizon = Math.max(1, Math.round((Date.parse(`${weekEnd}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY) + 1);
  const capacityMinutes = Math.round(netCapacity(ctx, horizon).capacity.filter((day) => day.day >= week && day.day <= weekEnd)
    .reduce((sum, day) => sum + day.netMinutes, 0));
  let upcoming = new Set<string>();
  try { upcoming = new Set(JSON.parse(store.getSetting(ctx.workspaceId, UPCOMING_SETTING) ?? "[]") as string[]); } catch { /* none recorded yet */ }
  const started = new Set(store.listExecutions(ctx.workspaceId).map((execution) => execution.workOrderId));
  const stepsDone = new Set(store.listStepPlans(ctx.workspaceId).filter((plan) => plan.steps.some((step) => step.status === "done")).map((plan) => plan.workOrderId));
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => ACTIONABLE.includes(order.state) && !order.tombstone && onPersonsBoard(order)
    && !(order.payload as { seeded?: boolean }).seeded);
  const minutes = remainingMinutesOf(ctx, orders);
  const tasks = orders.flatMap((order) => {
    const payload = (order.payload ?? {}) as { dueDate?: string; notBefore?: string };
    const due = payload.dueDate && DATE.test(payload.dueDate) ? payload.dueDate : order.milestoneId ? milestoneDeadline(ctx, order.milestoneId) : undefined;
    const notBefore = payload.notBefore?.slice(0, 10);
    const begun = order.state === "active" || started.has(order.id) || stepsDone.has(order.id);
    if (notBefore && notBefore > weekEnd && !begun) return [];
    if (!(begun || (due && due <= weekEnd) || upcoming.has(order.id))) return [];
    const task: CommitTask = { id: order.id, minutes: Math.round(minutes.get(order.id) ?? order.estimate.p50Minutes), started: begun,
      weight: order.milestoneId ? effectiveWeight(ctx, order.milestoneId) : 50, ...(due ? { dueDay: due } : {}) };
    return [{ task, title: taskTitleOf(order), line: order.identityId }];
  });
  const { groups } = proposeWeeklyCommit({ tasks: tasks.map((item) => item.task), capacityMinutes, today, weekStart: week });
  const rows: CommitRow[] = tasks.map(({ task, title, line }) => ({ ...task, title, line,
    overdueDays: task.dueDay && task.dueDay < today ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${task.dueDay}T12:00:00Z`)) / DAY) : 0,
    suggestion: groups[task.id]! }))
    .sort((a, b) => COMMIT_GROUPS.indexOf(a.suggestion.group) - COMMIT_GROUPS.indexOf(b.suggestion.group) || (a.dueDay ?? "9999").localeCompare(b.dueDay ?? "9999"));
  const demandMinutes = tasks.reduce((sum, item) => sum + item.task.minutes, 0);
  const due = weeklyCommitDue({ today, clock, last, demandMinutes, capacityMinutes })?.reason;
  const lastWeek = lastWeekRecap(ctx, week);
  return { week, weekEnd, capacityMinutes, demandMinutes, rows, ...(due ? { due } : {}), ...(last ? { last } : {}), ...(lastWeek ? { lastWeek } : {}) };
}

/** The person's groups, every row present: what they did not touch keeps its suggestion. */
function chosenGroups(view: WeeklyCommitView, chosen: Record<string, unknown>): Record<string, CommitGroup> | undefined {
  const out: Record<string, CommitGroup> = {};
  for (const row of view.rows) {
    const value = chosen[row.id];
    if (value !== undefined && !COMMIT_GROUPS.includes(value as CommitGroup)) return undefined;
    out[row.id] = (value as CommitGroup | undefined) ?? row.suggestion.group;
  }
  return out;
}

/** What 推 and 砍 write, as the preview's overrides: a pushed task's new `notBefore` (and due day), a cut one held past any horizon. */
function changesOf(view: WeeklyCommitView, groups: Record<string, CommitGroup>) {
  const notBefore: Record<string, string> = {}, dueDates: Record<string, string> = {};
  for (const row of view.rows) {
    if (groups[row.id] === "defer") {
      const target = deferTarget(row, view.week);
      notBefore[row.id] = target.notBefore;
      if (target.dueDay) dueDates[row.id] = target.dueDay;
    }
    // Archived work leaves the schedule: in a preview it is held past the forecast instead (nothing is written there).
    if (groups[row.id] === "drop") notBefore[row.id] = "2999-12-31";
  }
  return { notBefore, dueDates };
}

export async function previewWeeklyCommit(ctx: AccessContext, chosen: Record<string, unknown>): Promise<{ ok: true; impact: Impact; keptMinutes: number } | { ok: false; code: string }> {
  const view = loadWeeklyCommit(ctx);
  const groups = chosenGroups(view, chosen);
  if (!groups) return { ok: false, code: "COMMIT_GROUP_INVALID" };
  const rows = view.rows.map((row) => ({ ...row }));
  return { ok: true, impact: await previewOverrides(ctx, changesOf(view, groups)), keptMinutes: groupMinutes(rows, groups, "keep") };
}

/**
 * 「确认本周」: 推 sets each task's `notBefore` to the Monday after the week (and its due day to that week's end when it fell before),
 * 砍 archives it with the reason said (recoverable from 已归档), and the commitment is recorded. The caller wraps it in `withUndo`, so
 * the whole confirmation is one undo. `keepAll` is 「这周不调整」: nothing moves, the week counts as committed.
 */
export function applyWeeklyCommit(ctx: AccessContext, chosen: Record<string, unknown>, options: { keepAll?: boolean; now?: Date } = {}):
  { ok: true; deferred: number; dropped: number } | { ok: false; code: string } {
  const store = getStore();
  const now = options.now ?? appNow();
  const view = loadWeeklyCommit(ctx, now);
  const groups = options.keepAll ? Object.fromEntries(view.rows.map((row) => [row.id, "keep" as const])) : chosenGroups(view, chosen);
  if (!groups) return { ok: false, code: "COMMIT_GROUP_INVALID" };
  const t = tOf(ctx);
  const { notBefore, dueDates } = changesOf(view, groups);
  let deferred = 0, dropped = 0;
  for (const row of view.rows) {
    if (groups[row.id] === "drop") {
      const result = archiveWorkOrder(ctx, row.id, t("本周承诺：不做了"));
      if (!result.ok) return result;
      dropped += 1;
      continue;
    }
    if (groups[row.id] !== "defer") continue;
    const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === row.id);
    if (!order) continue;
    const payload = (order.payload ?? {}) as Record<string, unknown>;
    store.saveWorkOrder({ ...order, payload: { ...payload, notBefore: notBefore[row.id], ...(dueDates[row.id] ? { dueDate: dueDates[row.id] } : {}) } });
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `work_order.deferred:${order.id}:${notBefore[row.id]}:${now.getTime()}`,
      type: "work_order.deferred", entityId: order.id, payload: { before: (payload.notBefore as string | undefined) ?? null, after: notBefore[row.id], by: "weekly_commit",
        ...(dueDates[row.id] ? { dueBefore: (payload.dueDate as string | undefined) ?? null, dueAfter: dueDates[row.id] } : {}) } });
    deferred += 1;
  }
  const kept = groupMinutes(view.rows, groups, "keep");
  const record: WeeklyCommitRecord = { week: view.week, at: now.toISOString(), demandMinutes: kept, capacityMinutes: view.capacityMinutes,
    // A mid-week overload is asked about once: answered, it is not asked again this week.
    ...(view.due === "overload" || view.last?.overloadAskedFor === view.week ? { overloadAskedFor: view.week } : {}) };
  // A `schedule.` setting, so the undo puts the previous commitment back too.
  store.setSetting(ctx.workspaceId, WEEKLY_COMMIT_SETTING, JSON.stringify(record));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `week.committed:${view.week}:${now.getTime()}`, type: "week.committed",
    entityId: ctx.workspaceId, payload: { week: view.week, capacityMinutes: view.capacityMinutes, demandMinutes: view.demandMinutes, keptMinutes: kept, deferred, dropped,
      reason: view.due ?? "manual" } });
  return { ok: true, deferred, dropped };
}
