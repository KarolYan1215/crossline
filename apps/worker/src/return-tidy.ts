import { randomUUID } from "node:crypto";
import { goalSettingKey, shiftWithChain, taskTitleOf, tFor } from "@crossline/core";
import { localeOf } from "./locale";
import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";
import { localToday } from "./analysis";
import { ownerOf } from "./owner";
import { sayToPerson } from "./workflow-smith";

/**
 * The return tidy-up (the owner's request of 2026-10-21, after a week away left the board with duplicates, deadlines in the past and
 * proposals nobody would approve). Once per absence of `AWAY_HOURS` or more, as soon as the person acts again — whether or not they open
 * the return page, which they may skip — the worker:
 *
 * 1. **shifts their own milestones that fell due while they were away** and still have open work, by the length of the absence (at least
 *    to `SHIFT_MIN_DAYS` from today), with the later milestones of the same line and project that would now come before them, so the
 *    chain keeps its order. A course's milestones never move: an exam or a due day is the course's, not the person's.
 * 2. **archives what is old**: proposals untouched for `STALE_DAYS`, open work whose milestone is no longer approved, and work never
 *    started whose own due day passed `STALE_DAYS` ago. Archived by the system, with the reason, recoverable from 已归档.
 * 3. **merges duplicates at once** (the daily dedupe, run now; `mergeNow`), within the rules — one exam's material is never another's.
 *
 * What it did is one undoable operation (`op.applied`, the web's undo log) and one message linking the return page, where the progress
 * of what had a time while they were away is still asked about task by task. The schedule is derived, so it re-plans by itself.
 */
export const RETURN_TIDY_SETTING = "return.tidied";
export const AWAY_HOURS = 48;
export const STALE_DAYS = 14;
export const SHIFT_MIN_DAYS = 3;
const DAY = 86_400_000;
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active", "blocked"]);
const GRADED = new Set(["quiz", "exam", "homework_due", "homework_out", "project_due"]);

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

/** The absence the person just came back from, if it is not tidied yet: its start (last action before) and end (first action after). */
export function absenceToTidy(store: CrosslineStore, workspaceId: string, now = new Date()): { since: string; until: string; days: number } | undefined {
  const times = store.personActivityTimes(workspaceId, new Date(now.getTime() - 60 * DAY).toISOString());
  for (let index = times.length - 1; index > 0; index -= 1) {
    const since = times[index - 1]!, until = times[index]!;
    if (Date.parse(until) - Date.parse(since) < AWAY_HOURS * 3_600_000) continue;
    // Only a return that just happened: an older absence was the page's to settle at the time.
    if (now.getTime() - Date.parse(until) > 3 * DAY) return undefined;
    if (store.getSetting(workspaceId, RETURN_TIDY_SETTING) === since) return undefined;
    return { since, until, days: Math.ceil((Date.parse(until) - Date.parse(since)) / DAY) };
  }
  return undefined;
}

/** Projects that are courses: a grade breakdown on record, homework dated from the course's files, or graded items read from them. */
export function courseProjects(store: CrosslineStore, workspaceId: string): Set<string> {
  const out = new Set<string>();
  for (const fact of store.listProfileFacts(workspaceId)) if (fact.slot === "grading" && fact.projectId) out.add(fact.projectId);
  for (const order of store.listWorkOrders(workspaceId)) if (order.id.startsWith("datepair-") && order.projectId) out.add(order.projectId);
  for (const event of store.listEvents(workspaceId, { type: "dates.extracted" }))
    for (const item of (event.payload as { dates?: Array<{ project?: string; kind?: string }> }).dates ?? [])
      if (item.project && item.kind && GRADED.has(item.kind)) out.add(item.project);
  return out;
}

type Settings = { confirmedDeadline?: string | null; [key: string]: unknown };
export type TidyOutcome = { shifted: Array<{ id: string; title: string; from: string; to: string }>; archived: Array<{ id: string; title: string; why: string }>;
  merged: number; opId?: string };
export type UndoEntry = { key: string; value: string | null };

/** A milestone's deadline as the scheduler reads it: the goal setting's, else the approved milestone's own. */
export function deadlineReader(store: CrosslineStore, workspaceId: string) {
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const settingsOf = (id: string) => json<Settings | null>(store.getSetting(workspaceId, goalSettingKey(id)), null);
  return { settingsOf, deadlineOf: (id: string) => settingsOf(id)?.confirmedDeadline || anchors.get(id) || "" };
}

/**
 * Writes milestone deadline moves as the system's (`goal.settings_confirmed` with `bySystem`), returning what an undo restores and what
 * moved. Shared by the return tidy-up and the daily pass (`date-advance.ts`).
 */
export function writeDeadlineMoves(store: CrosslineStore, workspaceId: string, moves: Map<string, string>, bySystem: string):
  { restore: UndoEntry[]; shifted: TidyOutcome["shifted"] } {
  const owner = ownerOf(store, workspaceId);
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  const { settingsOf, deadlineOf } = deadlineReader(store, workspaceId);
  const restore: UndoEntry[] = [];
  const shifted: TidyOutcome["shifted"] = [];
  for (const [id, to] of moves) {
    const key = goalSettingKey(id);
    const previous = store.getSetting(workspaceId, key) ?? null;
    const from = deadlineOf(id);
    if (from === to) continue;
    restore.push({ key, value: previous });
    store.setSetting(workspaceId, key, JSON.stringify({ ...(settingsOf(id) ?? {}), confirmedDeadline: to }));
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `goal:settings:${id}:${randomUUID()}`, type: "goal.settings_confirmed", entityId: id,
      payload: { milestoneVersion: milestones.get(id)?.version ?? 1, previous: json(previous, null), next: { confirmedDeadline: to }, bySystem } });
    shifted.push({ id, title: milestones.get(id)?.title ?? id, from, to });
  }
  return { restore, shifted };
}

/**
 * Open work whose moment is long gone: a proposal untouched for `STALE_DAYS`, work whose milestone is no longer approved, and work never
 * started whose own due day passed `STALE_DAYS` ago. Started work and work with progress are never in it.
 */
export function staleOpenWork(store: CrosslineStore, workspaceId: string, now: Date, today: string): Array<{ order: StoredWorkOrder; why: string }> {
  const milestones = new Map(store.listMilestones(workspaceId).map((milestone) => [milestone.id, milestone]));
  const cutoff = new Date(now.getTime() - STALE_DAYS * DAY).toISOString();
  const lastMove = new Map<string, string>();
  const started = new Set<string>();
  for (const event of store.listEvents(workspaceId, { type: "work_order.transitioned" })) {
    if ((lastMove.get(event.entityId) ?? "") < event.createdAt) lastMove.set(event.entityId, event.createdAt);
    if ((event.payload as { event?: { type?: string } }).event?.type === "human.started") started.add(event.entityId);
  }
  const progressOf = (order: StoredWorkOrder) => (store.getStepPlan(workspaceId, order.id)?.steps ?? []).some((step) => step.status === "done" || (step.progressQuarter ?? 0) > 0);
  const t = tFor(localeOf(store, workspaceId));
  return store.listWorkOrders(workspaceId).filter((order) => OPEN.has(order.state) && !order.tombstone).flatMap((order) => {
    if (order.state === "active" || started.has(order.id) || progressOf(order)) return [];
    const milestone = order.milestoneId ? milestones.get(order.milestoneId) : undefined;
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "";
    // A proposal whose own due day went by unapproved is no longer a decision anyone can make in time (2026-10-27: 「确定周五会议议题」
    // still asked for approval five days after that Friday, and was Today's 「下一步」).
    const why = order.state === "awaiting_plan_approval" && due && due < today ? t("提议的截止 {{due}} 已过，仍未批准", { due })
      : order.state === "awaiting_plan_approval" && (lastMove.get(order.id) ?? now.toISOString()) <= cutoff ? t("提议超过 {{days}} 天无人处理", { days: STALE_DAYS })
      : order.milestoneId && milestone?.status !== "approved" ? t("所服务的里程碑已不在")
      : due && due <= addDays(today, -STALE_DAYS) ? t("截止 {{due}} 已过 {{days}} 天以上且未开始", { due, days: STALE_DAYS })
      : "";
    return why ? [{ order, why }] : [];
  });
}

/** Archives work by the system with the reason (recoverable from 已归档). */
export function archiveBySystem(store: CrosslineStore, workspaceId: string, items: Array<{ order: StoredWorkOrder; why: string }>, by: "return" | "date" | "mail"): TidyOutcome["archived"] {
  const owner = ownerOf(store, workspaceId);
  const t = tFor(localeOf(store, workspaceId));
  const reasonOf = (why: string) => by === "return" ? t("回来整理：{{why}}", { why }) : by === "mail" ? t("转为提醒：{{why}}", { why }) : t("到期整理：{{why}}", { why });
  return items.map(({ order, why }) => {
    const attempt = store.listEvents(workspaceId, { type: "work_order.archived", entityId: order.id }).length;
    const suffix = attempt ? `:${attempt}` : "";
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `archive-reason:${order.id}${suffix}`, type: "work_order.archived", entityId: order.id,
      payload: { reason: reasonOf(why), from: order.state, bySystem: true } });
    store.transitionWorkOrder(workspaceId, order.id, { type: "archived" }, `archive:${order.id}${suffix}`);
    return { id: order.id, title: taskTitleOf(order), why };
  });
}

export async function returnTidy(store: CrosslineStore, workspaceId: string, options: { now?: Date; mergeNow?: () => Promise<number> } = {}):
  Promise<TidyOutcome | undefined> {
  const now = options.now ?? new Date();
  const absence = absenceToTidy(store, workspaceId, now);
  if (!absence) return undefined;
  // Marked first: a failure part way must not tidy the same absence twice.
  store.setSetting(workspaceId, RETURN_TIDY_SETTING, absence.since);
  const today = localToday(store, workspaceId, now);
  const owner = ownerOf(store, workspaceId);
  const open = store.listWorkOrders(workspaceId).filter((order) => OPEN.has(order.state) && !order.tombstone);
  const { deadlineOf } = deadlineReader(store, workspaceId);

  // 1. The person's own milestones that fell due while they were away, and what would now come before them.
  const courses = courseProjects(store, workspaceId);
  const approved = store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved" && !courses.has(milestone.projectId ?? ""))
    .map((milestone) => ({ id: milestone.id, line: milestone.identityId, project: milestone.projectId ?? "", deadline: deadlineOf(milestone.id) }));
  const withOpenWork = new Set(open.map((order) => order.milestoneId).filter(Boolean));
  const shiftDays = absence.days;
  const moves = shiftWithChain(approved, approved.filter((milestone) => milestone.deadline && milestone.deadline < today && withOpenWork.has(milestone.id))
    .map((milestone) => ({ id: milestone.id, days: shiftDays, to: [addDays(milestone.deadline, shiftDays), addDays(today, SHIFT_MIN_DAYS)].sort().at(-1)! })));
  const { restore, shifted } = writeDeadlineMoves(store, workspaceId, moves, "return_tidy");

  // 2. What is old.
  const archived = archiveBySystem(store, workspaceId, staleOpenWork(store, workspaceId, now, today), "return");

  // One undo for both: the dates back, the archived work restored. Merges carry their own undo.
  let opId: string | undefined;
  if (restore.length || archived.length) {
    opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    const items = [...(restore.length ? [{ kind: "settings.restore", entries: restore }] : []), ...(archived.length ? [{ kind: "work_order.restore", ids: archived.map((item) => item.id) }] : [])];
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `op.applied:${opId}`, type: "op.applied", entityId: opId,
      payload: { bySystem: true, label: tFor(localeOf(store, workspaceId))("回来整理：顺延 {{shifted}} 个里程碑、归档 {{archived}} 个旧任务", { shifted: shifted.length, archived: archived.length }), inverse: items.length === 1 ? items[0] : { kind: "batch", items } } });
  }

  // 3. Duplicates, merged now rather than at tomorrow's self-check.
  const merged = options.mergeNow ? await options.mergeNow().catch(() => 0) : 0;

  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const sep = locale === "en" ? "; " : "；";
  const moved = shifted.slice(0, 4).map((item) => locale === "en" ? `"${item.title.slice(0, 20)}" ${item.from.slice(5)} → ${item.to.slice(5)}` : `「${item.title.slice(0, 20)}」${item.from.slice(5)} → ${item.to.slice(5)}`).join(sep);
  const reasons = [...new Set(archived.map((item) => item.why.replace(/\d{4}-\d{2}-\d{2}/, "").replace(/\s+/g, locale === "en" ? " " : "").trim()))].join(sep);
  const parts = [
    shifted.length ? (shifted.length > 4
      ? t("离开期间到期、还有没做完的工作的 {{count}} 个里程碑顺延了 {{days}} 天：{{moved}} 等", { count: shifted.length, days: shiftDays, moved })
      : t("离开期间到期、还有没做完的工作的 {{count}} 个里程碑顺延了 {{days}} 天：{{moved}}", { count: shifted.length, days: shiftDays, moved })) : "",
    archived.length ? t("归档了 {{count}} 个旧任务（{{reasons}}），可在任务页「已归档」恢复", { count: archived.length, reasons }) : "",
    merged ? t("合并了 {{count}} 个重复任务", { count: merged }) : ""
  ].filter(Boolean);
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `return.tidied:${absence.since}`, type: "return.tidied", entityId: workspaceId,
    payload: { since: absence.since, until: absence.until, days: absence.days, shifted, archived, merged, ...(opId ? { opId } : {}) } });
  sayToPerson(store, workspaceId, parts.length
    ? t("离开 {{days}} 天回来，已整理任务库：{{parts}}。排程已按新日期重排；整理可在「最近操作」里撤销。离开期间排了时间的任务，请在回来页确认做到哪了。", { days: absence.days, parts: parts.join(sep) })
    : t("离开 {{days}} 天回来。离开期间排了时间的任务，请在回来页确认做到哪了。", { days: absence.days }),
  "return_tidy", `return-tidy:${absence.since}`, [{ label: t("确认进度"), href: "/return" }], now);
  return { shifted, archived, merged, ...(opId ? { opId } : {}) };
}
