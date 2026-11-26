import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { CrosslineStore, type StoredWorkOrder } from "@crossline/db";
import { ANALYSIS_CONTEXT_VERSION, calibrationReport, calibratedEstimate, type CalibrationReport, milestoneReadingOf, taskTitleOf, type AccessContext, type Estimate } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { BYPRODUCT_LAG_DAYS } from "@crossline/core";
import type { UnplacedKind } from "../plan-stats";
import { attendedText, onPersonsBoard } from "@crossline/core";
import { linePacks } from "../lines";
import { memoByLedger } from "../ledger-memo";
import { tOf } from "../locale";
import { type PersistedPlan, type PersistedScheduleBlock, plannerItemsFor, scaledEstimate } from "./schedule";
import { getStore } from "./store";
import { planToday, toZonedInstant } from "./clock";
import { effectiveSchedulePreferences, readSchedulePreferences } from "./schedule-settings";
import { IMPORTANT_WEIGHT, effectiveWeight, forecastShortOf, libraryUntil, milestoneDeadline, milestoneRisksOf, riskBufferOf } from "./goals";
import { previewScope } from "./preview";
import { releaseDayOf } from "./dashboard";
import { inputsReady } from "./work-orders";

// Estimates live on the WorkOrder, where they carry their own source, observation count and confidence.
// A task without one falls back to the pack's labelled prior rather than to a number invented here.
// Today reads work_orders, not tasks. Reading tasks meant a capture that was successfully analysed
// vanished from the home page, because analysis only ever writes a WorkOrder.
export const ACTIONABLE = ["approved", "preparing", "ready_for_human", "active"];

/** Why the scheduler left a task out, in the plan page's words; the planner's own messages repeat the title and address the person. */
const UNPLACED_REASON: Record<string, string> = {
  Q4_NEEDS_DATE_OR_PROMOTION: "无截止日且重要性低于 60，暂不排入；设定截止日或提高重要性后排入",
  Q4_BEYOND_FORECAST_HORIZON: "截止日在 8 周之后，暂不排入",
  Q4_WAITING_LATEST_START: "截止尚远，最迟开工日之前暂不排入",
  DEADLINE_CAPACITY: "截止日前的可用时段不足",
  DEADLINE_PARTIAL: "截止前只排得下一部分，可能来不及",
  NO_CAPACITY: "本次排程范围内的可用时段已排满，之后的时段再排入",
  NO_CONTINUOUS_SLOT: "需要一段连续时间，现有最长空档不够",
  PROGRESS_ONLY: "本周只排入 45 分钟进度",
  DEPENDENCY_NOT_READY: "前置任务尚未验收"
};

/** One task as the scheduler saw it, and what it did with it: why it sits where it does on the plan page's 「排程依据」. */
export type RankedTask = { id: string; title: string; line: string; milestoneId: string; tier: 1 | 2 | 3 | 4; weight: number;
  deadline: string | null; notBefore: string | null; firstDay: string | null; firstStart: string | null; weekMinutes: number; blocker: string | null;
  /** Which kind of reason `blocker` is, so every count of unplaced work groups the same way (`unplacedBreakdown`). */
  blockerKind: UnplacedKind | null;
  /** In the task library: the day it enters the schedule (`libraryUntil`). */
  libraryUntil: string | null;
  /** What is left of it (open steps only, where it has a step plan), usual and cautious. */
  p50Minutes: number; p85Minutes: number };

/**
 * The real ordering, read off the same planner input and the same result the calendar shows (no second ranking of its own): each
 * actionable task's tier, weight, deadline and release, its first block and its minutes in the next seven days, and — for one that was
 * not placed — the planner's own reason. Listed in the scheduler's own priority: placed before unplaced, then urgency tier, then
 * importance, then deadline.
 */
export function planRanking(ctx: AccessContext, plan: PersistedPlan): RankedTask[] {
  const store = getStore();
  const t = tOf(ctx);
  const capacityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const orders = withoutShadowingDemos(store.listWorkOrders(ctx.workspaceId), capacityIds)
    .filter((order) => ACTIONABLE.includes(order.state) && !capacityIds.has(order.identityId));
  const today = planToday(ctx);
  const weekEnd = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const minutesOf = (block: PersistedScheduleBlock) => {
    const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
    return (eh! * 60 + em!) - (sh! * 60 + sm!);
  };
  const items = plannerItemsFor(ctx, orders);
  const waits = store.listWaitingItems(ctx.workspaceId, { state: "open" });
  /**
   * Why a task with nothing to place sits out: its open steps all wait (a 「等待」 step, material only the person has, or a waiting item).
   * The planner never saw it, so it has no blocker, and the page said 「可用时段内没有空位」 beside 「本周已排 16.3 / 53.1 h」 (W-152).
   */
  const waitingReason = (order: StoredWorkOrder): string => {
    const item = waits.find((wait) => wait.blocks.includes(order.id));
    const step = store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((one) => one.status === "planned" && (one.role === "wait" || (one as { provides?: unknown }).provides));
    const what = item?.title || step?.title;
    return what ? t("在等：{{what}}", { what }) : t("剩下的步骤在等前一步或材料，暂不排入");
  };
  const ranked = orders.map((order): RankedTask => {
    const task = plannerTaskOf(ctx, order);
    const own = items.filter((item) => item.orderId === order.id);
    const blocks = plan.blocks.filter((block) => block.day && block.id.startsWith("scheduled:") && block.id.split(":")[1] === order.id)
      .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
    const blocker = plan.schedule.blockers.find((item) => item.taskId === order.id || item.taskId.startsWith(`${order.id}#`));
    const local = (instant: string | undefined) => instant ? formatInTimeZone(new Date(instant), zone, "yyyy-MM-dd") : null;
    // An event whose day has passed is not work waiting for room or material (2026-11-17 live walk: 「改截止日…才会重新排入」 and
    // 「在等：提供…日历邀请」 beside talks gone for days, while the task list said 「活动已过」).
    const passedEvent = Boolean(local(task.deadline) && local(task.deadline)! < today && attendedText(order));
    const overdue = Boolean(local(task.deadline) && local(task.deadline)! < today);
    const blockerKind: UnplacedKind | null = blocks.length ? null : passedEvent ? "passed_event" : blocker
      ? (overdue ? "overdue" : blocker.code.startsWith("Q4_") ? "later" : blocker.code === "DEPENDENCY_NOT_READY" ? "waiting" : "room")
      : own.length ? "room" : "waiting";
    return { id: order.id, title: taskTitleOf(order), line: order.identityId, milestoneId: order.milestoneId, tier: task.deadlineTier,
      weight: task.weight, deadline: local(task.deadline), notBefore: local(task.notBefore),
      firstDay: blocks[0]?.day ?? null, firstStart: blocks[0]?.start ?? null,
      weekMinutes: blocks.filter((block) => block.day! >= today && block.day! < weekEnd).reduce((sum, block) => sum + minutesOf(block), 0),
      blocker: blocks.length ? null : passedEvent ? t("活动已过 · 去了就点完成，没去就归档") : blocker
        // Past its own deadline the planner cannot place it at all, which read as 「截止日前的可用时段不足」 (W-174).
        ? (local(task.deadline) && local(task.deadline)! < today ? t("已过截止日；改截止日或标为不做后才会重新排入")
          : UNPLACED_REASON[blocker.code] ? t(UNPLACED_REASON[blocker.code]!) : blocker.message)
        : own.length ? null : waitingReason(order),
      blockerKind,
      libraryUntil: libraryUntil(ctx, order, today),
      p50Minutes: own.reduce((sum, item) => sum + item.task.estimate.p50Minutes, 0),
      p85Minutes: own.reduce((sum, item) => sum + item.task.estimate.p85Minutes, 0) };
  });
  return ranked.sort((a, b) => (a.firstDay ? 0 : 1) - (b.firstDay ? 0 : 1) || a.tier - b.tier || b.weight - a.weight
    || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
    || `${a.firstDay ?? ""} ${a.firstStart ?? ""}`.localeCompare(`${b.firstDay ?? ""} ${b.firstStart ?? ""}`));
}

/**
 * The demo work orders every account is seeded with exist to show the flow. Once the person has any work of their own (in any state
 * short of discarded) they stop being recommended or scheduled: Today's 「下一步」 and the plan must never hold a made-up task next to a
 * real midterm. They stay on the Workbench, where they can be discarded.
 *
 * Every caller lists the person's own work (Today's 「下一步」, the schedule, its preview and ranking), so the assistant's preparation and
 * the questions to the person (`payload.owner`, docs/work-split.md) are left out here too: they get no calendar time and no card.
 */
export function withoutShadowingDemos<T extends { state: string; identityId: string; payload: unknown }>(all: T[], capacityIds: Set<string>): T[] {
  const orders = all.filter(onPersonsBoard);
  const demo = (order: T) => Boolean((order.payload as { seeded?: boolean }).seeded);
  const hasOwnWork = orders.some((order) => !demo(order) && order.state !== "archived" && !capacityIds.has(order.identityId));
  return hasOwnWork ? orders.filter((order) => !demo(order)) : orders;
}

/** Minutes left in these same-day slots from `nowClock` (HH:mm) on: a slot already over counts nothing, one under way counts its rest. */
export function remainingMinutes(slots: Array<{ start: string; end: string }>, nowClock: string): number {
  const clockMinutes = (clock: string) => { const [h, m] = clock.split(":"); return Number(h) * 60 + Number(m); };
  const nowMinutes = clockMinutes(nowClock);
  return slots.reduce((sum, slot) => sum + Math.max(0, clockMinutes(slot.end) - Math.max(clockMinutes(slot.start), nowMinutes)), 0);
}

export type ActionableOrder = ReturnType<CrosslineStore["listWorkOrders"]>[number];

export const humanCoreOf = (order: ActionableOrder) =>
  ((order.payload as { humanCore?: Array<{ energy?: string; interruptible?: boolean }> }).humanCore ?? [])[0];

/**
 * This person's calibration, fitted on every finished task whose estimate came from the analysis: how far the
 * model's p50 tends to be off, overall and per (line × kind), and whether correcting it actually beat the raw
 * number in a backtest (`packages/core/src/calibration.ts`). Cached until a new observation lands — the backtest
 * refits once per point and is read on every page.
 */
const calibrationCache = new Map<string, { key: string; report: CalibrationReport }>();
export function workspaceCalibration(ctx: AccessContext, now = new Date()): CalibrationReport {
  const rows = getStore().listAllDurationObservations(ctx.workspaceId).filter((row) => row.llmP50Minutes !== null && row.llmP85Minutes !== null);
  const key = `${rows.length}:${rows.at(-1)?.createdAt ?? ""}:${now.toISOString().slice(0, 10)}`;
  const cached = calibrationCache.get(ctx.workspaceId);
  if (cached?.key === key) return cached.report;
  const report = calibrationReport(rows.map((row) => ({ identityId: row.identityId, family: row.family, llmP50: row.llmP50Minutes!, llmP85: row.llmP85Minutes!,
    actualMinutes: row.interruptionDominant ? 0 : row.observedMinutes, observedAt: row.observedAt, contextVersion: row.contextVersion, censored: row.censored })),
    now, ANALYSIS_CONTEXT_VERSION);
  calibrationCache.set(ctx.workspaceId, { key, report });
  return report;
}

/**
 * The estimate actually used for scheduling and display: the analysis's own number, corrected by this person's
 * record once the correction has proved itself (otherwise unchanged, marked as still learning). Read fresh, never
 * written back, so the stored estimate stays what the analysis said and every observation keeps improving it.
 * It replaces two stacked corrections — a per-kind average that discarded the task's own estimate, and a global
 * ratio with no shrinkage applied after three completions.
 */
export const resolvedEstimate = (ctx: AccessContext, order: ActionableOrder): Estimate =>
  calibratedEstimate(order.estimate, workspaceCalibration(ctx), order.identityId, (order.payload as { family?: string } | undefined)?.family);

export const plannerTaskOf = (ctx: AccessContext, order: ActionableOrder) => {
  const preferences = readSchedulePreferences(ctx);
  const riskBuffer = riskBufferOf(ctx, order.milestoneId);
  const milestoneDue = milestoneDeadline(ctx, order.milestoneId);
  const weight = effectiveWeight(ctx, order.milestoneId);
  const important = weight >= IMPORTANT_WEIGHT;
  // A task with its own due day (a homework due Monday) has a deadline whether or not its milestone's was confirmed.
  const ownDue = (order.payload as { dueDate?: string }).dueDate;
  const hasDeadline = Boolean(milestoneDue) || Boolean(ownDue && /^\d{4}-\d{2}-\d{2}$/.test(ownDue));
  // Before the person saved any preferences the older rule applies to work without a deadline; a deadline always lifts it.
  const tier = hasDeadline ? important ? 1 : 2 : preferences ? important ? 3 : 4
    : order.state === "approved" ? 3 : order.identityId === (process.env.CROSSLINE_PRIMARY_CLOCK_ID ?? linePacks(ctx).find((pack) => pack.masterClock)?.id) ? 1 : 2;
  const core = humanCoreOf(order);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const landing = byproductLanding(ctx, order);
  // The assistant's preparation for this task takes none of the person's time and is due before it begins (docs/work-split.md §4): it
  // does not hold the task off the calendar.
  const offBoard = memoByLedger(getStore(), `off-board:${ctx.workspaceId}`, 5_000, () =>
    new Set(getStore().listWorkOrders(ctx.workspaceId).filter((item) => !onPersonsBoard(item)).map((item) => item.id)));
  const dependsOn = (landing ? landing.dependsOn : (order.payload as { dependsOn?: string[] }).dependsOn)?.filter((id) => !offBoard.has(id));
  const preview = previewScope.getStore();
  const release = preview?.notBefore?.[order.id] ?? releaseDayOf(ctx, order);
  const dueDate = preview?.dueDates?.[order.id] ?? landing?.dueDate ?? (order.payload as { dueDate?: string }).dueDate;
  return {
    id: order.id, title: taskTitleOf(order), identityId: order.identityId, milestoneId: order.milestoneId, weight,
    estimate: scaledEstimate(resolvedEstimate(ctx, order), preview?.estimates?.[order.id]),
    ...(core?.energy ? { energy: core.energy as "low" | "medium" | "high" } : {}),
    // Materials stand between the proposal and the human until the order reaches ready_for_human — when it needs any. An approved
    // order with no material contract can be started as it is (`startWorkOrderExecution` passes straight through), and every
    // backplanned step is one: counting them as not ready left 「下一步」 empty with five approved orders on the board.
    inputsReady: inputsReady(order),
    // A byproduct's landing never outranks real work: lowest tier, with its own T+2 window once the main order is done.
    deadlineTier: (landing ? 4 : tier) as 1 | 2 | 3 | 4,
    // The earlier of the milestone's deadline and the task's own due date (the capture's 「10月21号前」, a homework's due day): a
    // homework due before the exam it counts towards is due on its own day. The milestone's deadline used to count only once schedule
    // preferences had been saved, which a new account never has.
    ...(() => {
      const day = [milestoneDue,
        dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : undefined].filter((value): value is string => Boolean(value)).sort()[0];
      // Work towards a sitting (an exam held in that day's class) is due when the sitting begins, not at midnight: the milestone
      // reviewer's `sitting` and `startsAt`, read from that day's fixed events (2026-11-22, no longer a course code and an exam word).
      const reading = day && day === milestoneDue && order.milestoneId ? milestoneReadingOf(milestoneRisksOf(ctx)[order.milestoneId]) : undefined;
      const sitting = reading?.sitting && reading.startsAt ? reading.startsAt : undefined;
      return day ? { deadline: toZonedInstant(day, sitting ?? "23:59", zone) } : {};
    })(),
    ...(release ? { notBefore: toZonedInstant(release, "00:00", zone) } : {}),
    ...(dependsOn?.length ? { dependsOn } : {}),
    ...(riskBuffer ? { riskBufferDays: riskBuffer } : {}),
    ...(riskBuffer || forecastShortOf(ctx, order.milestoneId, milestoneDue) ? { atRisk: true } : {}),
    interruptible: core?.interruptible ?? true
  };
};

/**
 * A byproduct's landing order (see `#materializeByproducts`): it waits for its main order to be *done* — handed in,
 * not necessarily judged — and then has the same day to two days after to land, while the material is fresh.
 */
export function byproductLanding(ctx: AccessContext, order: { payload: unknown }): { dependsOn: string[]; dueDate?: string } | undefined {
  const primaryId = (order.payload as { byproductOf?: string } | undefined)?.byproductOf;
  if (!primaryId) return undefined;
  const store = getStore();
  const primary = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === primaryId);
  if (!primary || !["evidence_review", "accepted"].includes(primary.state)) return { dependsOn: [primaryId] };
  const doneAt = store.listExecutions(ctx.workspaceId, primaryId).map((execution) => execution.endedAt).filter((at): at is string => Boolean(at)).sort().at(-1);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const doneDay = doneAt ? formatInTimeZone(new Date(doneAt), zone, "yyyy-MM-dd") : planToday(ctx);
  return { dependsOn: [], dueDate: new Date(Date.parse(`${doneDay}T00:00:00Z`) + BYPRODUCT_LAG_DAYS * 86_400_000).toISOString().slice(0, 10) };
}
