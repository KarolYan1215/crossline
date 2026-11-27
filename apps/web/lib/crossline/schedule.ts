import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import { openNeedsOf } from "@crossline/db";
import { availableSlots, taskTitleOf, type AccessContext, type AvailabilityWindow, FIXED_EVENTS, fixedEventBlocks, type FixedEvent, readTravelState, travelBlocks, MAIL_EVENTS_SETTING, mailEventsOnSchedule, readMailEvents, settleFrozen } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { dailyCapsFor } from "../measured-capacity";
import { planHeadDiffers, planSchedule, scheduleInputHash, type PlanResult, type PlanningInput } from "@crossline/planner";
import { optimalFor, optimalSolveEnabled, requestOptimal } from "../optimal-schedule";
import { energyModel, slotEnergy } from "../energy";
import { STEP_ENERGY_CEILING, learnedEfficiency, type EfficiencySample, type StepRole, CALENDAR_LINES, isCancelledEvent, type CalendarLines } from "@crossline/core";
import { OVER_CAPACITY_TAG } from "@crossline/core";
import { memoByLedger, memoByLedgerAsync } from "../ledger-memo";
import { localeFor, tOf } from "../locale";
import { type ActionableOrder, ACTIONABLE, humanCoreOf, plannerTaskOf, withoutShadowingDemos } from "./planner-tasks";
import { effectiveParams, effectiveSchedulePreferences, readAvailability, readLineShares } from "./schedule-settings";
import { inPreview, previewScope, withPreview } from "./preview";
import { getStore } from "./store";
import { delayBlock, plannerIdOfBlock, readFrozen, scheduledBlockId, stepTaskId } from "./frozen";
import { appNow, planDays, planToday, toZonedInstant } from "./clock";
import { latestCapacity } from "./activity";
import { libraryUntil } from "./goals";
import { ensureSeeded } from "./seed";
import { noteScheduleChanges } from "./schedule-notes";

export type PersistedScheduleBlock = {
  id: string;
  lane: "human" | "ai";
  title: string;
  /** A scheduled block's task and step, apart (the calendar draws the task as the title and the step under it). */
  task?: string;
  step?: string;
  /** Its standing in one or two words (暂定, 预排, 本周未排完…), drawn as a tag instead of a prefix in the title. */
  tag?: string;
  /** Absent on seeded examples: they illustrate a typical day rather than claiming a date. */
  day?: string;
  start: string;
  end: string;
  source: string;
  readOnly: boolean;
  /**
   * A scheduled block's energy (docs/energy-and-ecosystem.md §3): the slot's, the work's, and the share of an hour's work the plan
   * counted on there. The completion check records it, so the factors can be learned (`learnedEfficiency`).
   */
  energy?: { slot: "low" | "medium" | "high"; need: "low" | "medium" | "high"; efficiency: number };
  /** Where it happens (an event the person added, a synced calendar event): a physical place gets 「路上」 blocks around it. */
  location?: string;
};

export type PersistedPlan = {
  id: string;
  version: number;
  blocks: PersistedScheduleBlock[];
  schedule: Pick<PlanResult, "status" | "blockers" | "solver" | "bufferRelaxed" | "notes"> & {
    /** The planner input's cache key and whether the blocks are the cached optimal plan (docs/loop-and-scout.md §2); absent in a preview. */
    inputHash?: string; optimal?: boolean;
    /** No background solve runs here (the hosted beta): the greedy plan is the plan, and nothing will replace it (W-248). */
    simpleOnly?: boolean };
  /** True when nobody has saved a real time zone/availability/mode yet and this is computed off
   * defaults — a real, honestly-labelled preview rather than an empty page. */
  usingDefaultPreferences: boolean;
};

/**
 * The stretches between 07:00 and 23:00 outside the person's availability: where a task that did not fit may be pencilled in. Marked
 * high energy so the energy gate does not keep work out of them — whether to work then at all is the person's call, made by starting it.
 */
function offHoursWindows(windows: AvailabilityWindow[]): AvailabilityWindow[] {
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
  return [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => {
    const covered = windows.filter((window) => window.days.includes(weekday))
      .map((window) => [minutes(window.start), Math.min(minutes(window.end) || 1440, 1440)] as const).sort((a, b) => a[0] - b[0]);
    // A day with no hours at all is a day off: overflow is pencilled around working days, not into the rest day (it put nine hours on a
    // Sunday the person keeps free, 2026-10-18 walkthrough, W-48).
    if (!covered.length) return [];
    const out: AvailabilityWindow[] = [];
    let cursor = 7 * 60;
    for (const [from, to] of covered) {
      if (from > cursor) out.push({ days: [weekday], start: clock(cursor), end: clock(Math.min(from, 23 * 60)), energy: "high" });
      cursor = Math.max(cursor, to);
      if (cursor >= 23 * 60) break;
    }
    if (cursor < 23 * 60) out.push({ days: [weekday], start: clock(cursor), end: "23:00", energy: "high" });
    return out.filter((window) => window.start < window.end);
  });
}
export const scaledEstimate = <E extends { p25Minutes: number; p50Minutes: number; p85Minutes: number }>(estimate: E, p50: number | undefined): E =>
  p50 === undefined || p50 <= 0 ? estimate : { ...estimate, p50Minutes: Math.round(p50), p25Minutes: Math.max(1, Math.round(estimate.p25Minutes * p50 / Math.max(1, estimate.p50Minutes))),
    p85Minutes: Math.max(Math.round(p50), Math.round(estimate.p85Minutes * p50 / Math.max(1, estimate.p50Minutes))) };

const ENERGY_RANK = { low: 1, medium: 2, high: 3 } as const;

/**
 * The planner's input for a set of orders. A task with a step plan is placed step by step: each open, schedulable step is its own
 * planner task, keeping the task's tier, deadline and release, the step's own window, and its dependencies (on earlier steps, and for
 * its first steps on the work the task itself waits for). A task without a plan yet is placed whole, as before.
 */
export function plannerItemsFor(ctx: AccessContext, orders: ActionableOrder[], { hold = true }: { hold?: boolean } = {}) {
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const overrides = previewScope.getStore()?.estimates ?? {};
  const stepPlans = new Map(getStore().listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, plan]));
  const openSteps = (orderId: string) => stepPlans.get(orderId)?.steps.filter((step) => step.status === "planned" && step.schedulable) ?? [];
  // A step that uses material nobody has supplied yet, or comes after an unfinished wait (a reply, data from someone else), takes no
  // calendar time until it arrives, and neither does anything after it (2026-10-28: 「完成 ECE 555 作业 3」 waited for its problem set and
  // still held three morning hours; the NeuroSim task's checking steps filled an afternoon behind 「等待实测数据回传」, because a wait step
  // is not on the calendar and so was dropped as a dependency). The forecast (`hold: false`) still counts the work.
  const waitingOnMaterial = (orderId: string) => {
    const plan = stepPlans.get(orderId);
    const blocked = new Set(hold ? plan?.steps.filter((step) => step.status === "planned" && (step.role === "wait" || openNeedsOf(plan, step).length))
      .map((step) => step.id) ?? [] : []);
    for (let grew = blocked.size > 0; grew;) {
      grew = false;
      for (const step of plan!.steps) if (!blocked.has(step.id) && step.dependsOn.some((dep) => blocked.has(dep))) { blocked.add(step.id); grew = true; }
    }
    return blocked;
  };
  const allOpenSteps = openSteps;
  const readySteps = (orderId: string) => { const blocked = waitingOnMaterial(orderId); return allOpenSteps(orderId).filter((step) => !blocked.has(step.id)); };
  const plannerIdsOf = (orderId: string) => { const steps = readySteps(orderId); return steps.length ? steps.map((step) => stepTaskId(orderId, step.id)) : [orderId]; };
  const localToday = formatInTimeZone(process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date(), zone, "yyyy-MM-dd");
  return orders.flatMap((order) => {
    const base = plannerTaskOf(ctx, order);
    const steps = readySteps(order.id);
    // Only a task with no step plan is placed whole. One whose plan has nothing of the person's left to place (every step done, or only the
    // assistant's or a wait still open) takes no time: it was placed whole again, at the task's own estimate, every day — the month
    // simulation saw a task with all eight steps done get a block a day for three weeks once its last step, a wait, was answered.
    if (!steps.length) return allOpenSteps(order.id).length || stepPlans.get(order.id)?.steps.length ? []
      : [{ task: base, orderId: order.id, title: base.title, step: undefined as string | undefined }];
    const open = new Set(steps.map((step) => step.id));
    const external = (base.dependsOn ?? []).flatMap((id) => plannerIdsOf(id));
    return steps.map((step) => {
      const internal = step.dependsOn.filter((dep) => open.has(dep)).map((dep) => stepTaskId(order.id, dep));
      const stepStart = step.notBefore ? toZonedInstant(step.notBefore, "00:00", zone) : undefined;
      // A step's own day is pacing inside the task, not a deadline of its own: from that day on the task's deadline governs. Kept as
      // a hard limit, a homework whose steps slipped became unplaceable the evening before it was due — one step was still "due
      // tonight" with tonight's hours already gone, and every later step waited on it.
      const stepDue = step.dueBy && step.dueBy > localToday ? toZonedInstant(step.dueBy, "23:59", zone) : undefined;
      const notBefore = [base.notBefore, stepStart].filter(Boolean).sort().at(-1);
      const deadline = [base.deadline, stepDue].filter(Boolean).sort()[0];
      const { notBefore: _n, deadline: _d, dependsOn: _deps, energy: taskEnergy, ...rest } = base;
      // The lower of the task's energy and what this kind of step needs: handing in or reading through takes no high-energy hour.
      const ceiling = STEP_ENERGY_CEILING[step.role as StepRole];
      const energy = taskEnergy && ceiling && ENERGY_RANK[ceiling] < ENERGY_RANK[taskEnergy] ? ceiling : taskEnergy;
      const id = stepTaskId(order.id, step.id);
      // The task's short name: its description reached the plan page's notes and blockers as a whole paragraph (2026-10-18 walkthrough).
      return { orderId: order.id, title: `${taskTitleOf(order)} · ${step.title}`, step: step.title as string | undefined, task: { ...rest, id,
        title: `${taskTitleOf(order)} · ${step.title}`, estimate: scaledEstimate({ ...base.estimate, ...step.estimate }, overrides[id]),
        ...(energy ? { energy } : {}), ...(notBefore ? { notBefore } : {}), ...(deadline ? { deadline } : {}),
        ...(internal.length || external.length ? { dependsOn: internal.length ? internal : external } : {}) } };
    });
  });
}

/**
 * The person's own yield in slots short of the work's energy, from the blocks they confirmed (`block.confirmed` carries the block's
 * energy since 2026-10-14), or undefined while the assumed 0.8 and 0.65 predict as well. Blocks that produced nothing go in as
 * `done: false` — answered 「未执行」, or seen under way on a past day (`nudge.blocks:<day>`) with no timer that day and no answer — and
 * `learnedEfficiency` counts them only when its backtest favours that (2026-10-20).
 */
export function personalEfficiency(ctx: AccessContext, now = new Date()): [number, number] | undefined {
  type Energy = { slot: "low" | "medium" | "high"; need: "low" | "medium" | "high"; efficiency: number };
  type Confirmed = { blockId?: string; day?: string; outcome?: string; minutes?: number; blockMinutes?: number; energy?: Energy };
  const store = getStore();
  const confirmed = store.listEvents(ctx.workspaceId, { type: "work_order.changed", change: "block_confirmed" });
  const samples: EfficiencySample[] = confirmed.flatMap((event) => {
    const payload = event.payload as Confirmed;
    if (!payload.energy || !payload.blockMinutes) return [];
    const base = { at: event.createdAt, slot: payload.energy.slot, need: payload.energy.need, planned: payload.energy.efficiency, blockMinutes: payload.blockMinutes };
    if (payload.outcome === "not_done") return [{ ...base, minutes: 0, done: false }];
    return payload.minutes ? [{ ...base, minutes: payload.minutes }] : [];
  });
  const answered = new Set(confirmed.map((event) => { const payload = event.payload as Confirmed; return `${payload.blockId}|${payload.day}`; }));
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const startedOn = new Set(store.listExecutions(ctx.workspaceId).map((execution) => `${execution.workOrderId}|${formatInTimeZone(new Date(execution.startedAt), zone, "yyyy-MM-dd")}`));
  const today = planToday(ctx, now);
  for (let back = 1; back <= MISSED_LOOKBACK_DAYS; back += 1) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    let seen: Record<string, { id: string; orderId: string; start: string; end: string; began?: boolean; energy?: Energy }> = {};
    try { seen = JSON.parse(store.getSetting(ctx.workspaceId, `nudge.blocks:${day}`) ?? "{}"); } catch { continue; }
    for (const block of Object.values(seen)) {
      if (!block.began || !block.energy || answered.has(`${block.id}|${day}`) || startedOn.has(`${block.orderId}|${day}`)) continue;
      const [sh, sm] = block.start.split(":").map(Number), [eh, em] = block.end.split(":").map(Number);
      const blockMinutes = ((eh ?? 0) * 60 + (em ?? 0)) - ((sh ?? 0) * 60 + (sm ?? 0));
      if (blockMinutes > 0) samples.push({ at: toZonedInstant(day, block.end, zone), slot: block.energy.slot, need: block.energy.need,
        planned: block.energy.efficiency, blockMinutes, minutes: 0, done: false });
    }
  }
  return learnedEfficiency(samples);
}
/** How far back the blocks seen under way are read for ones that went by unused. */
const MISSED_LOOKBACK_DAYS = 28;

/**
 * Everything the scheduler is given for the person's week, built once: the planner input itself plus the pieces `scheduledBlocks`
 * needs afterwards to name, tag and extend the result. Pulled out so the cache key and the bench script read the same input.
 */
export function planningInputFor(ctx: AccessContext, today: string, committed: PersistedScheduleBlock[]) {
  const days = planDays(today);
  const preferences = effectiveSchedulePreferences(ctx).preferences;
  const zone = preferences.timeZone;
  const iso = (day: string, time: string) => toZonedInstant(day, time, zone);
  const now = process.env.CROSSLINE_FIXED_NOW ? new Date(process.env.CROSSLINE_FIXED_NOW) : new Date();
  // 「后面都推 10 分钟」 holds the time from now until then (`shiftToday`).
  const delay = delayBlock(ctx, now, zone);
  const busy = [...committed.filter((block) => block.day)
    .map((block) => ({ day: block.day!, start: block.start, end: block.end })), ...(delay ? [delay] : [])];
  const slots = availableSlots(readAvailability(ctx), days, busy);
  const capacity = latestCapacity(ctx, now);
  const currentEnergy = previewScope.getStore()?.currentEnergy ?? (capacity.basis.includes("self_report") && capacity.level !== "uncalibrated"
    ? capacity.level : undefined);
  const currentClock = formatInTimeZone(now, zone, "HH:mm");
  const currentSlot = slots.findIndex((slot) => slot.day === today && slot.end > currentClock);
  const clockBlockers: PlanResult["blockers"] = [];
  // The energy expected in each slot: the person's word for the slot they are in, the model's for the rest when it is sure enough,
  // the pattern's otherwise (docs/one-input.md §5).
  const model = energyModel(ctx, readAvailability(ctx));
  // A tired day (sleep debt, a heart-rate reading off the person's baseline) holds today's work without a deadline below its share.
  const dayCapacity = model.capacity(now.toISOString(), today);
  const instants = slots.flatMap((slot, index) => {
    try { const start = iso(slot.day, slot.start); return [{ start, end: iso(slot.day, slot.end),
      day: slot.day, energy: currentEnergy && index === currentSlot ? currentEnergy : slotEnergy(model, String(start), slot.energy) }]; }
    catch (error) {
      clockBlockers.push({ taskId: "availability", code: error instanceof Error ? error.message : "AVAILABILITY_LOCAL_TIME_INVALID",
        message: tOf(ctx)("{{day}} {{start}}–{{end}} 跨越时钟调整，请修改这段可用时间", { day: slot.day, start: slot.start, end: slot.end }) });
      return [];
    }
  });
  const capacityIds = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const allOrders = getStore().listWorkOrders(ctx.workspaceId);
  const orders = withoutShadowingDemos(allOrders, capacityIds)
    .filter((order) => ACTIONABLE.includes(order.state) && !capacityIds.has(order.identityId));
  const stateById = new Map(allOrders.map((order) => [order.id, order.state]));
  const dependencyBlockers = orders.filter((order) => (plannerTaskOf(ctx, order).dependsOn ?? [])
    .some((id) => stateById.get(id) !== "accepted" && !orders.some((item) => item.id === id)))
    .map((order) => ({ taskId: order.id, code: "DEPENDENCY_NOT_READY",
      message: tOf(ctx)("{{title}}的前置作业尚未验收，暂不排入", { title: order.intent }) }));
  // Each line's share of the week: what the person set, else what they said in the interview. A line with a share also offers its
  // library work (milestone due beyond the window) as floor-only, so a far deadline no longer means no hours at all.
  const shares = readLineShares(ctx);
  const library = new Set(orders.filter((order) => libraryUntil(ctx, order, today) && (shares?.[order.identityId] ?? 0) > 0).map((order) => order.id));
  const eligibleOrders = orders.filter((order) => !dependencyBlockers.some((item) => item.taskId === order.id) && (!libraryUntil(ctx, order, today) || library.has(order.id)));
  const needsLookahead = eligibleOrders.some((order) => {
    const task = plannerTaskOf(ctx, order);
    return task.deadlineTier === 4 && Boolean(task.deadline);
  });
  const lookaheadAvailability = needsLookahead ? availableSlots(readAvailability(ctx), planDays(today, 56), busy)
    .flatMap((slot) => {
      try { return [{ start: iso(slot.day, slot.start), end: iso(slot.day, slot.end),
        day: slot.day, energy: slot.energy }]; }
      catch { return []; }
    }) : undefined;

  const expanded = plannerItemsFor(ctx, eligibleOrders);
  // Frozen blocks of work still open. One that a hard constraint now lands on moves if it was only kept or inside the commit window;
  // one the person started or locked stays (they are asked about it, `locked_conflict`), unless they already accepted the overlap.
  // Kept or committed blocks that land on each other or on a held block are let go as well, and a lock older than the task's deferral
  // (`notBefore`) lapses; a block the person started stays whatever happened since (`settleFrozen`).
  const busyInstants = busy.flatMap((block, index) => { try { return [{ id: `busy:${index}`, start: Date.parse(iso(block.day, block.start)), end: Date.parse(iso(block.day, block.end)) }]; } catch { return []; } });
  const releaseAt = new Map(expanded.flatMap((entry) => entry.task.notBefore ? [[entry.task.id, Date.parse(entry.task.notBefore)] as const] : []));
  const frozen = settleFrozen(readFrozen(ctx, now).filter((item) => expanded.some((entry) => entry.task.id === plannerIdOfBlock(item.blockId))),
    busyInstants, (blockId) => releaseAt.get(plannerIdOfBlock(blockId))).kept;
  const pinned = frozen.map((item) => ({ taskId: plannerIdOfBlock(item.blockId), start: item.start, end: item.end }));
  const efficiency = personalEfficiency(ctx, now);
  const frozenBlocks = [...committed.filter((block) => block.day && block.id.startsWith("scheduled:"))
    .map((block) => ({ taskId: plannerIdOfBlock(block.id), start: iso(block.day!, block.start), end: iso(block.day!, block.end) })), ...pinned];
  // The day's work held to what the person actually does (docs/plans/closed-loop-1030.md §1): what their hours leave each day after the
  // calendar is the stated side, the measured cap the limit.
  const statedByDay = new Map<string, number>();
  for (const slot of instants) statedByDay.set(slot.day, (statedByDay.get(slot.day) ?? 0) + (Date.parse(String(slot.end)) - Date.parse(String(slot.start))) / 60_000);
  const dailyCaps = dailyCapsFor(ctx, today, statedByDay, frozenBlocks.map((block) => ({ start: Date.parse(block.start), end: Date.parse(block.end) })), now);
  const input: PlanningInput = { locale: localeFor(ctx),
    now,
    horizonDays: days.length,
    mode: preferences.mode, params: effectiveParams(ctx),
    ...(currentEnergy ? { currentEnergy, currentDay: today } : {}),
    tasks: expanded.map((item) => library.has(item.orderId)
      ? (({ deadline: _d, ...task }) => ({ ...task, deadlineTier: 3 as const, floorOnly: true }))(item.task) : item.task),
    ...(shares ? { lineShares: shares } : {}),
    ...(dayCapacity.multiplier < 1 ? { capacityByDay: { [today]: dayCapacity.multiplier } } : {}),
    ...(dailyCaps ? { dailyCapMinutes: dailyCaps } : {}),
    ...(efficiency ? { efficiency } : {}),
    availability: instants,
    ...(lookaheadAvailability ? { lookaheadAvailability } : {}),
    frozenBlocks
  };
  return { input, days, busy, preferences, zone, iso, now, currentEnergy, dayCapacity, clockBlockers, instants, capacityIds, allOrders, orders,
    stateById, dependencyBlockers, library, expanded, frozen, pinned };
}

/**
 * The cache key of this planning input: everything but `now`, with the slot the person is in and their self-reported energy standing
 * in for it (`scheduleInputHash`), so time passing inside a slot keeps the optimal plan and crossing into the next one solves again.
 */
export function scheduleHashOf(input: PlanningInput, instants: Array<{ start: string; end: string }>, currentEnergy?: string): string {
  const slot = instants.find((item) => Date.parse(item.end) > input.now.getTime());
  return scheduleInputHash(input, `${slot?.start ?? ""}|${currentEnergy ?? ""}`);
}

/**
 * The work orders, placed into the time the calendar has not already taken.
 *
 * This is the first production caller `planSchedule` has ever had. Until now the AI lane was seed
 * data — example blocks that looked like a schedule and were computed from nothing — because no part
 * of the app knew when the person was free. Reading demo data as a commitment is the mistake the rest
 * of this codebase works to prevent, so the examples are gone and this is what replaces them.
 */
async function scheduledBlocks(ctx: AccessContext, today: string, committed: PersistedScheduleBlock[]): Promise<{
  blocks: PersistedScheduleBlock[]; schedule: PersistedPlan["schedule"]
}> {
  const { input, days, busy, preferences, zone, iso, now, currentEnergy, clockBlockers, instants, capacityIds, allOrders, orders,
    stateById, dependencyBlockers, library, expanded, frozen, pinned } = planningInputFor(ctx, today, committed);
  // The page gets the greedy plan at once; the optimal one is solved in the background and used once cached (docs/loop-and-scout.md
  // §2). A preview neither reads nor asks for it: it must show what the change does to the plan the person has, at once.
  const greedy = await planSchedule(input, { solver: "none" });
  const hash = scheduleHashOf(input, instants, currentEnergy);
  const cached = inPreview() ? undefined : optimalFor(ctx, hash);
  if (!cached && !inPreview()) requestOptimal(ctx, input, hash);
  const result = cached ? { ...cached.result, plan: { blocks: cached.result.plan.blocks.filter((block) => Date.parse(block.end) > now.getTime()) } } : greedy;
  const placed = result.plan.blocks.filter((block) => !block.frozen);
  const orderStates = new Map(orders.map((order) => [order.id, order.state]));
  const itemById = new Map(expanded.map((item) => [item.task.id, item]));
  const intents = new Map(orders.map((order) => [order.id, taskTitleOf(order)]));
  const tentative = (taskId: string) => ["approved", "preparing"].includes(orderStates.get(taskId.split("#")[0]!) ?? "");
  const named = (taskId: string) => { const item = itemById.get(taskId); return { title: item?.title ?? taskId, task: intents.get(item?.orderId ?? "") ?? item?.title ?? taskId,
    ...(item?.step ? { step: item.step } : {}) }; };
  const energyNeeds = new Map(orders.map((order) => [order.id, humanCoreOf(order)?.energy]));
  // A new segment never takes an id a frozen block holds: the frozen one keeps its id and its time.
  const frozenIds = new Set(frozen.map((item) => item.blockId));
  const occurrences = new Map<string, number>();
  const nextIndex = (taskId: string) => {
    let index = (occurrences.get(taskId) ?? 0) + 1;
    while (frozenIds.has(scheduledBlockId(taskId, index))) index += 1;
    occurrences.set(taskId, index);
    return index;
  };
  const blocks = placed.map((block) => {
    const index = nextIndex(block.taskId);
    const blockDay = formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd");
    const needsRestCheck = currentEnergy === "low" && blockDay === today &&
      energyNeeds.get(block.taskId.split("#")[0]!) === "high" && Date.parse(block.start) > now.getTime();
    // 「精力偏低」: the slot has less energy than the work needs, so the block runs longer than the estimate (planner `efficiency`).
    // 「超出实测 · 可能来不及」 comes first: deadline work past the day's measured cap (closed-loop-1030, the owner's decision).
    const tag = block.overCapacity ? OVER_CAPACITY_TAG : block.progressOnly ? "本周未排完" : needsRestCheck ? "休息后复评" : block.efficiency ? "精力偏低"
      : library.has(block.taskId.split("#")[0]!) ? "按主线份额" : tentative(block.taskId) ? "暂定" : undefined;
    const slot = instants.find((item) => Date.parse(block.start) >= Date.parse(String(item.start)) && Date.parse(block.start) < Date.parse(String(item.end)));
    const need = itemById.get(block.taskId)?.task.energy;
    return {
    id: scheduledBlockId(block.taskId, index),
    lane: "human" as const,
    ...named(block.taskId), ...(tag ? { tag } : {}),
    ...(slot && need ? { energy: { slot: slot.energy, need, efficiency: block.efficiency ?? 1 } } : {}),
    day: blockDay,
    start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
    end: formatInTimeZone(new Date(block.end), zone, "HH:mm"),
    source: "排程",
    readOnly: true
  }; });
  // Second pass, the preview: where proposals still waiting for approval would go, placed only into the
  // time the approved work left free (the approved blocks are frozen for it), so a preview can never move
  // committed work. `proposed:` blocks are drawn dashed and are never published to any calendar.
  const proposals = withoutShadowingDemos(allOrders, capacityIds)
    .filter((order) => order.state === "awaiting_plan_approval" && !capacityIds.has(order.identityId)
      && !((plannerTaskOf(ctx, order).dependsOn ?? []).some((id) => stateById.get(id) !== "accepted" && !orders.some((item) => item.id === id))));
  const preview = proposals.length ? await planSchedule({
    now, horizonDays: days.length, mode: preferences.mode, params: effectiveParams(ctx),
    tasks: proposals.map((order) => plannerTaskOf(ctx, order)),
    availability: instants,
    frozenBlocks: [...committed.filter((block) => block.day && block.id.startsWith("scheduled:"))
      .map((block) => ({ taskId: plannerIdOfBlock(block.id), start: iso(block.day!, block.start), end: iso(block.day!, block.end) })),
      ...result.plan.blocks.map((block) => ({ taskId: block.taskId, start: block.start, end: block.end }))]
  }, { solver: "none" }).catch(() => undefined) : undefined;
  const proposalTitles = new Map(proposals.map((order) => [order.id, taskTitleOf(order)]));
  const previewSeen = new Map<string, number>();
  const previewBlocks = (preview?.plan.blocks ?? []).filter((block) => !block.frozen && proposalTitles.has(block.taskId)).map((block) => {
    const index = (previewSeen.get(block.taskId) ?? 0) + 1;
    previewSeen.set(block.taskId, index);
    return {
      id: `proposed:${block.taskId}${index > 1 ? `:${index}` : ""}`, lane: "human" as const,
      title: proposalTitles.get(block.taskId) ?? block.taskId, task: proposalTitles.get(block.taskId) ?? block.taskId, tag: "待批准",
      day: formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd"),
      start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
      end: formatInTimeZone(new Date(block.end), zone, "HH:mm"),
      source: "预览·待批准", readOnly: true
    };
  });
  blocks.push(...previewBlocks);
  // Frozen blocks, each under its own id at its own time: started or locked ones say so; kept ones read as ordinary scheduled blocks.
  for (const item of frozen) {
    const taskId = plannerIdOfBlock(item.blockId);
    const tag = item.reason === "pinned" || item.reason === "locked" ? "已锁定" : tentative(taskId) ? "暂定" : undefined;
    blocks.push({ id: item.blockId, lane: "human" as const, ...named(taskId), ...(tag ? { tag } : {}),
      day: formatInTimeZone(new Date(item.start), zone, "yyyy-MM-dd"), start: formatInTimeZone(new Date(item.start), zone, "HH:mm"),
      end: formatInTimeZone(new Date(item.end), zone, "HH:mm"), source: "排程", readOnly: true });
  }
  // Third pass, pencilled in: what found no room in the person's hours, placed between 07:00 and 23:00 outside them. Dashed, never
  // published, never counted as planned; starting one (`pinBlock`) makes it formal.
  const unplaced = new Set(result.blockers.map((blocker) => blocker.taskId));
  const leftovers = expanded.filter((item) => unplaced.has(item.task.id) && !frozen.some((entry) => plannerIdOfBlock(entry.blockId) === item.task.id));
  if (leftovers.length) {
    const offBusy = [...busy, ...blocks.filter((block) => block.day).map((block) => ({ day: block.day!, start: block.start, end: block.end }))];
    const offInstants = availableSlots(offHoursWindows(readAvailability(ctx)), days, offBusy).flatMap((slot) => {
      try { return [{ start: iso(slot.day, slot.start), end: iso(slot.day, slot.end), day: slot.day, energy: slot.energy }]; } catch { return []; }
    });
    const optional = offInstants.length ? await planSchedule({ now, horizonDays: days.length, mode: preferences.mode, params: effectiveParams(ctx),
      tasks: leftovers.map((item) => item.task), availability: offInstants,
      frozenBlocks: [...result.plan.blocks.map((block) => ({ taskId: block.taskId, start: block.start, end: block.end })), ...pinned]
    }, { solver: "none" }).catch(() => undefined) : undefined;
    const seen = new Map<string, number>();
    for (const block of (optional?.plan.blocks ?? []).filter((item) => !item.frozen && itemById.has(item.taskId))) {
      const index = (seen.get(block.taskId) ?? 0) + 1;
      seen.set(block.taskId, index);
      blocks.push({ id: scheduledBlockId(block.taskId, index).replace(/^scheduled:/, "optional:"), lane: "human" as const, ...named(block.taskId), tag: "预排",
        day: formatInTimeZone(new Date(block.start), zone, "yyyy-MM-dd"), start: formatInTimeZone(new Date(block.start), zone, "HH:mm"),
        end: formatInTimeZone(new Date(block.end), zone, "HH:mm"), source: "预排·非工作时段", readOnly: true });
    }
  }
  return { blocks, schedule: { status: clockBlockers.length || dependencyBlockers.length
    ? blocks.length ? "partial" : "infeasible" : result.status,
    blockers: [...result.blockers, ...clockBlockers, ...dependencyBlockers],
    solver: result.solver, ...(result.bufferRelaxed ? { bufferRelaxed: true } : {}),
    ...(result.notes?.length ? { notes: result.notes } : {}), ...(inPreview() ? {} : { inputHash: hash, optimal: Boolean(cached), ...(optimalSolveEnabled() ? {} : { simpleOnly: true }) }) } };
}

/**
 * The input-box events (`schedule.events`) on these days, as plan blocks, and the required events from mail (`mail.events` in state
 * `fixed`, 2026-11-11): busy time on Crossline's own plan only — they are not among the events any calendar path writes.
 */
export function personEventBlocks(ctx: AccessContext, days: string[]): PersistedScheduleBlock[] {
  let own: FixedEvent[] = [];
  try { own = JSON.parse(getStore().getSetting(ctx.workspaceId, FIXED_EVENTS) ?? "[]") as FixedEvent[]; } catch { /* none */ }
  const fromMail = mailEventsOnSchedule(readMailEvents(getStore().getSetting(ctx.workspaceId, MAIL_EVENTS_SETTING)));
  return fixedEventBlocks([...(Array.isArray(own) ? own : []), ...fromMail], days, localeFor(ctx));
}

/**
 * The calendar's blocks are stored; the scheduled ones are derived on read. Persisting a schedule would mean the plan disagreed with
 * the work orders the moment one of them moved. The person's own fixed events (typed into the input box) are busy time too, derived
 * on read like the schedule itself. A cancelled meeting still on the calendar (imported before cancellations were dropped) holds no time.
 */
export function committedBlocks(ctx: AccessContext, payload: unknown): PersistedScheduleBlock[] {
  const marks = calendarMarks(ctx);
  const blocks = [...((payload as { blocks?: PersistedScheduleBlock[] }).blocks ?? []).filter((block) => !(block.id.startsWith("graph_calendar:") && isCancelledEvent(marks, block.title))),
    ...personEventBlocks(ctx, planDays(planToday(ctx)))];
  // Getting to an event at a physical place, and back, is busy time too (「路上」, `travelBlocks`).
  return [...blocks, ...travelBlocks(blocks, travelStateOf(ctx), localeFor(ctx))];
}

/** The person's travel settings, places and map estimates (`readTravelState`). */
export const travelStateOf = (ctx: AccessContext) => readTravelState((key) => getStore().getSetting(ctx.workspaceId, key));

/**
 * The energy question's value-of-information gate (docs/energy-and-ecosystem.md §6): would the answer change what the person does in
 * the next three hours? The greedy plan is made twice, with the current slot's energy as if they had said 「低」 and 「高」, and the
 * question is worth asking only when the two heads differ (`planHeadDiffers`). Cached per schedule epoch (`scheduleHashOf`: the input,
 * the slot the person is in, their reported energy), so the two-minute nudge pass solves at most twice per slot and input.
 */
export const ENERGY_VOI_SETTING = "energy.voi";
export async function energyAnswerMatters(ctx: AccessContext): Promise<boolean> {
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  if (!stored) return false;
  const today = planToday(ctx);
  const committed = committedBlocks(ctx, stored.payload);
  const { input, instants, currentEnergy } = planningInputFor(ctx, today, committed);
  const hash = scheduleHashOf(input, instants, currentEnergy);
  try {
    const cached = JSON.parse(store.getSetting(ctx.workspaceId, ENERGY_VOI_SETTING) ?? "null") as { hash?: string; differs?: boolean } | null;
    if (cached?.hash === hash && typeof cached.differs === "boolean") return cached.differs;
  } catch { /* computed afresh */ }
  const headAt = async (level: "low" | "high") => (await planSchedule(withPreview({ currentEnergy: level }, () => planningInputFor(ctx, today, committed)).input,
    { solver: "none" })).plan.blocks;
  const [low, high] = [await headAt("low"), await headAt("high")];
  const differs = planHeadDiffers(low, high, input.now);
  store.setSetting(ctx.workspaceId, ENERGY_VOI_SETTING, JSON.stringify({ hash, differs }));
  return differs;
}

export async function loadCurrentPlan(ctx: AccessContext): Promise<PersistedPlan> {
  // Reused until the ledger changes or a minute passes (`lib/ledger-memo.ts`); a preview always computes its own.
  if (inPreview()) return computeCurrentPlan(ctx);
  return memoByLedgerAsync(getStore(), `plan:${ctx.workspaceId}:${localeFor(ctx)}:${appNow().toISOString().slice(0, 16)}`, 60_000, () => computeCurrentPlan(ctx));
}

async function computeCurrentPlan(ctx: AccessContext): Promise<PersistedPlan> {
  ensureSeeded(ctx);
  const store = getStore();
  const stored = store.listPlanVersions(ctx.workspaceId)[0];
  if (!stored) throw new Error("PLAN_VERSION_NOT_FOUND");
  const committed = committedBlocks(ctx, stored.payload);
  // A real, computed preview beats an empty page: the scheduler runs against sane defaults even before
  // the person has saved their own time zone, availability and mode. `usingDefaultPreferences` is what
  // lets the page say so, instead of either lying about it or blocking on it.
  const suggested = await scheduledBlocks(ctx, planToday(ctx), committed);
  if (!inPreview()) noteScheduleChanges(ctx, committed, suggested.blocks, appNow());
  return {
    id: stored.id,
    version: stored.version,
    blocks: [...committed, ...suggested.blocks],
    schedule: suggested.schedule,
    usingDefaultPreferences: effectiveSchedulePreferences(ctx).isDefault
  };
}
/**
 * The calendar classifier's marks by title (`rest`, `cancelled`; 2026-11-22), read from the stored filing whatever lines it was made
 * against: unlike a line, a mark does not go stale when the lines change.
 */
export function calendarMarks(ctx: AccessContext): CalendarLines | null {
  return memoByLedger(getStore(), `calendar-marks:${ctx.workspaceId}`, 5_000, () => {
    try { return JSON.parse(getStore().getSetting(ctx.workspaceId, CALENDAR_LINES) ?? "null") as CalendarLines | null; } catch { return null; }
  });
}
