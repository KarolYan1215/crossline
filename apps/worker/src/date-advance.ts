import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  advanceResults, conservativeFinish, daysBetween, engagementTier, overdueTarget, RESULT_EXPIRE_DAYS, RESULT_REVIEW_DAYS, shiftWithChain
} from "@crossline/core";
import { listAgentTasks, reviewAgentTask, settleAgentResult, type CrosslineStore } from "@crossline/db";
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
const DAY = 86_400_000;
const OPEN = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active", "blocked"]);

type Forecast = { at?: string; goals?: Record<string, { p50Day?: string | null; p85Day?: string | null }> };
const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };

export type AdvanceOutcome = {
  superseded: string[]; adopted: Array<{ taskId: string; title: string; left: number }>; expired: string[];
  shifted: TidyOutcome["shifted"]; asked: Array<{ id: string; title: string; deadline: string }>;
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

/** What a result left for the person, from its own record beside its files; the ledger keeps only the count. */
function leftForPerson(directory: string): Array<{ what: string; why: string }> {
  if (!directory) return [];
  const record = json<{ needsHuman?: Array<{ what?: unknown; why?: unknown }> }>((() => { try { return readFileSync(path.join(directory, "audit.json"), "utf8"); } catch { return ""; } })(), {});
  return (record.needsHuman ?? []).flatMap((item) => typeof item.what === "string" && item.what.trim()
    ? [{ what: item.what.trim().slice(0, 300), why: typeof item.why === "string" ? item.why.trim().slice(0, 300) : "" }] : []);
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
    const reviewed = reviewAgentTask(store, workspaceId, row.taskId, "accepted", `交付超过 ${RESULT_REVIEW_DAYS} 天无人审阅，自检都通过，系统代为采纳`,
      { by: "system", deliver: !left.length && !row.needsHuman });
    if (!reviewed.ok) continue;
    reopened.push(row.taskId);
    if (step && step.status !== "done") inverse.push({ kind: "step.status", workOrderId: row.workOrderId, stepId: step.id, status: step.status, progressQuarter: step.progressQuarter ?? 0 });
    // What only the person can do goes on the task, where they will be when they do it.
    left.forEach((item, index) => store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `task.note:agent-left:${row.taskId}:${index}`, type: "task.note",
      entityId: row.workOrderId, payload: { text: `助手留下的待补：${item.what}${item.why ? `（${item.why}）` : ""}`, kind: "agent_left", agentTaskId: row.taskId } }));
    outcome.adopted.push({ taskId: row.taskId, title: row.title, left: left.length || row.needsHuman });
  }
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
  const daily = dailyAvailableMinutes(store, workspaceId);
  const openMinutes = (milestoneId: string) => open.filter((order) => order.milestoneId === milestoneId).reduce((sum, order) => {
    const steps = store.getStepPlan(workspaceId, order.id)?.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
    return sum + (steps?.length ? steps.reduce((total, step) => total + step.estimate.p85Minutes, 0) : order.estimate.p85Minutes);
  }, 0);
  const movable = approved.filter((milestone) => !fixed(milestone))
    .map((milestone) => ({ id: milestone.id, line: milestone.identityId, project: milestone.projectId ?? "", deadline: deadlineOf(milestone.id) }));
  const seeds: Array<{ id: string; to: string; days: number }> = [];
  for (const milestone of approved) {
    const deadline = deadlineOf(milestone.id);
    if (!deadline || deadline >= today || !open.some((order) => order.milestoneId === milestone.id)) continue;
    if (fixed(milestone)) {
      const asked = store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `milestone-overdue:${milestone.id}:${deadline}`, type: "milestone.overdue",
        entityId: milestone.id, payload: { deadline, why: courses.has(milestone.projectId ?? "") ? "course" : "person" } });
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

  // 3. Old proposals, drafts and work.
  outcome.archived = archiveBySystem(store, workspaceId, staleOpenWork(store, workspaceId, now, today), "到期整理：");
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
      payload: { bySystem: true, label: `到期整理：${summaryCounts(outcome)}${delivered ? "（已交去验收的任务不撤回）" : ""}`,
        inverse: inverse.length === 1 ? inverse[0] : { kind: "batch", items: inverse } } });
  }
  store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `date.advanced:${today}`, type: "date.advanced", entityId: workspaceId,
    payload: { day: today, superseded: outcome.superseded, adopted: outcome.adopted.map((item) => item.taskId), expired: outcome.expired,
      shifted: outcome.shifted, asked: outcome.asked.map((item) => item.id), archived: outcome.archived.map((item) => item.id), drafts: outcome.drafts.map((item) => item.id),
      ...(outcome.opId ? { opId: outcome.opId } : {}) } });
  const text = advanceMessage(outcome);
  if (text) sayToPerson(store, workspaceId, text, "date_advance", `date-advance:${today}`, [
    ...(outcome.opId ? [{ label: "撤销", action: { action: "undo", summary: "撤销到期整理", args: { opId: outcome.opId } } }] : []),
    ...(outcome.asked.length ? [{ label: "去待确认", href: "/approvals" }] : [])
  ], now);
  return outcome;
}

const summaryCounts = (outcome: AdvanceOutcome) => [
  outcome.adopted.length ? `代为采纳 ${outcome.adopted.length} 个助手成果` : "",
  outcome.superseded.length + outcome.expired.length ? `收起 ${outcome.superseded.length + outcome.expired.length} 个助手成果` : "",
  outcome.shifted.length ? `顺延 ${outcome.shifted.length} 个里程碑` : "",
  outcome.archived.length ? `归档 ${outcome.archived.length} 个旧任务` : "",
  outcome.drafts.length ? `收起 ${outcome.drafts.length} 个旧草稿` : ""
].filter(Boolean).join("、");

const md = (day: string) => day.slice(5).replace("-", "/");
const listed = <T>(items: T[], show: (item: T) => string, max = 3) => `${items.slice(0, max).map(show).join("；")}${items.length > max ? " 等" : ""}`;

/** The one message of a pass, in the app's own terms: what moved, why, and where it can be taken back. Empty when nothing happened. */
export function advanceMessage(outcome: AdvanceOutcome): string {
  const left = outcome.adopted.reduce((sum, item) => sum + item.left, 0);
  const parts = [
    outcome.adopted.length ? `${outcome.adopted.length} 个助手成果交付超过 ${RESULT_REVIEW_DAYS} 天无人审阅、自检都通过，已代为采纳`
      + (left ? `，留给本人的 ${left} 件事写在各自任务的记录里` : "") : "",
    outcome.superseded.length ? `${outcome.superseded.length} 个助手成果已被同一件事后一次运行取代，收起` : "",
    outcome.expired.length ? `${outcome.expired.length} 个助手成果超过 ${RESULT_EXPIRE_DAYS} 天未审，且自检未过、改了原文件或涉及对外，不代为采纳，收起` : "",
    outcome.shifted.length ? `${outcome.shifted.length} 个里程碑已过截止、还有没做完的工作，按保守完成日留 2 天余量顺延：`
      + listed(outcome.shifted, (item) => `「${item.title.slice(0, 18)}」${md(item.from)} → ${md(item.to)}`) : "",
    outcome.asked.length ? `${outcome.asked.length} 个课程或本人定的截止已过，日期不动，在待确认里问怎么处理：`
      + listed(outcome.asked, (item) => `「${item.title.slice(0, 18)}」${md(item.deadline)}`) : "",
    outcome.archived.length ? `归档 ${outcome.archived.length} 个旧任务（${[...new Set(outcome.archived.map((item) => item.why.replace(/\d{4}-\d{2}-\d{2}/, "").replace(/\s+/g, "")))].join("；")}），可在任务页「已归档」恢复` : "",
    outcome.drafts.length ? `收起 ${outcome.drafts.length} 个 ${STALE_DAYS} 天没动过的里程碑草稿，可在主线页「已归档」恢复` : ""
  ].filter(Boolean);
  if (!parts.length) return "";
  const kept = outcome.superseded.length || outcome.expired.length || outcome.adopted.length ? "助手成果的文件都还在「助手产出」里；" : "";
  return `按今天的日期整理了待办：${parts.join("；")}。${kept}24 小时内可撤销。`;
}
