import "server-only";
import {
  currentRiskReview, MILESTONE_RISKS_SETTING, milestoneRiskFingerprint, parseMilestoneRisks, riskCriteriaKeys, riskLevelOf, ruleMilestoneRisks,
  taskTitleOf, timeOrderProblem, type AccessContext, type Ask, type MilestoneRisk
} from "@crossline/core";
import { getStore, milestonesRetiredBySystem, planToday, readGoalSettings, type PersistedPlan } from "./crossline";
import { overlapStates, type TimelineItem } from "../app/timeline/model";

/**
 * What other pages say needs the person's attention, gathered on Today (the owner's direction of 2026-10-15: 「其他页面上的提示需要在今日页有
 * 体现」). What can be answered in place is an ask and sits in Today's stack; what is only information is one line here, linking to the
 * page it comes from. Nothing that is already an ask is repeated: a task, milestone or block an open ask is about is left out.
 */
export type Reminder = { id: string; text: string; href: string; line?: string };

const OPEN = ["approved", "preparing", "ready_for_human", "active"];
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const short = (text: string, length = 18) => text.length > length ? `${text.slice(0, length)}…` : text;

/** The plan page's 「部分任务未排入」, counted per task as that page counts it: wholly unplaced, and placed only in part. */
export function unplacedTasks(plan: Pick<PersistedPlan, "blocks" | "schedule">): { none: number; partial: number } {
  const blocked = new Set((plan.schedule?.blockers ?? []).map((blocker) => blocker.taskId.split("#")[0]!));
  const placed = new Set(plan.blocks.filter((block) => block.id.startsWith("scheduled:")).map((block) => block.id.split(":")[1]));
  const partial = [...blocked].filter((id) => placed.has(id)).length;
  return { none: blocked.size - partial, partial };
}

/** The day timeline's 「时间冲突」 over the coming week: work blocks that share time with something and nobody accepted the overlap. */
export function weekClashes(items: TimelineItem[], today: string, skip: Set<string>): { count: number; firstDay?: string } {
  const days = [...new Set(items.map((item) => item.day))].filter((day) => day >= today && day < addDays(today, 7)).sort();
  let count = 0, firstDay: string | undefined;
  for (const day of days) {
    const states = overlapStates(items.filter((item) => item.day === day));
    const clashing = items.filter((item) => item.day === day && item.kind === "scheduled" && states.get(item.id) === "clash" && !skip.has(item.id));
    if (clashing.length && !firstDay) firstDay = day;
    count += clashing.length;
  }
  return { count, ...(firstDay ? { firstDay } : {}) };
}

export function loadReminders(ctx: AccessContext, plan: PersistedPlan, calendarItems: TimelineItem[], asks: Ask[]): Reminder[] {
  const store = getStore();
  const today = planToday(ctx);
  const asked = new Set(asks.map((ask) => ask.entityId));
  const out: Reminder[] = [];
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const deadlineOf = (milestoneId: string) => readGoalSettings(ctx, milestoneId)?.confirmedDeadline || anchors.get(milestoneId)?.deadline || undefined;

  // 任务页: work whose due day has passed (「已过 N 天」 on its card).
  const overdue = store.listWorkOrders(ctx.workspaceId).filter((order) => OPEN.includes(order.state) && !order.tombstone
    && !(order.payload as { seeded?: boolean }).seeded && !asked.has(order.id)).flatMap((order) => {
    const due = [(order.payload as { dueDate?: string }).dueDate, deadlineOf(order.milestoneId)].filter((day): day is string => Boolean(day && DATE.test(day))).sort()[0];
    return due && due < today ? [{ order, due }] : [];
  }).sort((a, b) => a.due.localeCompare(b.due));
  if (overdue.length === 1) out.push({ id: "overdue", text: `「${short(taskTitleOf(overdue[0]!.order))}」已过截止 ${daysBetween(overdue[0]!.due, today)} 天`,
    href: `/workbench/${encodeURIComponent(overdue[0]!.order.id)}`, line: overdue[0]!.order.identityId });
  else if (overdue.length > 1) out.push({ id: "overdue", text: `${overdue.length} 个任务已过截止，最早 ${md(overdue[0]!.due)}`, href: "/workbench" });

  // 计划页: 「部分任务未排入」.
  const unplaced = unplacedTasks(plan);
  if (unplaced.none || unplaced.partial) out.push({ id: "unplaced", href: "/plan#why",
    text: [unplaced.none ? `${unplaced.none} 个任务未排进日历` : "", unplaced.partial ? `${unplaced.partial} 个任务有步骤未排入` : ""].filter(Boolean).join("，") });

  // 日历: 「时间冲突」 on the coming week's blocks; a locked block's conflict is already an ask (`locked_conflict`).
  const lockedAsked = new Set(asks.filter((ask) => ask.kind === "locked_conflict").map((ask) => ask.id.slice("locked:".length)));
  const clashes = weekClashes(calendarItems, today, lockedAsked);
  if (clashes.count) out.push({ id: "clash", text: `${clashes.count} 个工作时段与日程时间冲突，最早 ${md(clashes.firstDay!)}`, href: "#today-timeline" });

  // 主线页: a high risk on an approved milestone (the reviewer's current one, else the rule estimate the page shows), drafts waiting, and
  // cross-line relations whose time order no longer holds. A milestone with an open ask (at risk, a reviewed risk) is left to that ask.
  const retired = milestonesRetiredBySystem(ctx);
  const milestones = [...new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived" && !retired.has(item.id))
    .map((item) => [item.id, item])).values()];
  const stored = parseMilestoneRisks(store.getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING));
  const deadlines = new Map(milestones.map((item) => [item.id, deadlineOf(item.id)]));
  const risky = milestones.filter((item) => item.status === "approved" && !asked.has(item.id)).flatMap((milestone) => {
    const deadline = deadlines.get(milestone.id) ?? null;
    const dependsOn = anchors.get(milestone.id)?.dependsOn ?? [];
    const reviewed = currentRiskReview(stored[milestone.id],
      milestoneRiskFingerprint({ title: milestone.title, deadline, criteria: riskCriteriaKeys(milestone.successCriteria ?? []), dependsOn }));
    const risks: MilestoneRisk[] = reviewed ?? ruleMilestoneRisks({ today, deadline, criteria: milestone.successCriteria ?? [],
      dependsOn: dependsOn.flatMap((id) => { const other = milestones.find((item) => item.id === id); return other ? [{ title: other.title, deadline: deadlines.get(id) ?? null }] : []; }),
      otherDeadlines: milestones.filter((other) => other.id !== milestone.id && deadlines.get(other.id)).map((other) => deadlines.get(other.id)!) });
    const high = risks.find((risk) => risk.level === "high");
    return riskLevelOf(risks) === "high" && high ? [{ milestone, note: high.note }] : [];
  });
  if (risky.length === 1) out.push({ id: "risk", text: `「${short(risky[0]!.milestone.title)}」风险高：${risky[0]!.note}`,
    href: `/milestones?open=${encodeURIComponent(risky[0]!.milestone.id)}`, line: risky[0]!.milestone.identityId });
  else if (risky.length > 1) out.push({ id: "risk", text: `${risky.length} 个里程碑风险高`, href: "/milestones" });
  const live = new Set(milestones.map((item) => item.id));
  const broken = store.listMilestoneRelations(ctx.workspaceId).filter((relation) => (relation.status === "approved" || relation.status === "candidate")
    && relation.artifactId && relation.transfer && live.has(relation.fromMilestoneId) && live.has(relation.toMilestoneId)
    && timeOrderProblem(deadlines.get(relation.fromMilestoneId), deadlines.get(relation.toMilestoneId), relation.transfer.lagDays, relation.kind === "recurring_feedback"));
  if (broken.length) out.push({ id: "relations", text: `${broken.length} 条跨主线关系的时间顺序不成立`, href: "/milestones" });
  const drafts = milestones.filter((item) => item.status === "draft").length;
  if (drafts) out.push({ id: "drafts", text: `${drafts} 个里程碑草稿待批准`, href: "/milestones" });
  return out;
}
