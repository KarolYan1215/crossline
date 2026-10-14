import "server-only";
import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { listAgentTasks, type StoredConversationMessage } from "@crossline/db";
import {
  availableSlots, isCancelledEvent, planNudges, taskTitleOf,
  type AccessContext, type NotifyLevelName, type NudgeBlock, type NudgeEnding, type NudgeButton, type NudgeKind, type NudgeSlack, type PlannedNudge, type ProposedAction
} from "@crossline/core";
import { commitSoon, effectiveSchedulePreferences, energyAnswerMatters, getStore, loadCurrentPlan, planToday, readAvailability } from "./crossline";
import { openAsks, thisWeek } from "./asks";
import { energyModel } from "./energy";
import { systemContext } from "./auto-publish";
import type { Card } from "./conversation";

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
    try { said += (await nudgesFor(systemContext(workspace.id, ownerId, now), now)).length; } catch { /* next interval */ }
  }
  return said;
}

/** Reads the account, decides (`planNudges`, rules only) and writes what is to be said into the day's conversation. */
export async function nudgesFor(ctx: AccessContext, now = new Date()): Promise<PlannedNudge[]> {
  const store = getStore();
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx, now);
  const clock = formatInTimeZone(now, zone, "HH:mm");
  const local = (iso: string) => formatInTimeZone(new Date(iso), zone, "yyyy-MM-dd'T'HH:mm");
  const level = (store.getSetting(ctx.workspaceId, "notify.level") as NotifyLevelName | undefined) ?? "normal";
  const recent = store.listRecentNudges(ctx.workspaceId, new Date(now.getTime() - 3 * DAY).toISOString());
  const payloadOf = (message: StoredConversationMessage) => message.payload.nudge as NudgePayload | undefined;
  const muted = mutedKinds(ctx, recent, today, now);
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => !(order.payload as { seeded?: boolean }).seeded);
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
  for (const task of listAgentTasks(store, ctx.workspaceId).filter((item) => item.status === "accepted" || item.status === "needs_review"))
    readyFiles.set(task.workOrderId, [...(readyFiles.get(task.workOrderId) ?? []), ...task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1) ?? artifact.path)]);

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
  })).map((block) => ({ ...block, endedTimerAt: lastStopped.get(block.orderId)?.slice(11, 16) ?? "" }));

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
  const finished = backgroundDone(ctx, now);
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
    ? { nextBlock: `${nextWork.start}「${nextWork.task ?? nextWork.title}」`, why: "回答后，今天剩下和之后的时段会按精力重新安排。" } : undefined;
  const planned = planNudges({
    now: now.toISOString(), today, clock, tomorrow: addDays(today, 1), level, muted,
    quiet: { timerRunning: Boolean(running), inMeeting: meeting, answeredRecently: Boolean(answeredAt) && now.getTime() - Date.parse(answeredAt!) < ANSWERED_QUIET_MS },
    night: clock < "08:00" || clock >= "23:00",
    sent: new Set(recent.flatMap((message) => [payloadOf(message)?.fingerprint ?? "", ...(payloadOf(message)?.covers ?? [])])),
    countedToday: recent.filter((message) => payloadOf(message)?.counted && message.createdAt.slice(0, 10) >= addDays(today, -1)
      && local(message.createdAt).slice(0, 10) === today).length,
    blocks, ending, slack, finished, ...(energyCheck ? { energyCheck } : {}),
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
function backgroundDone(ctx: AccessContext, now: Date): Array<{ key: string; text: string; label: string; href: string }> {
  const store = getStore();
  const since = now.getTime() - 6 * 3_600_000;
  const finishedAt = (task: { requestedAt: string; durationMs: number }) => Date.parse(task.requestedAt) + task.durationMs;
  const out: Array<{ key: string; text: string; label: string; href: string }> = [];
  for (const task of listAgentTasks(store, ctx.workspaceId).filter((item) => finishedAt(item) >= since)) {
    const name = task.title.split(" · ").at(-1) ?? task.title;
    if (task.status === "needs_review") out.push({ key: `agent:${task.taskId}`, text: `助手做完了「${name}」，等待审阅。`, label: "去审阅", href: "/approvals#assistant" });
    else if (task.status === "accepted" && task.stepId) out.push({ key: `agent:${task.taskId}`, text: `「${name}」已备好，可在任务的材料里查看。`, label: "打开任务",
      href: `/workbench/${encodeURIComponent(task.workOrderId)}` });
  }
  const proposed = store.listEvents(ctx.workspaceId, { type: "work_order.transitioned" }).filter((event) => Date.parse(event.createdAt) >= since
    && (event.payload as { to?: string }).to === "awaiting_plan_approval");
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  for (const event of proposed) {
    const order = orders.get(event.entityId);
    if (order?.state === "awaiting_plan_approval") out.push({ key: `proposal:${order.id}`, text: `「${taskTitleOf(order)}」已分析好，等待批准。`, label: "去批准", href: "/approvals#proposals" });
  }
  return out.slice(0, 5);
}

/**
 * Kinds the person said to ask about less (「少问这类」, a week), and kinds left unanswered three times running (three days — the
 * person's silence is an answer too). Both expire by themselves.
 */
function mutedKinds(ctx: AccessContext, recent: StoredConversationMessage[], today: string, now: Date): Set<NudgeKind> {
  const store = getStore();
  const kinds: NudgeKind[] = ["block_start", "block_confirm", "latest_start", "timer_overrun", "background_done", "energy_check"];
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
function say(ctx: AccessContext, text: string, buttons: NudgeButton[], nudge: Omit<NudgePayload, "delivery">, now: Date): void {
  const store = getStore();
  const conversation = store.conversationFor(ctx.workspaceId, planToday(ctx, now));
  const id = randomUUID();
  const actions: ProposedAction[] = [];
  const options = buttons.map((button) => {
    if (button.kind !== "action") return { label: button.label, actions: [] as number[], kind: button.kind,
      ...(button.kind === "href" ? { href: button.href.replace("{message}", encodeURIComponent(id)) } : {}) };
    actions.push(button.action);
    return { label: button.label, actions: [actions.length - 1], kind: "action" as const };
  });
  const card: Card = { actions, items: actions.map(() => ({ state: "pending" })), clarify: { question: text, options }, confidence: "high", nudgeKind: nudge.kind };
  const visibleAt = store.getSetting(ctx.workspaceId, PRESENCE_SETTING);
  // A completion check goes to the desktop and the phone whatever page is open (docs/loop-and-scout.md §3): the person is rarely on
  // the page at the moment a block ends.
  const delivery = nudge.kind !== "block_confirm" && visibleAt && now.getTime() - Date.parse(visibleAt) < PRESENCE_FRESH_MS ? "page" : "pending";
  store.appendConversationMessage({ id, workspaceId: ctx.workspaceId, conversationId: conversation.id, role: "nudge", text: "",
    payload: { nudge: { ...nudge, delivery }, card }, createdAt: now.toISOString() });
}

/**
 * The day's first words, said when the day's conversation is first opened: the fixed arrangements, the work placed, what bears on a
 * deadline, and the most urgent decision with its own options as buttons (the rest are a link away).
 */
export async function ensureOpener(ctx: AccessContext, now = new Date()): Promise<boolean> {
  const store = getStore();
  const today = planToday(ctx, now);
  const conversation = store.conversationFor(ctx.workspaceId, today);
  if (store.listConversationMessages(ctx.workspaceId, conversation.id).some((message) => (message.payload.nudge as NudgePayload | undefined)?.kind === "opener")) return false;
  const plan = await loadCurrentPlan(ctx);
  const todays = plan.blocks.filter((block) => (block.day ?? today) === today).sort((a, b) => a.start.localeCompare(b.start));
  const fixed = todays.filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:") && !block.id.startsWith("optional:")
    && !(block.id.startsWith("graph_calendar:") && isCancelledEvent(block.title)));
  const work = todays.filter((block) => block.id.startsWith("scheduled:"));
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const soon = store.listWorkOrders(ctx.workspaceId).filter((order) => ["approved", "preparing", "ready_for_human", "active"].includes(order.state))
    .map((order) => ({ order, due: (order.payload as { dueDate?: string }).dueDate || anchors.get(order.milestoneId) || "" }))
    .filter((item) => item.due && item.due >= today && item.due <= addDays(today, 3)).sort((a, b) => a.due.localeCompare(b.due));
  // This week's, the same count as Today's stack and 待确认: the ones that can wait are not today's to mention.
  const asks = thisWeek(openAsks(ctx, now));
  const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  const lines = [
    `${Number(today.slice(5, 7))} 月 ${Number(today.slice(8, 10))} 日 周${"日一二三四五六"[new Date(`${today}T12:00:00Z`).getUTCDay()]}。`,
    fixed.length ? `固定安排：${fixed.map((block) => `${block.start}–${block.end} ${block.title}`).join("；")}。` : "今天没有固定安排。",
    work.length ? `排给工作的时段 ${work.length} 段：${work.slice(0, 4).map((block) => `${block.start} ${block.task ?? block.title}`).join("；")}${work.length > 4 ? " 等" : ""}。` : "今天没有排给工作的时段。",
    ...(soon.length ? [`三天内截止：${soon.slice(0, 4).map((item) => `${taskTitleOf(item.order)}（${md(item.due)}）`).join("；")}。`] : []),
    asks.length ? `待决事项 ${asks.length} 项${asks[0] ? `，最紧急的是「${asks[0].title}」` : ""}。` : "没有待决事项。"
  ];
  // The most urgent decision is answerable here when its options need nothing typed.
  const first = asks[0];
  const answerable = first ? first.options.filter((option) => !option.href && !(option.fields ?? []).some((field) => field.required)).slice(0, 4) : [];
  const buttons: NudgeButton[] = [
    ...(first ? answerable.map((option): NudgeButton => ({ kind: "action", label: option.label,
      action: { action: "ask.answer", summary: `${first.title.slice(0, 40)}：${option.label}`, args: { askId: first.id, optionId: option.id, fields: [] } } })) : []),
    ...(asks.length ? [{ kind: "href" as const, label: `全部待决（${asks.length}）`, href: "/approvals" }] : []),
    { kind: "href", label: "打开计划", href: "/plan" }
  ];
  say(ctx, lines.join("\n"), buttons, { kind: "opener", fingerprint: `opener:${today}`, counted: false, urgent: false }, now);
  return true;
}
