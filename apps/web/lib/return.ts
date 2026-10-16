import "server-only";
import { taskTitleOf, type AccessContext, type ProgressLevelId } from "@crossline/core";
import { listAgentTasks } from "@crossline/db";
import { archiveWorkOrder, completeWorkOrderExecution, effectiveSchedulePreferences, getStore, planToday, startWorkOrderExecution, toZonedInstant } from "./crossline";
import { rejectMilestoneDrafts } from "./approvals";
import { readScheduledDay } from "./schedule-memory";
import { lineLabels } from "./lines";
import { seenBlocksKey } from "./nudges";
import { applyProgressLevel } from "./progress-check";
import type { PageContext } from "./conversation";
import { tOf } from "./locale";

/**
 * Coming back (docs/review-2026-10-13.md §6.3, the person's decision): after days away the first thing shown is what happened meanwhile
 * and the work that was due, each settled in one tap — 完成 / 做了一部分 / 没做顺延 / 不做了 — beside the input box for anything else;
 * proposals and drafts nobody touched for fourteen days are archived (recoverable). Before this, coming back meant a wall of 85 open
 * decisions, which made coming back cost more than staying away.
 */
export const RETURN_AFTER_HOURS = 48;
export const STALE_DAYS = 14;
/** The absence (its start) the person chose to skip the return page for. */
export const RETURN_DISMISSED = "return.dismissed";

const DAY = 86_400_000;
const OPEN = ["approved", "preparing", "ready_for_human", "active"];

/**
 * When the person's absence began and when it ended, if the return page is due: they have been away over two days, or they came back
 * within the last week and the work of that absence is not all settled yet — answering something elsewhere first (the interview, a
 * goal) must not make the page and its list disappear. Skipping it (`return.dismissed`) closes that absence.
 */
export function returnDue(ctx: AccessContext, now: Date): { since: string; until?: string } | undefined {
  const store = getStore();
  const latest = store.lastPersonActivity(ctx.workspaceId);
  // Someone who never did anything yet is new, not back.
  if (!latest) return undefined;
  const away = RETURN_AFTER_HOURS * 3_600_000;
  const dismissed = store.getSetting(ctx.workspaceId, RETURN_DISMISSED);
  if (now.getTime() - Date.parse(latest) > away) return dismissed === latest ? undefined : { since: latest };
  const times = store.personActivityTimes(ctx.workspaceId, new Date(now.getTime() - 14 * DAY).toISOString());
  for (let index = times.length - 1; index > 0; index -= 1) {
    if (Date.parse(times[index]!) - Date.parse(times[index - 1]!) <= away) continue;
    const absence = { since: times[index - 1]!, until: times[index]! };
    if (dismissed === absence.since || now.getTime() - Date.parse(absence.until) > 7 * DAY) return undefined;
    return returnView(ctx, absence.since, now, absence.until).items.length ? absence : undefined;
  }
  return undefined;
}

/**
 * One thing to settle: a task's step that had a time while the person was away (`key` = `<order>#<step>`), or — for work with no step
 * plan, or none of the person's own left — the task itself (`stepId` ""). `steps` is the task's whole list of the person's steps, in the
 * plan's order, so 「做了一部分」 ticks against the same list the task shows. `lastStep`: finishing this finishes the task.
 */
export type ReturnItem = { key: string; orderId: string; stepId: string; title: string; step: string; line: string; lineLabel: string;
  plannedDays: string[]; dueDay: string; p50Minutes: number; lastStep: boolean; steps: Array<{ id: string; title: string; done: boolean }> };
export type ReturnView = {
  /** `sinceDay` is the day of the last own action in the person's zone; `daysAway` is whole days, 0 when under one. */
  since: string; sinceDay: string; daysAway: number; hoursAway: number; items: ReturnItem[];
  /** When the absence ended, for one the person already came back from (the page reads its items again by `since` and this). */
  until?: string;
  happened: { assistantDone: number; proposals: number; calendarChanges: number; deadlinesSoon: Array<{ title: string; deadline: string }> };
  stale: { orders: Array<{ id: string; title: string }>; milestones: Array<{ id: string; title: string }> };
};

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

type SeenBlock = { orderId: string; stepId: string; day: string; start: string; end: string; began?: boolean };
function seenBlocks(ctx: AccessContext, day: string): SeenBlock[] {
  try { return Object.values(JSON.parse(getStore().getSetting(ctx.workspaceId, seenBlocksKey(day)) ?? "{}") as Record<string, SeenBlock>); } catch { return []; }
}

/** When a step's block began, the first time it was seen under way in the last two weeks, as an instant; undefined when never seen. */
function stepBlockStart(ctx: AccessContext, orderId: string, stepId: string, now: Date): string | undefined {
  const today = planToday(ctx, now);
  for (let back = 14; back >= 0; back -= 1) {
    const day = addDays(today, -back);
    const block = seenBlocks(ctx, day).filter((item) => item.began && item.orderId === orderId && item.stepId === stepId).sort((a, b) => a.start.localeCompare(b.start))[0];
    if (block) try { return toZonedInstant(block.day || day, block.start, effectiveSchedulePreferences(ctx).preferences.timeZone); } catch { return undefined; }
  }
  return undefined;
}

/** Proposals and drafts untouched for fourteen days: a task proposal waiting since then, a milestone draft proposed since then and never edited. */
function staleItems(ctx: AccessContext, now: Date): ReturnView["stale"] {
  const store = getStore();
  const cutoff = new Date(now.getTime() - STALE_DAYS * DAY).toISOString();
  const lastAt = (type: string) => {
    const out = new Map<string, string>();
    for (const event of store.listEvents(ctx.workspaceId, { type })) if ((out.get(event.entityId) ?? "") < event.createdAt) out.set(event.entityId, event.createdAt);
    return out;
  };
  const transitioned = lastAt("work_order.transitioned"), proposed = lastAt("milestone.proposed"), revised = lastAt("milestone.revised");
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval"
    && (transitioned.get(order.id) ?? "") !== "" && transitioned.get(order.id)! <= cutoff)
    .map((order) => ({ id: order.id, title: taskTitleOf(order) }));
  const milestones = store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "draft" && !revised.has(milestone.id)
    && (proposed.get(milestone.id) ?? "") !== "" && proposed.get(milestone.id)! <= cutoff)
    .map((milestone) => ({ id: milestone.id, title: milestone.title }));
  return { orders, milestones };
}

export function returnView(ctx: AccessContext, since: string, now: Date, until?: string): ReturnView {
  const store = getStore();
  const today = planToday(ctx, now);
  const from = planToday(ctx, new Date(since));
  // Once back, the days after the return are ordinary days, not the absence.
  const end = until ? planToday(ctx, new Date(until)) : today;
  // The days the person was away, as the attention timer recorded each day's planned work (the schedule itself keeps no past).
  const planned = new Map<string, string[]>();
  for (let day = from; day < end; day = addDays(day, 1))
    for (const orderId of Object.keys(readScheduledDay(ctx, day))) planned.set(orderId, [...(planned.get(orderId) ?? []), day]);
  // Which step each block was for, as the two-minute pass saw it under way (`nudge.blocks:<day>`): what really had a time, by step.
  const stepDays = new Map<string, string[]>();
  for (let day = from; day < end; day = addDays(day, 1))
    for (const block of seenBlocks(ctx, day)) if (block.began && block.stepId) {
      const key = `${block.orderId}#${block.stepId}`;
      if (!(stepDays.get(key) ?? []).includes(day)) stepDays.set(key, [...(stepDays.get(key) ?? []), day]);
    }
  const labels = lineLabels(ctx);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  // An answer settles its step; one recorded before answers named a step settles the whole task.
  const answers = store.listEvents(ctx.workspaceId, { type: "return.answered" }).filter((event) => event.createdAt >= since)
    .map((event) => ({ orderId: event.entityId, stepId: (event.payload as { stepId?: string }).stepId ?? "" }));
  const answeredOrders = new Set(answers.filter((answer) => !answer.stepId).map((answer) => answer.orderId));
  const answeredSteps = new Set(answers.filter((answer) => answer.stepId).map((answer) => `${answer.orderId}#${answer.stepId}`));
  const items = store.listWorkOrders(ctx.workspaceId).flatMap((order): ReturnItem[] => {
    if (!OPEN.includes(order.state) || order.tombstone || answeredOrders.has(order.id) || (order.payload as { seeded?: boolean }).seeded) return [];
    const dueDay = (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "";
    const plannedDays = planned.get(order.id) ?? [];
    const all = store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? [];
    const own = all.filter((step) => step.executor !== "agent" && step.status !== "skipped");
    const steps = own.map((step) => ({ id: step.id, title: step.title, done: step.status === "done" }));
    const base = { orderId: order.id, title: taskTitleOf(order), line: order.identityId, lineLabel: labels[order.identityId] ?? order.identityId, dueDay, steps };
    const itemOf = (step: (typeof own)[number] | undefined, days: string[]): ReturnItem => ({ ...base, key: step ? `${order.id}#${step.id}` : order.id,
      stepId: step?.id ?? "", step: step?.title ?? "", plannedDays: days, p50Minutes: step?.estimate.p50Minutes ?? order.estimate.p50Minutes,
      lastStep: !step || all.every((other) => other.id === step.id || other.status === "done" || other.status === "skipped") });
    const open = own.filter((step) => step.status !== "done" && !answeredSteps.has(`${order.id}#${step.id}`));
    const placed = open.filter((step) => stepDays.has(`${order.id}#${step.id}`)).map((step) => itemOf(step, stepDays.get(`${order.id}#${step.id}`)!));
    if (placed.length) return placed;
    // Its steps' blocks were seen and are all settled: nothing else of it had a time.
    if (all.some((step) => stepDays.has(`${order.id}#${step.id}`)) && !(dueDay && dueDay < today)) return [];
    // Work that had a time while they were away (days before steps were recorded), or whose due day passed: its current step, or the
    // task when it has none of the person's.
    if (!plannedDays.length && !(dueDay && dueDay < today)) return [];
    if (own.length && !open.length) return own.some((step) => step.status !== "done") ? [] : [itemOf(undefined, plannedDays)];
    return [itemOf(open[0], plannedDays)];
  }).sort((a, b) => (a.dueDay || "9999").localeCompare(b.dueDay || "9999") || (a.plannedDays[0] ?? "9999").localeCompare(b.plannedDays[0] ?? "9999"));
  const approvedDeadlines = store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "approved")
    .flatMap((milestone) => { const deadline = anchors.get(milestone.id); return deadline && deadline >= today && deadline <= addDays(today, 7) ? [{ title: milestone.title, deadline }] : []; })
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  const finishedAt = (task: { requestedAt: string; durationMs: number }) => new Date(Date.parse(task.requestedAt) + task.durationMs).toISOString();
  return {
    since, ...(until ? { until } : {}), sinceDay: from, daysAway: Math.round(((until ? Date.parse(until) : now.getTime()) - Date.parse(since)) / DAY),
    hoursAway: Math.floor(((until ? Date.parse(until) : now.getTime()) - Date.parse(since)) / 3_600_000), items,
    happened: {
      assistantDone: listAgentTasks(store, ctx.workspaceId).filter((task) => ["needs_review", "accepted"].includes(task.status) && finishedAt(task) >= since).length,
      proposals: store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval").length,
      calendarChanges: store.listEvents(ctx.workspaceId, { type: "plan.reality_changed" }).filter((event) => event.createdAt >= since).length,
      deadlinesSoon: approvedDeadlines
    },
    stale: staleItems(ctx, now)
  };
}

/** Archives what nobody touched for fourteen days (recoverable from 已丢弃 and the milestone archive); returns what it archived. */
export function cleanStale(ctx: AccessContext, now: Date): { ok: true; orders: string[]; milestones: string[] } {
  const stale = staleItems(ctx, now);
  const orders = stale.orders.filter((order) => archiveWorkOrder(ctx, order.id, tOf(ctx)("超过 {{count}} 天无人处理，回来时自动归档", { count: STALE_DAYS }), { bySystem: true }).ok).map((order) => order.id);
  const milestones = stale.milestones.length ? rejectMilestoneDrafts(ctx, stale.milestones.map((milestone) => milestone.id)).approved : [];
  return { ok: true, orders, milestones };
}

export type ReturnVerdict = "done" | "partial" | "rolled" | "dropped";

/**
 * One tap on one step (`detail.stepId`) or task. 完成 marks the step done — with how long it took as a session over the step's own block,
 * when said and the block is known — and, on the task's last step (or a task with no steps), hands the task in the way the completion
 * check does; 做了一部分 marks the ticked steps done and records how far (`level`); 没做顺延 leaves it to the scheduler; 不做了 discards the task.
 */
export function answerReturn(ctx: AccessContext, orderId: string, verdict: ReturnVerdict,
  detail: { minutes?: number; stepIds?: string[]; stepId?: string; level?: ProgressLevelId; note?: string } = {}, now = new Date()):
  { ok: true } | { ok: false; code: string } {
  const store = getStore();
  let unclear = false;
  const order = store.getWorkOrder(ctx.workspaceId, orderId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  const plan = store.getStepPlan(ctx.workspaceId, orderId);
  const stepId = detail.stepId && plan?.steps.some((step) => step.id === detail.stepId) ? detail.stepId : "";
  const attempt = store.listEvents(ctx.workspaceId, { type: "return.answered", entityId: orderId }).length;
  if (verdict === "done") {
    const minutes = detail.minutes && detail.minutes > 0 ? Math.round(detail.minutes) : undefined;
    const last = !stepId || plan!.steps.every((step) => step.id === stepId || step.status === "done" || step.status === "skipped");
    if (!last) {
      const startedAt = minutes ? stepBlockStart(ctx, orderId, stepId, now) : undefined;
      if (minutes && startedAt) store.recordConfirmedSession(ctx.workspaceId, orderId, ctx.principalId, { startedAt,
        endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), minutes, source: "one_tap", key: `return-session:${orderId}:${stepId}:${attempt}` });
    } else if (!["evidence_review", "accepted"].includes(order.state)) {
      if (order.state !== "active") { const started = startWorkOrderExecution(ctx, orderId, now.toISOString()); if (!started.ok) return started; }
      const done = completeWorkOrderExecution(ctx, orderId, [], [], now.toISOString(), minutes ? { minutes, source: "one_tap" } : undefined);
      if (!done.ok) return done;
    }
    if (stepId) store.updateStepProgress(ctx.workspaceId, orderId, stepId, { status: "done" }, ctx.principalId, "return");
  } else if (verdict === "partial") {
    // How far, as the person says it (the owner's decision of 2026-10-15): steps ticked done, a level (只开了个头 / 做了一半左右 / 做了一大半
    // = 1/4, 2/4, 3/4 of this step — the task's current open step when the item is the task), and words, which the page sends to the box
    // as a turn of its own. Nothing at all is accepted too, and the 小帮手 asks 「做到哪了」 later (`lib/progress-check.ts`).
    const steps = new Set(plan?.steps.map((step) => step.id) ?? []);
    const ticked = (detail.stepIds ?? []).filter((id) => steps.has(id));
    for (const id of ticked) store.updateStepProgress(ctx.workspaceId, orderId, id, { status: "done" }, ctx.principalId, "person");
    const target = stepId || plan?.steps.find((step) => step.executor !== "agent" && step.status === "planned")?.id || "";
    if (detail.level && !ticked.includes(target)) applyProgressLevel(ctx, orderId, target, detail.level);
    unclear = !ticked.length && !detail.level && !detail.note?.trim();
  } else if (verdict === "dropped") {
    const archived = archiveWorkOrder(ctx, orderId, tOf(ctx)("回来时标为不做了"));
    if (!archived.ok) return archived;
  }
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `return.answered:${orderId}:${attempt}`, type: "return.answered",
    entityId: orderId, payload: { verdict, ...(stepId ? { stepId } : {}), ...(detail.minutes ? { minutes: detail.minutes } : {}),
      ...(detail.stepIds?.length ? { stepIds: detail.stepIds } : {}), ...(verdict === "partial" && detail.level ? { level: detail.level } : {}),
      ...(verdict === "partial" && detail.note?.trim() ? { note: detail.note.trim().slice(0, 300) } : {}), ...(unclear ? { unclear: true } : {}) } });
  return { ok: true };
}

/** The open items of the absence the return page is for (the page's own list, read again after an answer or a carried-out card). */
export function returnItems(ctx: AccessContext, since: string, now: Date, until?: string): ReturnItem[] {
  return returnView(ctx, since, now, until).items;
}

/**
 * What a line typed on the return page carries into the box's snapshot: the absence's open steps by id, which one a line typed beside
 * an item is about (`entityId` = `<order>#<step>`, or the order alone), and how each answer maps onto the box's own actions — so the
 * person can say it in their own words and still confirm a card, rather than only pick a fixed option.
 */
// i18n-ignore-start: the page's lines are the concierge model's context, not interface
export function returnPageLines(ctx: AccessContext, page: PageContext, now: Date): string[] {
  const store = getStore();
  const due = returnDue(ctx, now);
  const items = due ? returnView(ctx, due.since, now, due.until).items : [];
  const out = ["本页：回来后确认离开期间的进展。",
    ...(items.length ? ["离开期间排了时间或到了截止、尚未确认的步骤（任务 id | 步骤 id | 任务 · 步骤 | 排在 | 截止）：",
      ...items.slice(0, 30).map((item) => `- ${item.orderId} | ${item.stepId || "—"} | ${item.title}${item.step ? ` · ${item.step}` : ""} | ${item.plannedDays.join("、") || "—"} | ${item.dueDay || "—"}`)] : [])];
  const [orderId, stepId = ""] = page.entityId.split("#");
  const order = orderId ? store.getWorkOrder(ctx.workspaceId, orderId) : undefined;
  if (order) {
    const steps = store.getStepPlan(ctx.workspaceId, order.id)?.steps ?? [];
    const step = steps.find((item) => item.id === stepId);
    out.push(`本人这句话说的是任务 ${order.id}「${taskTitleOf(order)}」${step ? `的步骤 ${step.id}「${step.title}」` : ""}；该任务的步骤（id | 标题 | 状态）：${steps
      .filter((item) => item.status !== "skipped").map((item) => `${item.id} | ${item.title} | ${item.status}${item.executor === "agent" ? "（助手做）" : ""}`).join("；") || "无"}`);
  }
  out.push("说到做完了，用 task.op step_done 并填任务 id 与步骤 id；只做了一部分，用 task.op progress 记下做到哪；没做、往后放用 task.op defer；不做了用 task.op archive。一句话涉及几步就逐一提出动作，由本人确认后执行。");
  return out;
}
// i18n-ignore-end

/** 「先跳过」: the return page is not shown again for this absence. */
export function dismissReturn(ctx: AccessContext, since: string): { ok: true } {
  getStore().setSetting(ctx.workspaceId, RETURN_DISMISSED, since);
  return { ok: true };
}
