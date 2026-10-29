import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  advanceResults, conservativeFinish, onPersonsBoard, taskTitleOf, daysBetween, engagementTier, isSittingMilestone, monthDay, overdueTarget, RESULT_EXPIRE_DAYS, RESULT_REVIEW_DAYS, shiftWithChain, tFor, type Locale
} from "@crossline/core";
import { localeOf } from "./locale";
import { DUE_ADVANCED_EVENT, listAgentTasks, overdueStartedTasks, SILENT_TASK_SHIFTS_MAX, reviewAgentTask, settleAgentResult, type CrosslineStore, type StoredWorkOrder } from "@crossline/db";
import { DEADLINE_MARGIN_DAYS } from "@crossline/planner";
import { localToday } from "./analysis";
import { ownerOf } from "./owner";
import { archiveBySystem, courseProjects, deadlineReader, STALE_DAYS, staleOpenWork, writeDeadlineMoves, type TidyOutcome, type UndoEntry } from "./return-tidy";
import { dailyAvailableMinutes } from "./schedule-window";
import { sayToPerson } from "./workflow-smith";

/**
 * The daily pass that keeps what waits for the person moving with the calendar (the owner's rule of 2026-10-21; the rules are
 * `packages/core/src/date-advance.ts`). Once a local day per workspace, while the person is active or cooling (a dormant account is
 * tidied by `return-tidy.ts` when they come back):
 *
 * 1. **Assistant results.** An older result for the same work as a later one is put away as replaced. One delivered more than
 *    `RESULT_REVIEW_DAYS` ago whose own checks passed, which changed none of the person's originals and touched nothing outside the
 *    machine is accepted in the person's place — through `reviewAgentTask`, as the person's 采纳 would be, recorded `by: "system"` — and
 *    what it left for the person (`needsHuman`) is written on its task as 「助手留下的待补」. Any other one is put away after
 *    `RESULT_EXPIRE_DAYS`. Files stay where they are, in 助手产出.
 * 2. **Approved milestones past their deadline with open work.** A course's date, or one the person set themselves, does not move: it is
 *    asked about once (`milestone.overdue` → the `milestone_overdue` ask: 补做 / 改为新日期 / 放弃). Any other moves to its cautious finish
 *    plus the forecast's margin (the web's forecast when fresh, else its open work at the person's daily hours), with the later milestones
 *    of its line and project kept after it.
 * 3. **Old proposals, drafts and work.** What the return page used to archive only when it was opened: a proposal or a milestone draft
 *    untouched for `STALE_DAYS`, and the return tidy-up's other old work.
 *
 * Everything it did is one undoable operation and one message with 撤销.
 */
export const ADVANCE_DAY_SETTING = "advance.day";
/** Written by the web's attention timer (`apps/web/lib/schedule-memory.ts`): `{ at, goals: { [milestoneId]: { p50Day, p85Day } } }`. */
export const MILESTONE_FORECAST_SETTING = "milestone.forecast";
const FORECAST_FRESH_MS = 36 * 3_600_000;
/**
 * How many times a milestone of the person's own is moved past its deadline without asking. Sunsama stops rolling a task over after a few
 * consecutive days (its archive, default four) for the same reason: a date that keeps moving by itself stops meaning anything.
 */
export const SILENT_SHIFTS_MAX = 2;
/** How long after a sitting the person is asked how it went; an older one is history. */
const SITTING_ASK_DAYS = 14;
const DAY = 86_400_000;
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active", "blocked"]);

type Forecast = { at?: string; goals?: Record<string, { p50Day?: string | null; p85Day?: string | null }> };
const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

export type AdvanceOutcome = {
  superseded: string[]; adopted: Array<{ taskId: string; title: string; left: number }>; expired: string[];
  shifted: TidyOutcome["shifted"]; asked: Array<{ id: string; title: string; deadline: string }>;
  /** Started work whose own self-set due day passed, moved to the cautious finish at the measured pace plus two days (closed-loop-1030 §4). */
  tasksShifted?: Array<{ id: string; title: string; from: string; to: string }>;
  archived: TidyOutcome["archived"]; drafts: Array<{ id: string; title: string }>; opId?: string;
};

/** Milestones whose current deadline the person typed themselves (a `goal.settings_confirmed` of theirs is the latest that set one). */
function personSetDeadlines(store: CrosslineStore, workspaceId: string): Set<string> {
  const latest = new Map<string, boolean>();
  for (const event of store.listEvents(workspaceId, { type: "goal.settings_confirmed" })) {
    const payload = event.payload as { next?: { confirmedDeadline?: unknown }; bySystem?: unknown };
    if (typeof payload.next?.confirmedDeadline === "string" && payload.next.confirmedDeadline) latest.set(event.entityId, !payload.bySystem);
  }
  return new Set([...latest].filter(([, byPerson]) => byPerson).map(([id]) => id));
}

/**
 * What a result left for the person, from its own record beside its files; the ledger keeps only the count. A result made on another
 * machine (a ledger moved to the server) names a folder that is not here: its run folder under this data directory is tried by name.
 */
function leftForPerson(directory: string, dataDir = process.env.CROSSLINE_DATA_DIR): Array<{ what: string; why: string }> {
  if (!directory) return [];
  const read = (folder: string) => { try { return readFileSync(path.join(folder, "audit.json"), "utf8"); } catch { return ""; } };
  const name = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const text = read(directory) || (dataDir && name ? read(path.join(dataDir, "ai-output", name)) : "");
  const record = json<{ needsHuman?: Array<{ what?: unknown; why?: unknown }> }>(text, {});
  return (record.needsHuman ?? []).flatMap((item) => typeof item.what === "string" && item.what.trim()
    ? [{ what: item.what.trim().slice(0, 300), why: typeof item.why === "string" ? item.why.trim().slice(0, 300) : "" }] : []);
}

/**
 * Writes on the task what a result accepted in the person's place left for them. When its own record cannot be read (made on another
 * machine), one line still says how many things are left and where they were listed, so the count is never all the person sees.
 */
function writeLeftNotes(store: CrosslineStore, workspaceId: string, owner: string, row: { taskId: string; title: string; workOrderId?: string;
  directory: string; needsHuman: number }): number {
  if (!row.workOrderId) return 0;
  const left = leftForPerson(row.directory);
  const t = tFor(localeOf(store, workspaceId));
  const lines = left.length ? left.map((item) => item.why ? t("助手留下的待补：{{what}}（{{why}}）", item) : t("助手留下的待补：{{what}}", item))
    : row.needsHuman ? [t("助手留下 {{count}} 件待补，列在助手结果「{{title}}」里（原记录不在这台机器上）", { count: row.needsHuman, title: row.title })] : [];
  lines.forEach((text, index) => store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `task.note:agent-left:${row.taskId}:${index}`, type: "task.note",
    entityId: row.workOrderId!, payload: { text, kind: "agent_left", agentTaskId: row.taskId } }));
  return left.length || row.needsHuman;
}

export function dateAdvancePass(store: CrosslineStore, workspaceId: string, options: { now?: Date; force?: boolean } = {}): AdvanceOutcome | undefined {
  const now = options.now ?? new Date();
  const today = localToday(store, workspaceId, now);
  if (!options.force && store.getSetting(workspaceId, ADVANCE_DAY_SETTING) === today) return undefined;
  const since = store.listWorkspaces().find((workspace) => workspace.id === workspaceId)?.createdAt;
  if (!options.force && engagementTier(store.lastPersonActivity(workspaceId), now, since) === "dormant") return undefined;
  // Marked first: a failure part way must not do the same day twice.
  store.setSetting(workspaceId, ADVANCE_DAY_SETTING, today);
  const owner = ownerOf(store, workspaceId);
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const orders = store.listWorkOrders(workspaceId);
  const gone = new Set(orders.filter((order) => order.state === "accepted" || order.state === "archived").map((order) => order.id));
  const outcome: AdvanceOutcome = { superseded: [], adopted: [], expired: [], shifted: [], asked: [], archived: [], drafts: [] };
  const inverse: unknown[] = [];

  // 1. Assistant results.
  const rows = listAgentTasks(store, workspaceId, now);
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  const moves = advanceResults(rows.map((row) => ({ ...row, orderGone: Boolean(row.workOrderId && gone.has(row.workOrderId)) })), now);
  const reopened: string[] = [];
  for (const move of moves) {
    const row = byId.get(move.taskId)!;
    if (move.action === "supersede" || move.action === "expire") {
      const how = move.action === "supersede" ? "superseded" : "expired";
      if (!settleAgentResult(store, workspaceId, row.taskId, how, { ...(move.action === "supersede" ? { by: move.by } : {}), day: today })) continue;
      (move.action === "supersede" ? outcome.superseded : outcome.expired).push(row.taskId);
      reopened.push(row.taskId);
      continue;
    }
    const step = row.stepId && row.workOrderId ? store.getStepPlan(workspaceId, row.workOrderId)?.steps.find((item) => item.id === row.stepId) : undefined;
    // A whole-task result that left nothing for the person is handed in as the task's evidence, as the person's 采纳 would; one that left
    // something is accepted as the assistant's part only — the task stays the person's, with what is left written on it.
    const left = row.workOrderId ? leftForPerson(row.directory) : [];
    const reviewed = reviewAgentTask(store, workspaceId, row.taskId, "accepted", t("交付超过 {{days}} 天无人审阅，自检都通过，系统代为采纳", { days: RESULT_REVIEW_DAYS }),
      { by: "system", deliver: !left.length && !row.needsHuman });
    if (!reviewed.ok) continue;
    reopened.push(row.taskId);
    if (step && step.status !== "done") inverse.push({ kind: "step.status", workOrderId: row.workOrderId, stepId: step.id, status: step.status, progressQuarter: step.progressQuarter ?? 0 });
    // What only the person can do goes on the task, where they will be when they do it.
    outcome.adopted.push({ taskId: row.taskId, title: row.title, left: writeLeftNotes(store, workspaceId, owner, row) });
  }
  // A result accepted in the person's place before its notes could be read (2026-10-21: results made on the owner's machine, read on the
  // server) gets them now; the keys are the same, so a note already written is not written again.
  const noted = new Set(store.listEvents(workspaceId, { type: "task.note" })
    .map((event) => (event.payload as { kind?: string; agentTaskId?: string })).filter((note) => note.kind === "agent_left").map((note) => note.agentTaskId));
  for (const row of rows) if (row.status === "accepted" && row.reviewedBy === "system" && row.needsHuman && !noted.has(row.taskId)) writeLeftNotes(store, workspaceId, owner, row);
  if (reopened.length) inverse.push({ kind: "agent.reopen", taskIds: reopened });

  // 2. Approved milestones past their deadline with open work.
  const { deadlineOf } = deadlineReader(store, workspaceId);
  const courses = courseProjects(store, workspaceId);
  const personSet = personSetDeadlines(store, workspaceId);
  const open = orders.filter((order) => OPEN.has(order.state) && !order.tombstone);
  const approved = store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved");
  const fixed = (milestone: (typeof approved)[number]) => courses.has(milestone.projectId ?? "") || personSet.has(milestone.id);
  const forecast = json<Forecast>(store.getSetting(workspaceId, MILESTONE_FORECAST_SETTING), {});
  const fresh = forecast.at && now.getTime() - Date.parse(forecast.at) <= FORECAST_FRESH_MS ? forecast.goals ?? {} : {};
  const daily = dailyAvailableMinutes(store, workspaceId, now);
  const openMinutes = (milestoneId: string) => open.filter((order) => order.milestoneId === milestoneId).reduce((sum, order) => {
    const steps = store.getStepPlan(workspaceId, order.id)?.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
    return sum + (steps?.length ? steps.reduce((total, step) => total + step.estimate.p85Minutes, 0) : order.estimate.p85Minutes);
  }, 0);
  const movable = approved.filter((milestone) => !fixed(milestone))
    .map((milestone) => ({ id: milestone.id, line: milestone.identityId, project: milestone.projectId ?? "", deadline: deadlineOf(milestone.id) }));
  const seeds: Array<{ id: string; to: string; days: number }> = [];
  const judged = new Set(store.listEvents(workspaceId, { type: "milestone_gate.judged" }).map((event) => (event.payload as { milestoneId?: string }).milestoneId));
  const sittingPrep: Array<{ order: StoredWorkOrder; why: string }> = [];
  // How many times this pass already moved each milestone by itself.
  const priorShifts = new Map<string, number>();
  for (const event of store.listEvents(workspaceId, { type: "date.advanced" }))
    for (const item of (event.payload as { shifted?: Array<{ id?: string }> }).shifted ?? []) if (item.id) priorShifts.set(item.id, (priorShifts.get(item.id) ?? 0) + 1);
  for (const milestone of approved) {
    const deadline = deadlineOf(milestone.id);
    // An exam or a defence on a date that does not move is over once its day has passed: preparing for it is put away (anything being
    // timed stays), and the question is how it went, not whether to 补做 (2026-10-28: the day after the ECE 548 midterm its practice
    // was still Today's first card, and the ask recommended making it up).
    if (deadline && deadline < today && fixed(milestone) && isSittingMilestone(milestone.title)) {
      for (const order of open.filter((item) => item.milestoneId === milestone.id && item.state !== "active"))
        sittingPrep.push({ order, why: t("考试 {{day}} 已过，备考不再安排", { day: md(deadline, locale) }) });
      if (daysBetween(deadline, today) <= SITTING_ASK_DAYS && !judged.has(milestone.id)) {
        const asked = store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `milestone-overdue:sitting:${milestone.id}:${deadline}`, type: "milestone.overdue",
          entityId: milestone.id, payload: { deadline, why: "sitting" } });
        if (asked.inserted) outcome.asked.push({ id: milestone.id, title: milestone.title, deadline });
      }
      continue;
    }
    if (!deadline || deadline >= today || !open.some((order) => order.milestoneId === milestone.id)) continue;
    if (fixed(milestone)) {
      const asked = store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `milestone-overdue:${milestone.id}:${deadline}`, type: "milestone.overdue",
        entityId: milestone.id, payload: { deadline, why: courses.has(milestone.projectId ?? "") ? "course" : "person" } });
      if (asked.inserted) outcome.asked.push({ id: milestone.id, title: milestone.title, deadline });
      continue;
    }
    // Moved by itself twice already and still not worked on: a third silent move would make the date mean nothing (the month simulation
    // watched one slide 11/1 → 11/5 → 11/9 → … for four weeks). From here it waits for the person, asked once, as a course's date is.
    const shifts = priorShifts.get(milestone.id) ?? 0;
    if (shifts >= SILENT_SHIFTS_MAX) {
      const asked = store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `milestone-overdue:stalled:${milestone.id}:${deadline}`, type: "milestone.overdue",
        entityId: milestone.id, payload: { deadline, why: "stalled", shifts } });
      if (asked.inserted) outcome.asked.push({ id: milestone.id, title: milestone.title, deadline });
      continue;
    }
    const predicted = fresh[milestone.id]?.p85Day;
    const finish = predicted && predicted >= today ? predicted : conservativeFinish(today, openMinutes(milestone.id), daily);
    const to = overdueTarget({ today, finish, marginDays: DEADLINE_MARGIN_DAYS });
    seeds.push({ id: milestone.id, to, days: daysBetween(deadline, to) });
  }
  const written = writeDeadlineMoves(store, workspaceId, shiftWithChain(movable, seeds), "date_advance");
  outcome.shifted = written.shifted;
  const restore: UndoEntry[] = [...written.restore];

  // 2b. Started work whose own due day passed (docs/plans/closed-loop-1030.md §4). An external date (a course's, or read from someone
  // else's text) is asked about on the web (`overdue_task`); a self-set one moves to the cautious finish at the measured pace plus the
  // forecast's margin, twice at most, then it is asked about like an external one.
  const tasksShifted: NonNullable<AdvanceOutcome["tasksShifted"]> = [];
  for (const item of overdueStartedTasks(store, workspaceId, today, onPersonsBoard)) {
    if (item.external || item.shifts >= SILENT_TASK_SHIFTS_MAX) continue;
    const steps = store.getStepPlan(workspaceId, item.order.id)?.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
    const minutes = steps?.length ? steps.reduce((sum, step) => sum + step.estimate.p85Minutes, 0) : item.order.estimate.p85Minutes;
    const to = overdueTarget({ today, finish: conservativeFinish(today, minutes, daily), marginDays: DEADLINE_MARGIN_DAYS });
    store.saveWorkOrder({ ...item.order, payload: { ...(item.order.payload as object), dueDate: to } });
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${DUE_ADVANCED_EVENT}:${item.order.id}:${item.due}`, type: DUE_ADVANCED_EVENT,
      entityId: item.order.id, payload: { from: item.due, to, by: "date_advance" } });
    inverse.push({ kind: "work_order.field", id: item.order.id, field: "dueDate", value: item.due });
    tasksShifted.push({ id: item.order.id, title: taskTitleOf(item.order), from: item.due, to });
  }
  if (tasksShifted.length) outcome.tasksShifted = tasksShifted;

  // 3. Old proposals, drafts and work.
  const sittingIds = new Set(sittingPrep.map((item) => item.order.id));
  outcome.archived = archiveBySystem(store, workspaceId, [...sittingPrep, ...staleOpenWork(store, workspaceId, now, today).filter((item) => !sittingIds.has(item.order.id))], "date");
  const cutoff = new Date(now.getTime() - STALE_DAYS * DAY).toISOString();
  const lastAt = (type: string) => { const out = new Map<string, string>(); for (const event of store.listEvents(workspaceId, { type })) if ((out.get(event.entityId) ?? "") < event.createdAt) out.set(event.entityId, event.createdAt); return out; };
  const proposed = lastAt("milestone.proposed"), revised = lastAt("milestone.revised");
  for (const draft of store.listMilestones(workspaceId).filter((milestone) => milestone.status === "draft" && !revised.has(milestone.id)
    && (proposed.get(milestone.id) ?? "") !== "" && proposed.get(milestone.id)! <= cutoff)) {
    store.saveMilestone({ ...draft, status: "archived" });
    outcome.drafts.push({ id: draft.id, title: draft.title });
  }

  // One undo for all of it, newest change undone first.
  if (restore.length) inverse.push({ kind: "settings.restore", entries: restore });
  if (outcome.archived.length) inverse.push({ kind: "work_order.restore", ids: outcome.archived.map((item) => item.id) });
  if (outcome.drafts.length) inverse.push({ kind: "milestones.status", ids: outcome.drafts.map((item) => item.id), status: "draft" });
  if (inverse.length) {
    outcome.opId = `op-${now.getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    const delivered = outcome.adopted.some((item) => byId.get(item.taskId)?.delegated && !item.left);
    store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `op.applied:${outcome.opId}`, type: "op.applied", entityId: outcome.opId,
      payload: { bySystem: true, label: delivered ? t("到期整理：{{summary}}（已交去验收的任务不撤回）", { summary: summaryCounts(outcome, locale) }) : t("到期整理：{{summary}}", { summary: summaryCounts(outcome, locale) }),
        inverse: inverse.length === 1 ? inverse[0] : { kind: "batch", items: inverse } } });
  }
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `date.advanced:${today}`, type: "date.advanced", entityId: workspaceId,
    payload: { day: today, superseded: outcome.superseded, adopted: outcome.adopted.map((item) => item.taskId), expired: outcome.expired,
      shifted: outcome.shifted, asked: outcome.asked.map((item) => item.id), archived: outcome.archived.map((item) => item.id), drafts: outcome.drafts.map((item) => item.id),
      ...(outcome.opId ? { opId: outcome.opId } : {}) } });
  const text = advanceMessage(outcome, locale);
  if (text) sayToPerson(store, workspaceId, text, "date_advance", `date-advance:${today}`, [
    ...(outcome.opId ? [{ label: t("撤销"), action: { action: "undo", summary: t("撤销到期整理"), args: { opId: outcome.opId } } }] : []),
    ...(outcome.asked.length ? [{ label: t("去待确认"), href: "/approvals" }] : [])
  ], now);
  return outcome;
}

const summaryCounts = (outcome: AdvanceOutcome, locale?: Locale) => {
  const t = tFor(locale);
  return [
    outcome.adopted.length ? t("代为采纳 {{count}} 个助手成果", { count: outcome.adopted.length }) : "",
    outcome.superseded.length + outcome.expired.length ? t("收起 {{count}} 个助手成果", { count: outcome.superseded.length + outcome.expired.length }) : "",
    outcome.shifted.length ? t("顺延 {{count}} 个里程碑", { count: outcome.shifted.length }) : "",
    outcome.archived.length ? t("归档 {{count}} 个旧任务", { count: outcome.archived.length }) : "",
    outcome.drafts.length ? t("收起 {{count}} 个旧草稿", { count: outcome.drafts.length }) : ""
  ].filter(Boolean).join(locale === "en" ? ", " : "、");
};

const md = (day: string, locale?: Locale) => locale === "en" ? monthDay(locale, day) : day.slice(5).replace("-", "/");
const listed = <T>(items: T[], show: (item: T) => string, locale?: Locale, max = 3) => {
  const shown = items.slice(0, max).map(show).join(locale === "en" ? "; " : "；");
  return items.length > max ? tFor(locale)("{{items}} 等", { items: shown }) : shown;
};

/** The one message of a pass, in the app's own terms: what moved, why, and where it can be taken back. Empty when nothing happened. */
export function advanceMessage(outcome: AdvanceOutcome, locale?: Locale): string {
  const t = tFor(locale);
  const quote = (title: string) => locale === "en" ? `"${title.slice(0, 18)}"` : `「${title.slice(0, 18)}」`;
  const left = outcome.adopted.reduce((sum, item) => sum + item.left, 0);
  const adopted = { count: outcome.adopted.length, days: RESULT_REVIEW_DAYS, left };
  const parts = [
    outcome.adopted.length ? (left ? t("{{count}} 个助手成果交付超过 {{days}} 天无人审阅、自检都通过，已代为采纳，留给本人的 {{left}} 件事写在各自任务的记录里", adopted)
      : t("{{count}} 个助手成果交付超过 {{days}} 天无人审阅、自检都通过，已代为采纳", adopted)) : "",
    outcome.superseded.length ? t("{{count}} 个助手成果已被同一件事后一次运行取代，收起", { count: outcome.superseded.length }) : "",
    outcome.expired.length ? t("{{count}} 个助手成果超过 {{days}} 天未审，且自检未过、改了原文件或涉及对外，不代为采纳，收起", { count: outcome.expired.length, days: RESULT_EXPIRE_DAYS }) : "",
    outcome.shifted.length ? t("{{count}} 个里程碑已过截止、还有没做完的工作，按保守完成日留 2 天余量顺延：{{items}}", { count: outcome.shifted.length,
      items: listed(outcome.shifted, (item) => `${quote(item.title)}${locale === "en" ? " " : ""}${md(item.from, locale)} → ${md(item.to, locale)}`, locale) }) : "",
    outcome.tasksShifted?.length ? t("{{count}} 个已开始的任务过了本人定的截止，按实测进度的保守完成日留 2 天余量顺延：{{items}}", { count: outcome.tasksShifted.length,
      items: listed(outcome.tasksShifted, (item) => `${quote(item.title)}${locale === "en" ? " " : ""}${md(item.from, locale)} → ${md(item.to, locale)}`, locale) }) : "",
    outcome.asked.length ? t("{{count}} 个课程或本人定的截止已过，日期不动，在待确认里问怎么处理：{{items}}", { count: outcome.asked.length,
      items: listed(outcome.asked, (item) => `${quote(item.title)}${locale === "en" ? " " : ""}${md(item.deadline, locale)}`, locale) }) : "",
    outcome.archived.length ? t("归档 {{count}} 个旧任务（{{reasons}}），可在任务页「已归档」恢复", { count: outcome.archived.length,
      reasons: [...new Set(outcome.archived.map((item) => item.why.replace(/\d{4}-\d{2}-\d{2}/, "").replace(/\s+/g, locale === "en" ? " " : "").trim()))].join(locale === "en" ? "; " : "；") }) : "",
    outcome.drafts.length ? t("收起 {{count}} 个 {{days}} 天没动过的里程碑草稿，可在主线页「已归档」恢复", { count: outcome.drafts.length, days: STALE_DAYS }) : ""
  ].filter(Boolean);
  if (!parts.length) return "";
  const kept = outcome.superseded.length || outcome.expired.length || outcome.adopted.length;
  const values = { parts: parts.join(locale === "en" ? "; " : "；") };
  return kept ? t("按今天的日期整理了待办：{{parts}}。助手成果的文件都还在「助手产出」里；24 小时内可撤销。", values)
    : t("按今天的日期整理了待办：{{parts}}。24 小时内可撤销。", values);
}
