import "server-only";
import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { listAgentTasks, type StoredConversationMessage } from "@crossline/db";
import {
  availableSlots, calendarLineOf, isCancelledEvent, onPersonsBoard, planNudges, preparesOf, taskTitleOf,
  type AccessContext, type NotifyLevelName, type NudgeBlock, type NudgeEnding, type NudgeButton, type NudgeKind, type NudgeSlack, type PlannedNudge, type ProposedAction
} from "@crossline/core";
import { commitSoon, effectiveSchedulePreferences, energyAnswerMatters, getStore, loadCurrentPlan, planToday, readAvailability } from "./crossline";
import { listed, openAsks, thisWeek } from "./asks";
import { calendarFiling, currentWorkState, missedItems } from "./timeline";
import { dayLabel, type OpenerView } from "./opener";
import { interviewStatus } from "./interview-status";
import { preparingProposalIds } from "./proposal-ready";
import { energyModel } from "./energy";
import { loadWrap } from "./wrap";
import { outcomeNudgeInputs } from "./outcome-check";
import { progressNudgeInputs } from "./progress-check";
import { systemContext } from "./auto-publish";
import type { Card } from "./conversation";
import { localeFor } from "./locale";
import { monthDay, tFor, type Locale } from "./i18n";
import { yieldToRequests } from "./yield";

/** How often the engine looks (docs/one-input.md §4): often enough that 「15 分钟后开始」 is said on time. */
export const NUDGE_INTERVAL_MS = 2 * 60_000;
/** When a page was last visible: within this, a nudge is shown on the page; beyond it, the worker sends it to the desktop and phone. */
export const PRESENCE_SETTING = "presence.visibleAt";
export const PRESENCE_FRESH_MS = 10 * 60_000;
/** The last time the person typed or answered something: a while after, only the urgent interrupts. */
export const ANSWERED_SETTING = "conversation.lastAnsweredAt";
const ANSWERED_QUIET_MS = 20 * 60_000;
const muteKey = (kind: string) => `nudge.mute.${kind}`;
const DAY = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const minutesOf = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

export type NudgePayload = { kind: NudgeKind | "opener"; fingerprint: string; covers?: string[]; counted: boolean; urgent: boolean; delivery: "page" | "pending" | "pushed";
  /** `block_confirm`: the block as it stood when asked; the confirm page writes against these times. */
  block?: NudgeEnding;
  /** `timer_overrun`: the step that ran over, read by the worker's adaptive granularity. */
  step?: { orderId: string; stepId: string } };

/** Runs the engine for every workspace (the web's timer). A workspace that fails is skipped until the next interval. */
export async function nudgePass(now = new Date()): Promise<number> {
  const store = getStore();
  let said = 0;
  for (const workspace of store.listWorkspaces()) {
    const ownerId = store.getWorkspaceOwnerId(workspace.id);
    if (!ownerId) continue;
    const ctx = systemContext(workspace.id, ownerId, now);
    // Synchronous work per account: requests are answered between accounts and steps (lib/yield.ts).
    await yieldToRequests();
    try { said += (await nudgesFor(ctx, now)).length; } catch { /* next interval */ }
    await yieldToRequests();
    // The person's life on the same clock: reminders due, errands prepared, travel times from the map (`lib/life.ts`).
    try { await (await import("./life")).lifePass(ctx, now); } catch { /* next interval */ }
  }
  return said;
}

/** Reads the account, decides (`planNudges`, rules only) and writes what is to be said into the day's conversation. */
export async function nudgesFor(ctx: AccessContext, now = new Date()): Promise<PlannedNudge[]> {
  const store = getStore();
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx, now);
  const clock = formatInTimeZone(now, zone, "HH:mm");
  const local = (iso: string) => formatInTimeZone(new Date(iso), zone, "yyyy-MM-dd'T'HH:mm");
  const level = (store.getSetting(ctx.workspaceId, "notify.level") as NotifyLevelName | undefined) ?? "normal";
  const recent = store.listRecentNudges(ctx.workspaceId, new Date(now.getTime() - 3 * DAY).toISOString());
  const payloadOf = (message: StoredConversationMessage) => message.payload.nudge as NudgePayload | undefined;
  const muted = mutedKinds(ctx, recent, today, now);
  const all = store.listWorkOrders(ctx.workspaceId);
  // Only the person's own work is reminded about (docs/work-split.md): the assistant's preparation and the questions to the person are
  // neither started, nor confirmed, nor late in the person's day.
  const orders = all.filter((order) => !(order.payload as { seeded?: boolean }).seeded && onPersonsBoard(order));
  const servedBy = new Map(all.filter((order) => preparesOf(order)).map((order) => [order.id, preparesOf(order)]));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const dueOf = (order: (typeof orders)[number]) => (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "";
  const executions = store.listExecutions(ctx.workspaceId);
  // When each order's timer was last stopped today: a block whose timer the person ended is not asked about afterwards.
  const lastStopped = new Map<string, string>();
  for (const execution of executions) if (execution.endedAt && local(execution.endedAt).slice(0, 10) === today
    && (lastStopped.get(execution.workOrderId) ?? "") < local(execution.endedAt)) lastStopped.set(execution.workOrderId, local(execution.endedAt));
  const running = executions.find((execution) => !execution.endedAt && !execution.interruptions.some((pause) => !pause.resumedAt));
  const plan = await loadCurrentPlan(ctx);
  // This pass runs every two minutes, so it is also what closes the commit window on blocks about to start.
  commitSoon(ctx, plan.blocks, now);
  const todays = plan.blocks.filter((block) => (block.day ?? today) === today);
  const scheduled = plan.blocks.filter((block) => block.id.startsWith("scheduled:") && block.day && block.day >= today);
  const byId = new Map(orders.map((order) => [order.id, order]));
  const nowMinute = minutesOf(clock);
  // What the assistant has ready per task (its accepted results and preparation in review), named when the block comes up.
  const readyFiles = new Map<string, string[]>();
  for (const task of listAgentTasks(store, ctx.workspaceId).filter((item) => item.status === "accepted" || item.status === "needs_review")) {
    const orderId = servedBy.get(task.workOrderId) ?? task.workOrderId;
    readyFiles.set(orderId, [...(readyFiles.get(orderId) ?? []), ...task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1) ?? artifact.path)]);
  }

  const blocks: NudgeBlock[] = todays.filter((block) => block.id.startsWith("scheduled:")).flatMap((block) => {
    const order = byId.get(block.id.split(":")[1]!);
    const due = order ? dueOf(order) : "";
    if (!order || !due || due < today || due > addDays(today, 7)) return [];
    const stepId = /^v\d+s\d+$/.test(block.id.split(":")[2] ?? "") ? block.id.split(":")[2]! : "";
    const prepared = readyFiles.get(order.id);
    const firstAction = stepId ? store.getStepPlan(ctx.workspaceId, order.id)?.steps.find((step) => step.id === stepId)?.firstAction : undefined;
    return [{ id: block.id, orderId: order.id, stepId, title: taskTitleOf(order), step: block.step ?? "", start: block.start, end: block.end, dueDay: due,
      ...(prepared?.length ? { prepared } : {}), ...(firstAction ? { firstAction } : {}) }];
  });
  // Every work block of today, deadline or not, for the completion check.
  const ending = rememberBlocks(ctx, today, clock, todays.filter((block) => block.id.startsWith("scheduled:")).flatMap((block) => {
    const order = byId.get(block.id.split(":")[1]!);
    if (!order) return [];
    const stepId = /^v\d+s\d+$/.test(block.id.split(":")[2] ?? "") ? block.id.split(":")[2]! : "";
    return [{ id: block.id, orderId: order.id, stepId, title: taskTitleOf(order), step: block.step ?? "", day: today, start: block.start, end: block.end, endedTimerAt: "",
      ...(block.energy ? { energy: block.energy } : {}) }];
  })).filter((block) => byId.has(block.orderId)).map((block) => {
    const due = dueOf(byId.get(block.orderId)!);
    return { ...block, endedTimerAt: lastStopped.get(block.orderId)?.slice(11, 16) ?? "", ...(due ? { dueDay: due } : {}) };
  });
  // The evening wrap-up (docs/rituals.md): with available hours today, blocks not due by tomorrow wait for it instead of a push each.
  const wrapView = loadWrap(ctx, now);
  const wrap = wrapView.at ? { at: wrapView.at, open: wrapView.open, done: wrapView.done } : undefined;

  // Time left before each due day: the person's free hours (fixed arrangements out, today from now on) less what other work holds.
  const windows = readAvailability(ctx);
  const fixed = plan.blocks.filter((block) => block.day && !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && !block.id.startsWith("optional:")
    && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title))).map((block) => ({ day: block.day!, start: block.start, end: block.end }));
  const slack: NudgeSlack[] = orders.filter((order) => ["approved", "preparing", "ready_for_human", "active"].includes(order.state)).flatMap((order) => {
    const due = dueOf(order);
    if (!due || due <= today || due > addDays(today, 14)) return [];
    const days = Array.from({ length: Math.max(1, Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY)) }, (_, index) => addDays(today, index));
    const span = (day: string, start: string, end: string) => Math.max(0, minutesOf(end) - Math.max(minutesOf(start), day === today ? nowMinute : 0));
    const free = availableSlots(windows, days, fixed).reduce((sum, slot) => sum + span(slot.day, slot.start, slot.end), 0);
    const others = scheduled.filter((block) => block.day! < due && block.id.split(":")[1] !== order.id).reduce((sum, block) => sum + span(block.day!, block.start, block.end), 0);
    const steps = store.getStepPlan(ctx.workspaceId, order.id)?.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
    const remaining = steps?.length ? steps.reduce((sum, step) => sum + step.estimate.p85Minutes, 0) : order.estimate.p85Minutes;
    const daily = Math.max(120, Math.round(availableSlots(windows, days, []).reduce((sum, slot) => sum + minutesOf(slot.end) - minutesOf(slot.start), 0) / days.length));
    return [{ orderId: order.id, title: taskTitleOf(order), dueDay: due, remainingMinutes: remaining, freeMinutes: Math.max(0, free - others), dailyMinutes: daily }];
  });

  const timerOrder = running ? byId.get(running.workOrderId) : undefined;
  const currentStep = timerOrder ? store.getStepPlan(ctx.workspaceId, timerOrder.id)?.steps.find((step) => step.status === "planned") : undefined;
  const finished = backgroundDone(ctx, now, locale);
  const meeting = todays.some((block) => block.id.startsWith("graph_calendar:") && !isCancelledEvent(block.title)
    && minutesOf(block.start) <= nowMinute && nowMinute < minutesOf(block.end));
  const answeredAt = store.getSetting(ctx.workspaceId, ANSWERED_SETTING);
  // The energy question: the next three hours hold work, the model is unsure about now, the last word on it is over three hours old,
  // and the answer would change what happens in those three hours (「低」 and 「高」 give different plans; checked last, it plans twice).
  const model = energyModel(ctx, windows);
  const nextWork = todays.filter((block) => block.id.startsWith("scheduled:") && minutesOf(block.start) > nowMinute && minutesOf(block.start) <= nowMinute + 180)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  const stale = !model.lastReportAt || now.getTime() - Date.parse(model.lastReportAt) > 3 * 3_600_000;
  const prediction = model.predict(now.toISOString());
  const energyCheck = nextWork && stale && prediction.confidence === "low" && !muted.has("energy_check") && await energyAnswerMatters(ctx)
    ? { nextBlock: t("{{time}}「{{title}}」", { time: nextWork.start, title: nextWork.task ?? nextWork.title }),
      why: t("回答后，今天剩下和之后的时段会按精力重新安排。") } : undefined;
  const planned = planNudges({
    now: now.toISOString(), today, clock, tomorrow: addDays(today, 1), level, muted, locale,
    quiet: { timerRunning: Boolean(running), inMeeting: meeting, answeredRecently: Boolean(answeredAt) && now.getTime() - Date.parse(answeredAt!) < ANSWERED_QUIET_MS,
      // Focused by the screen record (its detail consent only): only the urgent interrupts. Away is the worker's to act on (phone only).
      focused: currentWorkState(ctx, plan)?.state === "focused" },
    night: clock < "08:00" || clock >= "23:00",
    sent: new Set(recent.flatMap((message) => [payloadOf(message)?.fingerprint ?? "", ...(payloadOf(message)?.covers ?? [])])),
    countedToday: recent.filter((message) => payloadOf(message)?.counted && message.createdAt.slice(0, 10) >= addDays(today, -1)
      && local(message.createdAt).slice(0, 10) === today).length,
    blocks, ending, slack, finished, ...(energyCheck ? { energyCheck } : {}), ...(wrap ? { wrap } : {}),
    // Finished work whose result is not known yet: asked at an idle moment (completion.ts).
    outcomes: outcomeNudgeInputs(ctx, now),
    // A step the person said they did part of while away, without saying how far (the return page).
    progressChecks: progressNudgeInputs(ctx, now),
    ...(running && timerOrder ? { timer: { orderId: timerOrder.id, title: taskTitleOf(timerOrder), stepId: currentStep?.id ?? "", stepTitle: currentStep?.title ?? "",
      startedAt: running.startedAt, usualMinutes: currentStep?.estimate.p50Minutes ?? timerOrder.estimate.p50Minutes } } : {})
  });
  for (const nudge of planned) say(ctx, nudge.text, nudge.buttons, { kind: nudge.kind, fingerprint: nudge.fingerprint, counted: nudge.counted, urgent: nudge.urgent,
    ...(nudge.covers ? { covers: nudge.covers } : {}), ...(nudge.block ? { block: nudge.block } : {}), ...(nudge.step ? { step: nudge.step } : {}) }, now);
  return planned;
}

/** Today's blocks as this pass has seen them (`nudge.blocks:<day>`). */
export const seenBlocksKey = (day: string) => `nudge.blocks:${day}`;

/**
 * The blocks that really happened today, for the completion check. The schedule is derived and a block leaves it once it has ended,
 * so this pass (every two minutes) remembers each block it sees; one counts once a pass saw it under way — the commit window holds a
 * block in place from fifteen minutes before its start to its end, so every block that happened is seen under way at least once,
 * and one moved elsewhere before it began is never asked about. A block keeps the times it had once it began.
 */
function rememberBlocks(ctx: AccessContext, today: string, clock: string, blocks: NudgeEnding[]): NudgeEnding[] {
  const store = getStore();
  type Seen = NudgeEnding & { began: boolean };
  let seen: Record<string, Seen> = {};
  try { seen = JSON.parse(store.getSetting(ctx.workspaceId, seenBlocksKey(today)) ?? "{}") as Record<string, Seen>; } catch { /* starts afresh */ }
  let changed = false;
  for (const block of blocks) {
    if (seen[block.id]?.began) continue;
    const began = block.start <= clock && clock < block.end;
    const before = seen[block.id];
    if (!before || before.start !== block.start || before.end !== block.end || began) { seen[block.id] = { ...block, began }; changed = true; }
  }
  if (changed) store.setSetting(ctx.workspaceId, seenBlocksKey(today), JSON.stringify(seen));
  return Object.values(seen).filter((block) => block.began).map(({ began: _began, ...block }) => block);
}

/** Background work that finished in the last six hours and is waiting for the person: assistant results, preparation, new proposals. */
function backgroundDone(ctx: AccessContext, now: Date, locale?: Locale): Array<{ key: string; text: string; label: string; href: string }> {
  const store = getStore();
  const t = tFor(locale);
  const since = now.getTime() - 6 * 3_600_000;
  const finishedAt = (task: { requestedAt: string; durationMs: number }) => Date.parse(task.requestedAt) + task.durationMs;
  const out: Array<{ key: string; text: string; label: string; href: string }> = [];
  for (const task of listAgentTasks(store, ctx.workspaceId).filter((item) => finishedAt(item) >= since)) {
    const name = task.title.split(" · ").at(-1) ?? task.title;
    // An automation's run (task id `auto-…`, apps/worker/src/automations.ts) already sent its own message with the files and the
    // link to 待确认; a second 「做完了，等待审阅」 for the same result was a duplicate (2026-10-19).
    if (task.taskId.startsWith("auto-")) continue;
    if (task.status === "needs_review") out.push({ key: `agent:${task.taskId}`, text: t("助手做完了「{{name}}」，等待审阅。", { name }), label: t("去审阅"), href: "/approvals#assistant" });
    else if (task.status === "accepted" && task.stepId) out.push({ key: `agent:${task.taskId}`, text: t("「{{name}}」已备好，可在任务的材料里查看。", { name }), label: t("打开任务"),
      href: `/workbench/${encodeURIComponent(task.workOrderId)}` });
  }
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  // A proposal is announced once its steps are planned, not when the analysis lands (`lib/proposal-ready.ts`): it counts from whichever
  // came later, so one planned hours after it was proposed is still announced.
  const preparing = preparingProposalIds(ctx);
  const plannedAt = new Map(store.listStepPlans(ctx.workspaceId).map((plan) => [plan.workOrderId, Date.parse(plan.plannedAt)]));
  const proposedAt = new Map<string, number>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "work_order.transitioned" }))
    if ((event.payload as { to?: string }).to === "awaiting_plan_approval") proposedAt.set(event.entityId, Date.parse(event.createdAt));
  for (const [id, at] of proposedAt) {
    const order = orders.get(id);
    if (order?.state === "awaiting_plan_approval" && onPersonsBoard(order) && !preparing.has(id) && Math.max(at, plannedAt.get(id) ?? 0) >= since) out.push({ key: `proposal:${order.id}`, text: t("「{{name}}」已分析好，等待批准。", { name: taskTitleOf(order) }), label: t("去批准"), href: "/approvals#proposals" });
  }
  return out.slice(0, 5);
}

/**
 * Kinds the person said to ask about less (「少问这类」, a week), and kinds left unanswered three times running (three days — the
 * person's silence is an answer too). Both expire by themselves.
 */
function mutedKinds(ctx: AccessContext, recent: StoredConversationMessage[], today: string, now: Date): Set<NudgeKind> {
  const store = getStore();
  const kinds: NudgeKind[] = ["block_start", "block_confirm", "latest_start", "timer_overrun", "background_done", "energy_check", "outcome_check", "progress_check"];
  const muted = new Set<NudgeKind>();
  for (const kind of kinds) {
    const until = store.getSetting(ctx.workspaceId, muteKey(kind));
    if (until && until >= today) { muted.add(kind); continue; }
    const lastThree = recent.filter((message) => (message.payload.nudge as NudgePayload | undefined)?.kind === kind).slice(-3);
    const ignored = lastThree.length === 3 && lastThree.every((message) => (message.payload.card as Card | undefined)?.clarify.chosen === undefined
      && now.getTime() - Date.parse(message.createdAt) > 30 * 60_000);
    if (ignored) { store.setSetting(ctx.workspaceId, muteKey(kind), addDays(today, 3)); muted.add(kind); }
  }
  return muted;
}

/** 「少问这类」: this kind is not said for a week. */
export function muteNudgeKind(ctx: AccessContext, kind: string, now = new Date()): void {
  getStore().setSetting(ctx.workspaceId, muteKey(kind), addDays(planToday(ctx, now), 7));
}

/**
 * Writes one system message into the day's conversation, its buttons as the card's options (choosing one is the answer). Shown on
 * the page when one was visible in the last ten minutes; otherwise left for the worker to send to the desktop and phone.
 */
/** A nudge's card: its words as the question and its buttons as options (`{message}` in a link becomes the message's id). */
function nudgeCard(id: string, text: string, buttons: NudgeButton[], kind: NudgePayload["kind"]): Card {
  const actions: ProposedAction[] = [];
  const options = buttons.map((button) => {
    if (button.kind !== "action") return { label: button.label, actions: [] as number[], kind: button.kind,
      ...(button.kind === "href" ? { href: button.href.replace("{message}", encodeURIComponent(id)) } : {}) };
    actions.push(button.action);
    return { label: button.label, actions: [actions.length - 1], kind: "action" as const };
  });
  return { actions, items: actions.map(() => ({ state: "pending" })), clarify: { question: text, options }, confidence: "high", nudgeKind: kind };
}

function say(ctx: AccessContext, text: string, buttons: NudgeButton[], nudge: Omit<NudgePayload, "delivery">, now: Date, extra: Record<string, unknown> = {}): void {
  const store = getStore();
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  const id = randomUUID();
  const card = nudgeCard(id, text, buttons, nudge.kind);
  const visibleAt = store.getSetting(ctx.workspaceId, PRESENCE_SETTING);
  // A completion check goes to the desktop and the phone whatever page is open (docs/loop-and-scout.md §3): the person is rarely on
  // the page at the moment a block ends.
  const delivery = nudge.kind !== "block_confirm" && visibleAt && now.getTime() - Date.parse(visibleAt) < PRESENCE_FRESH_MS ? "page" : "pending";
  store.appendConversationMessage({ id, workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "",
    payload: { ...extra, nudge: { ...nudge, delivery }, card }, createdAt: now.toISOString() });
}

/**
 * The day's first words, said when the day's conversation is first opened: the fixed arrangements, the work placed, what bears on a
 * deadline, and the most urgent decision with its own options as buttons (the rest are a link away).
 */
export async function ensureOpener(ctx: AccessContext, now = new Date(), force = false): Promise<boolean> {
  const store = getStore();
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const today = planToday(ctx, now);
  // The day's summary is written once: before the start standard it was written from an empty plan (the 小帮手 on the settings page
  // fetches the conversation during the interview) and said 「今天没有固定安排」 all day over a class the interview had just read in.
  if (!interviewStatus(ctx).readyToStart) return false;
  const conversation = store.conversationFor(ctx.workspaceId, today);
  // Written once a day, then kept current: it used to say 「待决事项 2 项，最紧急的是『访谈未完成』」 all day after both were settled. It is
  // read again at most every five minutes (the conversation is polled every 30 s, and each reading places the day's schedule) and rewritten
  // in place when it changed, unless the person already acted on its buttons. `force`: a decision was just answered from it, so it moves
  // on to the next one at once.
  const existing = store.listConversationMessages(ctx.workspaceId, conversation.id).find((message) => (message.payload.nudge as NudgePayload | undefined)?.kind === "opener");
  if (existing && !force) {
    const read = Date.parse(String(existing.payload.openerReadAt ?? existing.createdAt));
    const acted = ((existing.payload.card as Card | undefined)?.items ?? []).some((item) => item.state !== "pending");
    if (acted || now.getTime() - read < OPENER_REFRESH_MS) return false;
  }
  const plan = await loadCurrentPlan(ctx);
  const todays = plan.blocks.filter((block) => (block.day ?? today) === today).sort((a, b) => a.start.localeCompare(b.start));
  const fixed = todays.filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && !block.id.startsWith("optional:")
    && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title)));
  const work = todays.filter((block) => block.id.startsWith("scheduled:"));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const soon = store.listWorkOrders(ctx.workspaceId).filter((order) => ["approved", "preparing", "ready_for_human", "active"].includes(order.state) && onPersonsBoard(order))
    .map((order) => ({ order, due: (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "" }))
    .filter((item) => item.due && item.due >= today && item.due <= addDays(today, 3)).sort((a, b) => a.due.localeCompare(b.due));
  // This week's, the same count as Today's stack and 待确认: the ones that can wait are not today's to mention.
  const asks = thisWeek(listed(openAsks(ctx, now)));
  const md = (day: string) => locale === "en" ? monthDay(locale, day) : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  // The text version (push, older pages) stays a few short lines: two of each with names cut short, the rest counted. The card drawn
  // from `opener` below carries the whole day.
  // An ask's title often already quotes its task (「「X」需要本人回答…」): the outer quotes are this line's, so the title's own go.
  const short = (raw: string) => { const text = raw.replace(/^「(.+?)」/u, "$1"); return text.length > 16 ? `${text.slice(0, 15)}…` : text; };
  const few = (parts: string[]) => `${parts.slice(0, 2).join(t("；"))}${parts.length > 2 ? t(" 等 {{count}} 项", { count: parts.length }) : ""}`;
  const lines = [
    t("{{reason}}。", { reason: dayLabel(today, locale) }),
    fixed.length ? t("固定安排：{{items}}。", { items: few(fixed.map((block) => `${block.start}–${block.end} ${short(block.title)}`)) }) : t("今天没有固定安排。"),
    work.length ? t("排给工作的时段 {{count}} 段：{{items}}。", { count: work.length, items: few(work.map((block) => `${block.start} ${short(block.task ?? block.title)}`)) })
      : t("今天没有排给工作的时段。"),
    ...(soon.length ? [t("三天内截止：{{items}}。", { items: few(soon.map((item) => t("{{title}}（{{day}}）", { title: short(taskTitleOf(item.order)), day: md(item.due) }))) })] : []),
    asks.length ? (asks[0] ? t("待决事项 {{count}} 项，最紧急的是「{{title}}」。", { count: asks.length, title: short(asks[0].title) }) : t("待决事项 {{count}} 项。", { count: asks.length }))
      : t("没有待决事项。")
  ];
  // The most urgent decision is answerable here when its options need nothing typed.
  const first = asks[0];
  const answerable = first ? first.options.filter((option) => !option.href && !option.needsNote && !(option.fields ?? []).some((field) => field.required)).slice(0, 4) : [];
  // An answer that takes the person's own words is given on the ask's card (Today's stack), never as an empty one-tap answer.
  const typed = Boolean(first && (first.freeText || first.options.some((option) => option.needsNote)));
  const buttons: NudgeButton[] = [
    ...(first && typed ? [{ kind: "href" as const, label: t("写答案"), href: "/#asks" }] : []),
    ...(first ? answerable.map((option): NudgeButton => ({ kind: "action", label: option.label,
      action: { action: "ask.answer", summary: t("{{label}}：{{title}}", { label: first.title.slice(0, 40), title: option.label }), args: { askId: first.id, optionId: option.id, fields: [] } } })) : []),
    ...(asks.length ? [{ kind: "href" as const, label: t("待决事项（{{count}}）", { count: asks.length }), href: "/approvals" }] : []),
    { kind: "href", label: t("打开计划"), href: "/plan" }
  ];
  // The same day as data, for the card Today's conversation and the return page draw (the text above stays for push and older pages).
  const lineOfOrder = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.identityId]));
  const filing = (() => { try { return calendarFiling(ctx); } catch { return null; } })();
  const withLine = <T extends object>(item: T, line: string | undefined): T & { line?: string } => line ? { ...item, line } : item;
  const opener: OpenerView = {
    day: today, label: dayLabel(today, locale), timeZone: effectiveSchedulePreferences(ctx).preferences.timeZone,
    fixed: fixed.map((block) => withLine({ start: block.start, end: block.end, title: block.title }, calendarLineOf(filing, block.title))),
    work: [...work.map((block) => withLine({ start: block.start, end: block.end, title: block.task ?? block.title, ...(block.step ? { step: block.step } : {}) },
      lineOfOrder.get(block.id.split(":")[1]!))),
      // What today's plan no longer holds because its time passed undone, kept dashed until 04:00 tomorrow.
      ...missedItems(ctx, [], {}, now).filter((item) => item.day === today).map((item) => withLine({ start: item.start, end: item.end, title: item.title,
        ...(item.step ? { step: item.step } : {}), missed: true }, lineOfOrder.get(item.workOrderId ?? "")))].sort((a, b) => a.start.localeCompare(b.start)),
    soon: soon.slice(0, 6).map((item) => withLine({ title: taskTitleOf(item.order), due: item.due }, item.order.identityId)),
    asks: { count: asks.length, ...(first ? { top: withLine({ title: first.title, urgency: first.urgency }, first.line) } : {}) }
  };
  if (existing) {
    const text = lines.join("\n");
    const same = (existing.payload.card as Card | undefined)?.clarify?.question === text && JSON.stringify(existing.payload.opener) === JSON.stringify(opener);
    store.updateConversationPayload(ctx.workspaceId, existing.id, { ...existing.payload, openerReadAt: now.toISOString(),
      ...(same ? {} : { opener, card: nudgeCard(existing.id, text, buttons, "opener") }) });
    return false;
  }
  say(ctx, lines.join("\n"), buttons, { kind: "opener", fingerprint: `opener:${today}`, counted: false, urgent: false }, now, { opener });
  return true;
}

/** How often the day's opener is read again to keep it current. */
const OPENER_REFRESH_MS = 5 * 60_000;
