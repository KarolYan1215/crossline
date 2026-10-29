import "server-only";
import { taskTitleOf, timeOrderProblem, type AccessContext, type Ask } from "@crossline/core";
import { riskOverview } from "./asks";
import { countPending } from "./pending";
import { getStore, milestonesRetiredBySystem, planToday, readGoalSettings, type PersistedPlan } from "./crossline";
import { overlapStates, type TimelineItem } from "../app/timeline/model";
import { localeFor } from "./locale";
import { monthDay, tFor } from "./i18n";

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
const mdZh = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
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
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const md = (day: string) => locale === "en" ? monthDay(locale, day) : mdZh(day);
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
  if (overdue.length === 1) out.push({ id: "overdue", text: t("「{{title}}」已过截止 {{count}} 天", { title: short(taskTitleOf(overdue[0]!.order)), count: daysBetween(overdue[0]!.due, today) }),
    href: `/workbench/${encodeURIComponent(overdue[0]!.order.id)}`, line: overdue[0]!.order.identityId });
  else if (overdue.length > 1) out.push({ id: "overdue", text: t("{{count}} 个任务已过截止，最早 {{day}}", { count: overdue.length, day: md(overdue[0]!.due) }), href: "/workbench" });

  // 计划页: 「部分任务未排入」.
  const unplaced = unplacedTasks(plan);
  if (unplaced.none || unplaced.partial) out.push({ id: "unplaced", href: "/plan#why",
    text: [unplaced.none ? t("{{count}} 个任务未排进日历", { count: unplaced.none }) : "", unplaced.partial ? t("{{count}} 个任务有步骤未排入", { count: unplaced.partial }) : ""]
      .filter(Boolean).join(t("，")) });

  // 日历: 「时间冲突」 on the coming week's blocks; a locked block's conflict is already an ask (`locked_conflict`).
  const lockedAsked = new Set(asks.filter((ask) => ask.kind === "locked_conflict").map((ask) => ask.id.slice("locked:".length)));
  const clashes = weekClashes(calendarItems, today, lockedAsked);
  if (clashes.count) out.push({ id: "clash", text: t("{{count}} 个工作时段与日程时间冲突，最早 {{day}}", { count: clashes.count, day: md(clashes.firstDay!) }), href: "#today-timeline" });

  // 主线页: a high risk on an approved milestone (the reviewer's current one, else the rule estimate the page shows), drafts waiting, and
  // cross-line relations whose time order no longer holds. A milestone with an open ask (at risk, a reviewed risk) is left to that ask.
  const retired = milestonesRetiredBySystem(ctx);
  const milestones = [...new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived" && !retired.has(item.id))
    .map((item) => [item.id, item])).values()];
  const deadlines = new Map(milestones.map((item) => [item.id, deadlineOf(item.id)]));
  // Risks are counted once, from the set the weekly risk card and the urgent risk cards are built from (`riskOverview`, decided
  // 2026-10-28): while a risk card is in the stack the stack says it, otherwise one line here between the weekly cards. The rule estimate
  // the 主线 page draws is not counted, so there is never a second risk number beside the first.
  const riskCard = asks.some((ask) => ask.kind === "risk_digest" || ask.kind === "milestone_risk" || ask.kind === "milestone_risk_review");
  const risky = riskCard ? 0 : riskOverview(ctx).count;
  if (risky) out.push({ id: "risk", text: t("{{count}} 个里程碑有风险，每周汇总一次", { count: risky }), href: "/plan" });
  const live = new Set(milestones.map((item) => item.id));
  const broken = store.listMilestoneRelations(ctx.workspaceId).filter((relation) => (relation.status === "approved" || relation.status === "candidate")
    && relation.artifactId && relation.transfer && live.has(relation.fromMilestoneId) && live.has(relation.toMilestoneId)
    && timeOrderProblem(deadlines.get(relation.fromMilestoneId), deadlines.get(relation.toMilestoneId), relation.transfer.lagDays, relation.kind === "recurring_feedback"));
  if (broken.length) out.push({ id: "relations", text: t("{{count}} 条跨主线关系的时间顺序不成立", { count: broken.length }), href: "/milestones" });
  // This week's drafts, as 待确认 counts them (`countPending`): the badge and this line say the same number.
  const drafts = countPending(ctx).milestoneDrafts;
  if (drafts) out.push({ id: "drafts", text: t("{{count}} 个里程碑草稿待批准", { count: drafts }), href: "/milestones" });
  return out;
}
