import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { assistantAvailable } from "@crossline/db";
import { availableSlots, taskTitleOf, type AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { capacityLine } from "../measured-capacity";
import { recommendNextActions } from "@crossline/planner";
import { energyCalibration, predictEnergyTransition, readTransitionOutcomes } from "../energy-learning";
import { energyModel } from "../energy";
import type { DashboardAction, DashboardData } from "../../app/dashboard-view";
import { FIRST_DRAFTS_SETTING, firstDraftsState } from "@crossline/core";
import { milestonesBeingBackplanned } from "../backplan-status";
import { nearestDueProposal } from "../urgent-proposal";
import { proposalReady } from "@crossline/core";
import { energyRhythm, statedSleep } from "@crossline/core";
import { statedWeeklyHours, weeklyAvailableHours } from "@crossline/core";
import { identityLines } from "../lines";
import { localeFor, tOf } from "../locale";
import { intlLocale } from "../i18n";
import { getStore } from "./store";
import { planToday, toZonedInstant } from "./clock";
import { type ActionableOrder, ACTIONABLE, humanCoreOf, plannerTaskOf, remainingMinutes, resolvedEstimate, withoutShadowingDemos } from "./planner-tasks";
import { inputsReady } from "./work-orders";
import { readAvailability, readSchedulePreferences } from "./schedule-settings";
import { ensureSeeded } from "./seed";
import { libraryUntil, readGoalSettings } from "./goals";
import { latestCapacity } from "./activity";
import { loadCurrentPlan } from "./schedule";
import { accents, currentMilestoneLabel, relationKindLabel } from "./milestones";

/**
 * The first day this order may be worked on. Waiting for someone: the expected day while it is still ahead;
 * once that day has passed without the person saying it came, not before tomorrow — the Today card asks, and
 * scheduling work on data that may not exist is the thing the waiting item is there to stop. Arrived or
 * dropped: no constraint. Without a waiting item, the release date the capture itself named.
 */
export function releaseDayOf(ctx: AccessContext, order: { id: string; payload: unknown }): string | undefined {
  const waiting = getStore().listWaitingItems(ctx.workspaceId).filter((item) => item.blocks.includes(order.id));
  const today = planToday(ctx);
  const open = waiting.filter((item) => item.state === "open");
  if (open.length) {
    const latest = open.map((item) => item.expectedAt > today ? item.expectedAt : item.followUpAt > today ? item.followUpAt
      : new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)).sort().at(-1);
    return latest;
  }
  if (waiting.length) return undefined;
  const release = (order.payload as { notBefore?: string }).notBefore;
  return release && /^\d{4}-\d{2}-\d{2}$/.test(release) && release > today ? release : undefined;
}

/** Every WorkOrder's first arrival at `accepted`, deduped by entity — a revoke-then-reaccept cycle must
 * not count as two completions of the same thing. */
export function firstAcceptedAt(workspaceId: string): Map<string, string> {
  const earliest = new Map<string, string>();
  for (const event of getStore().listEvents(workspaceId, { type: "work_order.transitioned" })) {
    if ((event.payload as { to?: string }).to !== "accepted") continue;
    const seen = earliest.get(event.entityId);
    if (!seen || event.createdAt < seen) earliest.set(event.entityId, event.createdAt);
  }
  return earliest;
}

/**
 * Streak and weekly count, read straight off real acceptance timestamps. No protected streak and no
 * grace period: a day with nothing accepted yet reads as a real 0, the same "reflect the database's
 * literal current state" rule every other honest-state widget in this app already follows — there is no
 * "keep your streak" nudge and no un-breaking it after the fact. Pure, like `effectiveEstimate` — the
 * hydration (`firstAcceptedAt`'s ledger read) happens in `loadDashboard`.
 */
export function acceptanceProgress(timestamps: string[], timeZone: string, now: Date): { streakDays: number; weekCount: number } {
  const localDay = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(t));
  const weekCount = timestamps.filter((iso) => Date.parse(iso) >= now.getTime() - 7 * 86_400_000).length;
  const days = new Set(timestamps.map((iso) => localDay(Date.parse(iso))));
  let streakDays = 0;
  for (let cursor = now.getTime(); days.has(localDay(cursor)); cursor -= 86_400_000) streakDays += 1;
  return { streakDays, weekCount };
}

/**
 * Steps finished since `since`, each counted once: one whose latest change says done and which was marked done inside the window. A step
 * opened again afterwards does not count. Shown beside the weekly task count (the person's decision of 2026-11-11, W-258): long tasks
 * are many steps, and a week of finished steps read as 「本周完成 0 件」.
 */
export function stepsDoneSince(events: Array<{ entityId: string; createdAt: string; payload: unknown }>, since: Date): number {
  const latest = new Map<string, { status: string; at: string; doneAt?: string }>();
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const { stepId, status } = (event.payload ?? {}) as { stepId?: string; status?: string };
    if (!stepId || !status) continue;
    const key = `${event.entityId}|${stepId}`;
    const previous = latest.get(key);
    const doneAt = status === "done" ? (previous?.status === "done" ? previous.doneAt : event.createdAt) : undefined;
    latest.set(key, { status, at: event.createdAt, ...(doneAt ? { doneAt } : {}) });
  }
  return [...latest.values()].filter((item) => item.status === "done" && item.doneAt && Date.parse(item.doneAt) >= since.getTime()).length;
}

const toAction = (ctx: AccessContext, order: ActionableOrder | undefined, reason: string): DashboardAction | undefined => order ? ({
  id: order.id,
  title: order.intent,
  identityId: order.identityId,
  estimate: resolvedEstimate(ctx, order),
  ...(humanCoreOf(order)?.energy ? { energy: humanCoreOf(order)!.energy as "low" | "medium" | "high" } : {}),
  reason,
  // An unbound task (analysed before any milestone existed, or serving none) is not waiting for anything; it says so.
  milestone: getStore().listMilestones(ctx.workspaceId).find((item) => item.id === order.milestoneId)?.title ?? tOf(ctx)("未挂里程碑"),
  inputsReady: inputsReady(order)
}) : undefined;

// `taskDetailById`/`milestoneDetailById` are deliberately not part of this return type: they're batched
// in `page.tsx` instead, to avoid a circular import between this file and `lib/task-detail.ts` (which
// already imports from here). `page.tsx` spreads them into what this returns before handing it to
// `DashboardView`.
/**
 * What the Today head says about energy (docs/energy-and-ecosystem.md §3.4): the model's reading of now — the one the schedule uses —
 * with its basis, the day's capacity when it is held below its share, and the person's own word when they gave it in the last four
 * hours (which then also stands for the current slot).
 */
function energyEstimateFor(ctx: AccessContext, now: Date, today: string, timeZone: string): NonNullable<DashboardData["energyEstimate"]> {
  const model = energyModel(ctx, readAvailability(ctx));
  const prediction = model.predict(now.toISOString());
  // The day's curve for Today's energy card (2026-10-28): the same model read every half hour from 06:00 to midnight, with the person's
  // own cut points between low, medium and high. Without a known last sleep it is the usual day instead (below).
  const points = Array.from({ length: 36 }, (_, index) => 360 + index * 30).flatMap((minute) => {
    let at: string;
    try { at = toZonedInstant(today, `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, timeZone); } catch { return []; }
    const alertness = model.predict(at).alertness;
    return alertness === undefined ? [] : [{ minute, alertness }];
  });
  const [hour = "0", minuteOfHour = "0"] = formatInTimeZone(now, timeZone, "HH:mm").split(":");
  const nowMinute = Number(hour) * 60 + Number(minuteOfHour);
  // Drawn whatever is known (2026-10-30, the owner): without last night's sleep, the model's steady day at the person's usual sleep —
  // the medians of their recorded nights, else the night they stated in the interview, else a typical adult's 23:30–7:30 (energyRhythm) — at the phase their best hours set, with
  // their own cut points. It is marked as such and only drawn: a reading of now and the schedule still need a known last sleep.
  const usual = points.length >= 12 ? undefined : energyRhythm({ episodes: model.episodes, hourOf: model.hourOf, weekdayOf: (iso) => Number(formatInTimeZone(new Date(iso), timeZone, "i")),
    phaseShift: model.phaseShift, calibration: model.calibration, reports: [], now: now.toISOString(), stated: statedSleep(getStore().listProfileFacts(ctx.workspaceId)) });
  const curve = usual
    ? { points: usual.curve.flatMap((point) => point.hour >= 6 && point.value !== null ? [{ minute: point.hour * 60, alertness: point.value }] : []),
      low: model.calibration.low, high: model.calibration.high, nowMinute, typical: { nights: usual.nights, from: usual.sleep.from, to: usual.sleep.to } }
    : { points, low: model.calibration.low, high: model.calibration.high, nowMinute };
  const capacity = model.capacity(now.toISOString(), today);
  const report = getStore().listEnergyObservations(ctx.workspaceId)
    .filter((item) => item.source === "self_report" && item.level !== "uncalibrated" && now.getTime() - Date.parse(item.observedAt) < 4 * 3_600_000)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  // 「不知道最近一次睡眠」 is not said on the card: the curve is drawn anyway (the owner, 2026-10-30).
  return { level: prediction.level, confidence: prediction.confidence, basis: prediction.alertness === undefined ? [] : prediction.basis,
    ...(capacity.multiplier < 1 ? { capacity } : {}),
    ...(report ? { selfReport: report.level as "low" | "medium" | "high" } : {}),
    curve };
}

export async function loadDashboard(ctx: AccessContext): Promise<Omit<DashboardData, "taskDetailById" | "milestoneDetailById">> {
  const t = tOf(ctx);
  ensureSeeded(ctx);
  const store = getStore();
  const orders = store.listWorkOrders(ctx.workspaceId);
  // Row order must not leak into the page: `updated_at` ties break on id, so whether the clock
  // ticked mid-seed decided the order and Today reshuffled between loads.
  // Capacity is a constraint, not an identity competing for the same list. Keyed on the pack's `kind`
  // rather than the literal id "health", so a different pack set keeps the same distinction.
  const capacityIdentityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  // Work waiting in the task library is not recommended either: it enters 「下一步」 when it enters the schedule.
  const libraryDay = planToday(ctx, now);
  const active = withoutShadowingDemos(orders, capacityIdentityIds)
    .filter((order) => !capacityIdentityIds.has(order.identityId) && ACTIONABLE.includes(order.state) && !libraryUntil(ctx, order, libraryDay))
    .sort((a, b) => ACTIONABLE.indexOf(a.state) - ACTIONABLE.indexOf(b.state) || a.id.localeCompare(b.id));
  const capacity = latestCapacity(ctx, now);
  const outcomes = readTransitionOutcomes(store.listEvents(ctx.workspaceId, { type: "energy.transition_outcome" }));
  const forecast = capacity.level === "uncalibrated" ? {} : Object.fromEntries(active.flatMap((order) => {
    const needed = humanCoreOf(order)?.energy;
    return needed === "low" || needed === "medium" || needed === "high"
      ? [[order.id, predictEnergyTransition(capacity.level as "low" | "medium" | "high",
        needed, outcomes).predicted]] : [];
  }));
  // Work that may not start yet — a homework not out, a wait not answered (`releaseDayOf`) — is not offered as 「下一步」 with 开始计时:
  // the scheduler already kept it off today, and the recommendation offered 「完成 ECE 555 作业 3」 before it was posted (2026-10-15).
  const startable = active.filter((order) => { const release = releaseDayOf(ctx, order); return !release || release <= libraryDay; });
  const actions = recommendNextActions(startable.map((order) => plannerTaskOf(ctx, order)), 40,
    capacity.level === "uncalibrated" ? undefined : capacity.level, now, forecast);
  const milestones = store.listMilestones(ctx.workspaceId);
  const identityPacks = identityLines(ctx);
  const timeZone = readSchedulePreferences(ctx)?.timeZone
    ?? process.env.CROSSLINE_TIME_ZONE?.trim() ?? "America/Chicago";
  const time = new Intl.DateTimeFormat(intlLocale(localeFor(ctx)), {
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone
  }).format(now);
  const acceptedAt = firstAcceptedAt(ctx.workspaceId);
  const progress = { ...acceptanceProgress([...acceptedAt.values()], timeZone, now),
    weekSteps: stepsDoneSince(store.listEvents(ctx.workspaceId, { type: "task.step_progress" }), new Date(now.getTime() - 7 * 86_400_000)) };

  // Today's own capacity read: the weekly pattern for today only, not the calendar-adjusted multi-week
  // forecast Plan already owns.
  const today = planToday(ctx, now);

  // Reuses the same Plan-page scheduling read (`loadCurrentPlan` → `scheduledBlocks`) so Today's line and
  // the B lens agree on what "14:00–14:40" means instead of Today inventing a second notion of "when".
  // This is what makes `loadDashboard` async now — it used to stay sync specifically to avoid this call.
  const plan = await loadCurrentPlan(ctx);
  // What is still usable today: the weekly pattern minus today's calendar commitments, from now on. It
  // used to count the whole day's pattern, so at 21:10 the header still said 420 minutes were free.
  // Only what the day holds for the person: work blocks, the dashed preview of proposals still waiting (`proposed:`) and what is pencilled
  // in outside the hours (`optional:`) are the plan's own guesses, not commitments; counting the preview cut 「可用」 by its length (W-254).
  const busyToday = plan.blocks.filter((block) => (block.day ?? today) === today && !/^(scheduled|proposed|optional):/.test(block.id))
    .map((block) => ({ day: today, start: block.start, end: block.end }));
  const availableMinutes = remainingMinutes(availableSlots(readAvailability(ctx), [today], busyToday),
    formatInTimeZone(now, timeZone, "HH:mm"));
  // 「待办」 is the work the calendar holds for the rest of today (the person's decision of 2026-11-11, W-259): it used to be the p50 of
  // every task in progress, 48 hours under a label that said today.
  const committedMinutes = remainingMinutes(plan.blocks.filter((block) => (block.day ?? today) === today && block.id.startsWith("scheduled:")),
    formatInTimeZone(now, timeZone, "HH:mm"));
  const blockByWorkOrderToday = new Map(plan.blocks
    .filter((block) => (block.day ?? today) === today && block.id.startsWith("scheduled:"))
    .map((block) => [block.id.split(":")[1]!, block]));
  const milestoneTitleById = new Map(milestones.map((milestone) => [milestone.id, milestone.title]));

  // Read once, shared by both `flywheel` and `flywheelStrip` below — they used to each run this same
  // query independently.
  const approvedOrCandidateRelations = store.listMilestoneRelations(ctx.workspaceId)
    // Approved and candidate both show — same distinction the star map already draws with a dashed
    // line ("虚线为待周复盘确认"), just spelled out in words instead of a line style.
    .filter((relation) => relation.status === "approved" || relation.status === "candidate");

  // Cross-identity relations touching a milestone behind today's actionable work — the plain-English
  // "doing A moves B forward" that the star map only ever shows as an edge and a one-word kind label.
  const todayMilestoneIds = new Set(active.map((order) => order.milestoneId));
  const flywheel = approvedOrCandidateRelations
    .filter((relation) => todayMilestoneIds.has(relation.fromMilestoneId) || todayMilestoneIds.has(relation.toMilestoneId))
    .slice(0, 3)
    .map((relation) => ({
      id: relation.id,
      fromTitle: milestones.find((item) => item.id === relation.fromMilestoneId)?.title ?? relation.fromMilestoneId,
      toTitle: milestones.find((item) => item.id === relation.toMilestoneId)?.title ?? relation.toMilestoneId,
      kindLabel: relationKindLabel[relation.kind] ?? relation.kind,
      explanation: relation.explanation,
      pending: relation.status === "candidate"
    }));

  // Milestone-centric flywheel strip: nodes are milestones touched by any approved/candidate relation,
  // ordered left-to-right by their most recent real signal (a gate judgement or an acceptance recorded
  // against them) so newly active milestones surface at the right edge. Resolved fresh on every page
  // load — not a live push — so "grows to the right" means "next time this loads", which is what an
  // SSR app can promise; a milestone with a relation but no activity yet just sorts toward the left.
  const flywheelStrip = (() => {
    const relations = approvedOrCandidateRelations;
    if (!relations.length) return { nodes: [], edges: [] };

    const milestoneById = new Map(milestones.map((item) => [item.id, item]));
    const nodeIds = new Set<string>();
    for (const relation of relations) {
      if (milestoneById.has(relation.fromMilestoneId)) nodeIds.add(relation.fromMilestoneId);
      if (milestoneById.has(relation.toMilestoneId)) nodeIds.add(relation.toMilestoneId);
    }

    const gateEvents = store.listEvents(ctx.workspaceId, { type: "milestone_gate.judged" });
    const latestGateAt = new Map<string, string>();
    for (const event of gateEvents) {
      const milestoneId = (event.payload as { milestoneId?: string }).milestoneId;
      if (!milestoneId) continue;
      const seen = latestGateAt.get(milestoneId);
      if (!seen || event.createdAt > seen) latestGateAt.set(milestoneId, event.createdAt);
    }
    const latestAcceptedAtByMilestone = new Map<string, string>();
    for (const order of orders) {
      const when = acceptedAt.get(order.id);
      if (!when || !order.milestoneId) continue;
      const seen = latestAcceptedAtByMilestone.get(order.milestoneId);
      if (!seen || when > seen) latestAcceptedAtByMilestone.set(order.milestoneId, when);
    }
    const recencyOf = (milestoneId: string) => {
      const a = latestGateAt.get(milestoneId) ?? "";
      const b = latestAcceptedAtByMilestone.get(milestoneId) ?? "";
      return a > b ? a : b;
    };

    const nodes = [...nodeIds].map((id) => {
      const milestone = milestoneById.get(id)!;
      const acceptedCount = orders.filter((order) => order.milestoneId === id && order.state === "accepted").length;
      const gateCount = gateEvents.filter((event) => (event.payload as { milestoneId?: string }).milestoneId === id).length;
      const latestSignal = acceptedCount > 0 ? t("已验收 {{count}} 次", { count: acceptedCount })
        : gateCount > 0 ? t("已判定 {{count}} 次", { count: gateCount }) : t("等待进展");
      return { id, identityId: milestone.identityId, title: milestone.title, latestSignal, recency: recencyOf(id) };
    }).sort((a, b) => a.recency < b.recency ? -1 : a.recency > b.recency ? 1 : 0);

    const nodeIndex = new Set(nodes.map((node) => node.id));
    const edgeBuckets = new Map<string, { from: string; to: string; kinds: Record<string, number>; pending: boolean; count: number }>();
    for (const relation of relations) {
      if (!nodeIndex.has(relation.fromMilestoneId) || !nodeIndex.has(relation.toMilestoneId)) continue;
      const key = `${relation.fromMilestoneId}->${relation.toMilestoneId}`;
      const bucket = edgeBuckets.get(key) ?? { from: relation.fromMilestoneId, to: relation.toMilestoneId, kinds: {}, pending: false, count: 0 };
      bucket.kinds[relation.kind] = (bucket.kinds[relation.kind] ?? 0) + 1;
      bucket.count += 1;
      if (relation.status === "candidate") bucket.pending = true;
      edgeBuckets.set(key, bucket);
    }
    const edges = [...edgeBuckets.values()].map((bucket) => {
      const topKind = Object.entries(bucket.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      return { from: bucket.from, to: bucket.to, count: bucket.count, pending: bucket.pending, kindLabel: relationKindLabel[topKind] ? t(relationKindLabel[topKind]!) : topKind };
    });

    return { nodes: nodes.map(({ id, identityId, title, latestSignal }) => ({ id, identityId, title, latestSignal })), edges };
  })();

  const stepPlans = new Map(store.listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const planBlocked = new Set(store.listEvents(ctx.workspaceId, { type: "task.steps_blocked" }).map((event) => event.entityId));
  const readyProposals = orders.filter((order) => order.state === "awaiting_plan_approval" && !(order.payload as { seeded?: boolean } | undefined)?.seeded
    && proposalReady(order, stepPlans.get(order.id), { planBlocked: planBlocked.has(order.id), exempt: capacityIdentityIds.has(order.identityId) }));
  // Unapproved work is never scheduled, so a proposal due within a week is named above 「下一步」 (W-31).
  const anchorDays = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const urgentProposal = nearestDueProposal(readyProposals.map((order) => ({ id: order.id, title: taskTitleOf(order),
    due: (order.payload as { dueDate?: string } | undefined)?.dueDate || (order.milestoneId ? readGoalSettings(ctx, order.milestoneId)?.confirmedDeadline ?? anchorDays.get(order.milestoneId) : undefined) })), libraryDay);
  const energySelected = capacity.level !== "uncalibrated";
  const primaryReason = energySelected
    ? actions.primary?.deadline && Date.parse(actions.primary.deadline) - now.getTime() <= 24 * 60 * 60_000
      ? t("已确认截止时间临近；即使当前精力不匹配仍优先显示，请考虑先休息 10 分钟")
      : actions.primary?.energy === capacity.level
        ? t(capacity.level === "low" ? "当前低精力自评与所需精力匹配，输入已就绪" : capacity.level === "high" ? "当前高精力自评与所需精力匹配，输入已就绪"
          : "当前中精力自评与所需精力匹配，输入已就绪")
        : t("暂无精力完全匹配的就绪作业，展示可执行的最高优先级备选")
    : t("输入已就绪，按目标重要性和估时推荐；尚无新鲜精力自评");
  const primary = toAction(ctx, active.find((task) => task.id === actions.primary?.id), primaryReason);
  const higherPriority = toAction(ctx, active.find((task) => task.id === actions.higherPriority?.id),
    t("优先级更高，但当前精力与任务要求不匹配；保留供本人决定"));
  const lowEnergy = toAction(ctx, active.find((task) => task.id === actions.lowEnergy?.id), t("标注为低精力任务，启动阻力最小"));
  const shortGap = toAction(ctx, active.find((task) => task.id === actions.shortGap?.id), t("先验 p85 在 40 分钟以内，可放进短空档"));
  return {
    principalId: ctx.principalId,
    workspaceId: ctx.workspaceId,
    nowLabel: time,
    nowIso: now.toISOString(),
    timeZone,
    clockPinned: Boolean(process.env.CROSSLINE_FIXED_NOW),
    dateLabel: new Intl.DateTimeFormat("en-US", { day: "2-digit", timeZone }).format(now),
    monthLabel: new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone }).format(now).toUpperCase(),
    // 「本机活动采集未开启」 points at a switch only this computer's owner has (2026-10-15 walkthrough): not said to a guest.
    capacity: assistantAvailable(store, ctx.workspaceId) ? capacity
      : { ...capacity, blockers: capacity.blockers.filter((blocker) => blocker.code !== "LOCAL_ACTIVITY_NOT_AUTHORISED") },
    energyEstimate: energyEstimateFor(ctx, now, today, timeZone),
    energyLearning: energyCalibration(outcomes),
    // Only proposals that are decisions already: one whose steps are still being planned is not counted (`proposalReady`, W-31).
    awaitingApproval: readyProposals.length,
    ...(urgentProposal ? { urgentProposal } : {}),
    // Milestones that exist and wait for approval, and whether any exist at all: an empty 「下一步」 says which step comes next.
    milestones: { drafts: new Set(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").map((item) => item.id)).size,
      any: store.listMilestones(ctx.workspaceId).some((item) => item.status !== "archived"),
      firstDrafts: firstDraftsState(store.getSetting(ctx.workspaceId, FIRST_DRAFTS_SETTING), store.listMilestones(ctx.workspaceId).some((item) => item.status !== "archived"), now),
      backplanning: milestonesBeingBackplanned(store, ctx.workspaceId, libraryDay) },
    ...(primary ? { primary } : {}),
    ...(higherPriority ? { higherPriority } : {}),
    ...(lowEnergy ? { lowEnergy } : {}),
    ...(shortGap ? { shortGap } : {}),
    care: store.listCapacityCommitments(ctx.workspaceId).map((item) => ({ title: item.title, minimumMinutes: item.minimumMinutes })),
    progress,
    todayCapacity: { availableMinutes, committedMinutes,
      basis: { ...capacityLine(ctx, null, now), statedWeekly: statedWeeklyHours(store.listProfileFacts(ctx.workspaceId)) ?? weeklyAvailableHours(readAvailability(ctx)) } },
    flywheel,
    flywheelStrip,
    identities: identityPacks.map((pack) => {
      const anchorsByMilestone = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
      const identityOrders = orders.filter((order) => order.identityId === pack.id);
      const completed = identityOrders.filter((order) => order.state === "accepted").length;
      const total = identityOrders.length;
      return {
        id: pack.id,
        label: pack.label,
        accent: accents[pack.id] ?? "#6D5EF5",
        completedCount: completed,
        activeMilestone: currentMilestoneLabel(milestones, anchorsByMilestone, pack.id, localeFor(ctx)),
        taskCount: total - completed,
        totalCount: total,
        pct: total > 0 ? Math.round((completed / total) * 100) : 0
      };
    }),
    // Ordered by what needs the person next, then capped — not captures first, then whatever fits.
    // With captures first, six raw notes filled the whole list and the proposal that had just come back
    // from analysis was pushed off the page, which is the same broken link as never listing it at all.
    // A `discarded` capture is not listed at all; it used to fall through to the 「正在分析」 branch and
    // come back as though the system were still working on something the person had thrown away.
    upcoming: [
      ...orders.filter((order) => order.state === "awaiting_plan_approval").map((order) => ({
        id: order.id, title: order.intent, identityId: order.identityId, status: t("待批准"),
        ...(order.milestoneId && milestoneTitleById.has(order.milestoneId)
          ? { milestoneTitle: milestoneTitleById.get(order.milestoneId)! } : {})
      })),
      // A scheduled block's real `HH:mm–HH:mm` beats a duration guess whenever the planner actually
      // placed this order today; when it did not (dependency blocker, no capacity left, pushed to a
      // later day), `time` stays unset and the status text says so explicitly instead of a vague "待排程".
      ...active.map((order) => {
        const block = blockByWorkOrderToday.get(order.id);
        const status = order.state === "approved" ? t("已批准 · 等待材料")
          : order.state === "preparing" ? t("材料准备中")
          : order.state === "active" ? t("执行中")
          : block ? t("预计 {{minutes}} 分钟", { minutes: resolvedEstimate(ctx, order).p50Minutes })
          : t("预计 {{minutes}} 分钟 · 规划器未排入今天", { minutes: resolvedEstimate(ctx, order).p50Minutes });
        return {
          id: order.id, title: order.intent, identityId: order.identityId, status,
          ...(block ? { time: `${block.start}–${block.end}` } : {}),
          ...(order.milestoneId && milestoneTitleById.has(order.milestoneId)
            ? { milestoneTitle: milestoneTitleById.get(order.milestoneId)! } : {})
        };
      }),
      ...store.listCaptures(ctx.workspaceId)
        .filter((item) => item.state === "blocked" || item.state === "captured" || item.state === "analyzing")
        .map((item) => ({
          id: item.id, title: item.title, identityId: "unclassified",
          status: item.state === "captured" ? t("已保存 · 未分类 / 未估时 · Workbench 分析")
            : item.state === "blocked" ? t("分析阻塞 · 可人工处理") : t("正在分析")
        }))
    ].slice(0, 6),
    // Real activity, not a proxy read off `milestone.status` alone — that used to call every
    // milestone-bound WorkOrder still in flight "零进展" the moment it had not yet reached
    // `accepted`, which is the everyday case, not the exception.
    milestonePulse: milestones.slice(0, 4).map((milestone) => {
      const acceptedCount = [...acceptedAt.keys()]
        .filter((id) => orders.find((order) => order.id === id)?.milestoneId === milestone.id).length;
      return {
        id: milestone.id,
        identity: ((label) => label ? t(label) : milestone.identityId)(identityPacks.find((pack) => pack.id === milestone.identityId)?.label),
        title: milestone.title,
        evidence: acceptedCount
          ? t(milestone.status === "approved" ? "已批准 · 已验收 {{count}} 次" : "等待批准 · 已验收 {{count}} 次", { count: acceptedCount })
          : milestone.status === "approved" ? t("已批准 · 等待新证据") : t("等待批准")
      };
    })
  };
}
