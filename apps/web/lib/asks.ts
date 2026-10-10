import "server-only";
import { recordOp, retractedEventIds, withUndo } from "./undo";
import {
  ATTENTION_SNAPSHOT, BACKGROUND_BLOCKER, CALENDAR_LINES, CALENDAR_PUBLISH_FAILURE, CALENDAR_SYNC_FAILURE, calendarEventKey, daysBetween, describeEvent, missingInputsOf, rankAsks,
  prepStepRetried, snoozeUntil, STEP_ANSWER_SLOT, stepAnswerSlot, taskTitleOf, urgencyFor, type CalendarLines,
  validateAskAnswer, type AccessContext, type Ask, type AskField, type AskOption, type AskSnooze
} from "@crossline/core";
import { listAgentTasks, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import {
  acceptWorkOrderEvidence, answerWaiting, approveWorkOrderProposal, archiveWorkOrder, discardCapture, getStore, loadGoalForecast,
  markMaterialsReady, planToday, readGoalSettings, retryMaterialPreparation, saveGoalSettings, TASK_LIBRARY_WINDOW_DAYS
} from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { readScheduledDay } from "./schedule-memory";
import { requestCodexSupervisor } from "./codex-runtime";
import { autoPublishPass, forgetPublishedHash } from "./auto-publish";
import { calendarFiling } from "./timeline";
import { answerInterviewQuestion, interviewStatus } from "./interview-status";
import { requestStepReplan } from "./steps";
import { unfiledFiles } from "./file-belonging";
import { decideEvent, eventProposals, publishFixedEvents } from "./fixed-events";
import { identityLines } from "./lines";
import { decisionHorizon } from "./horizon";
import { answerRelationCheck, relationCheckAsks } from "./artifact-relations";

/** Markers an undo has taken back are as if never written. */
const live = <T extends { eventId: string }>(ctx: AccessContext, events: T[]): T[] => {
  const retracted = retractedEventIds(ctx);
  return retracted.size ? events.filter((event) => !retracted.has(event.eventId)) : events;
};

/** A message used as a clause before 「。」: its own closing punctuation dropped, so the sentence does not end 「。。」. */
const clause = (text: string | undefined) => String(text ?? "").trim().replace(/[。．.；;，,\s]+$/u, "");

/**
 * Every place the system needs the person, as asks (see `packages/core/src/asks.ts`). Built from the ledger on read,
 * never stored, so an ask disappears by itself the moment what it was about is resolved — by its own answer, by a
 * button elsewhere, or by the worker. `answerAsk` carries out an answer through the same functions the rest of the
 * app uses; nothing here is a second way to change state.
 *
 * Where each one came from (an audit of every place work stopped for a person, 2026-10-07): a refused backplan wrote
 * an event nothing read; a refused capture, stopped materials and a failed gate showed only on a detail page; a gate's
 * real 「insufficient」 reached nobody while its *run* failure was toasted as 「没通过验收」; a failed calendar read or
 * publish was a log line; and a milestone heading past its deadline was only a phrase on the plan page.
 */

const DAY = 86_400_000;
const UNTOUCHED = new Set(["awaiting_plan_approval", "approved", "preparing"]);
const lineLabel = (id: string) => defaultIdentityPacks().find((pack) => pack.id === id)?.label ?? id;
const short = (text: string, length = 40) => text.length > length ? `${text.slice(0, length)}…` : text;

type Source = { store: ReturnType<typeof getStore>; ctx: AccessContext; today: string; now: Date };

function deadlines(store: Source["store"], workspaceId: string) {
  return new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
}
const dueOf = (order: StoredWorkOrder, anchors: Map<string, string>) =>
  (order.payload as { dueDate?: string } | undefined)?.dueDate ?? anchors.get(order.milestoneId);

/** A backplan the model refused, or split with missing inputs: one ask per missing thing it named. */
function backplanAsks({ store, ctx, today }: Source): Ask[] {
  const milestones = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item]));
  const anchors = deadlines(store, ctx.workspaceId);
  const declined = new Set(store.listEvents(ctx.workspaceId, { type: "goal.backplan_declined" })
    .map((event) => `${event.entityId}:${(event.payload as { milestoneVersion?: number }).milestoneVersion}`));
  const resolved = new Set(store.listEvents(ctx.workspaceId, { type: "goal.backplan_input_resolved" })
    .map((event) => (event.payload as { askId?: string }).askId));
  const latest = new Map<string, ReturnType<typeof store.listEvents>[number]>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "goal.backplan_blocked" })) latest.set(event.entityId, event);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const asks: Ask[] = [];
  for (const [milestoneId, event] of latest) {
    const milestone = milestones.get(milestoneId);
    const payload = event.payload as { milestoneVersion?: number; code?: string; message?: string };
    if (!milestone || payload.milestoneVersion !== milestone.version || declined.has(`${milestoneId}:${milestone.version}`)) continue;
    const dueDay = readGoalSettings(ctx, milestoneId)?.confirmedDeadline ?? anchors.get(milestoneId);
    // A milestone whose work still waits in the task library is not asked about yet: its missing inputs come up when its window opens,
    // with the rest of its work (asking about every approved milestone at once put 33 questions on Today).
    if (dueDay && daysBetween(today, dueDay) > TASK_LIBRARY_WINDOW_DAYS) continue;
    const base = { entityId: milestoneId, line: milestone.identityId, raisedAt: event.createdAt, fingerprint: event.eventId,
      urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}) };
    const missing = missingInputsOf(event.payload);
    const skip: AskOption = { id: "skip", label: "暂不拆分该里程碑", detail: "撤回尚未开始的自动步骤，本版本不再自动倒推" };
    if (!missing.length) {
      const id = `bp:${event.eventId}:all`;
      if (resolved.has(id)) continue;
      asks.push({ ...base, id, kind: "backplan_input", title: `「${short(milestone.title)}」未能自动拆分`,
        why: `自动倒推中止：${clause(payload.message || payload.code)}。可重试，或手动填写第一步。`,
        options: [{ id: "retry", label: "再试一次", recommended: true }, { id: "own", label: "手动填写第一步", href: "/#capture-title" }, skip] });
      continue;
    }
    for (const input of missing) {
      const id = `bp:${event.eventId}:${input.id}`;
      if (resolved.has(id)) continue;
      const acquiring = orders.some((order) => order.state !== "archived"
        && (order.payload as { backplan?: { inputsFrom?: string; acquires?: string } }).backplan?.inputsFrom === event.eventId
        && (order.payload as { backplan?: { acquires?: string } }).backplan?.acquires === input.id);
      asks.push({ ...base, id, kind: "backplan_input",
        title: `「${short(milestone.title)}」还缺：${short(input.what, 50)}`,
        why: `倒推该里程碑时缺少输入：${input.message}${acquiring ? "「获取该输入」已排为第一步（待批准）。" : "缺少该输入时后续步骤无法确定。"}`,
        options: [
          { id: "have", label: "已有，提供内容", detail: "填写内容或存放位置后重新拆分",
            fields: [{ id: "text", label: "内容或存放位置（文件路径、链接、要点）", kind: "longtext", required: true }] },
          { id: "waiting", label: "已索取，等待中", detail: "到期日确认是否到达；此前依赖它的步骤不排入",
            fields: [{ id: "who", label: "谁给", kind: "text", required: false, initial: input.whoHas },
              { id: "date", label: "大约哪天到", kind: "date", required: true }] },
          acquiring ? { id: "ask_first", label: "尚未索取，按第一步执行", detail: "保留「获取该输入」步骤", recommended: true }
            : { id: "ask_first", label: "自行获取", detail: "已记录，不再询问", recommended: true },
          skip
        ] });
    }
  }
  return asks;
}

type WaitingItem = ReturnType<Source["store"]["listWaitingItems"]>[number];

/**
 * Who is waiting on what, for the backplan: which milestones an open waiting item hands a missing input to (a
 * `wait-bp-<milestone>-…` id, or an answer that linked an item the person already had), and which items are the same
 * wait — the same person giving it on the same day for the same project. A 「在等」 answer reuses such an item instead
 * of opening a second one, and 「到了」 on either of a pair that already exists answers both and re-splits every
 * milestone either was holding (a real account had 「西湖 MoS2 真实测量数据」 and 「实测 MoS₂ 参数数据及元数据」, both
 * 师兄 · 10/8, asked about twice on the same morning).
 */
function waitingIndex(store: Source["store"], workspaceId: string) {
  const milestones = new Map(store.listMilestones(workspaceId).map((item) => [item.id, item]));
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  // waiting item → milestone → the input's name as that milestone asked for it.
  const linked = new Map<string, Map<string, string>>();
  for (const event of store.listEvents(workspaceId, { type: "goal.backplan_input_waiting" })) {
    const { waitingId, what } = event.payload as { waitingId?: string; what?: string };
    if (waitingId) linked.set(waitingId, (linked.get(waitingId) ?? new Map()).set(event.entityId, what ?? ""));
  }
  /** The missing inputs this item stands for: `[milestoneId, what]`. */
  const inputsOf = (item: WaitingItem): Array<[string, string]> => {
    const own = [...milestones.keys()].find((id) => item.id.startsWith(`wait-bp-${id}-`));
    const inputs = new Map(linked.get(item.id));
    if (own) inputs.set(own, item.title);
    return [...inputs].map(([id, what]) => [id, what || item.title]);
  };
  const milestonesOf = (item: WaitingItem) => inputsOf(item).map(([id]) => id);
  const projectsOf = (item: WaitingItem) => new Set([...item.blocks.map((id) => orders.get(id)), ...milestonesOf(item).map((id) => milestones.get(id))]
    .filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => `${row.identityId}/${row.projectId ?? ""}`));
  const sameWait = (item: WaitingItem, who: string, expectedAt: string, project: string) =>
    item.state === "open" && Boolean(who.trim()) && item.who.trim() === who.trim() && item.expectedAt === expectedAt && projectsOf(item).has(project);
  const open = store.listWaitingItems(workspaceId, { state: "open" });
  /** The item itself and every other open item that is the same wait. */
  const withTwins = (item: WaitingItem) => [item, ...open.filter((other) => other.id !== item.id
    && [...projectsOf(item)].some((project) => sameWait(other, item.who, item.expectedAt, project)))];
  return { open, inputsOf, milestonesOf, sameWait, withTwins };
}

/** 「…到了吗？」 on the day something the person waits for was due — the waiting card, now one ask among the others. */
function waitingAsks({ store, ctx, today }: Source): Ask[] {
  const index = waitingIndex(store, ctx.workspaceId);
  const due = index.open.filter((item) => item.followUpAt <= today);
  // One card for one wait: an item whose twin is already asked about is answered with it.
  return due.filter((item, position) => !due.slice(0, position).some((earlier) => index.withTwins(earlier).includes(item))).map((item) => {
    const twins = index.withTwins(item);
    const forMilestone = twins.some((twin) => index.milestonesOf(twin).length);
    const blocks = new Set(twins.flatMap((twin) => twin.blocks)).size;
    return { id: `wait:${item.id}`, kind: "waiting_due" as const, entityId: item.id, urgency: "now" as const, dueDay: item.followUpAt,
      raisedAt: item.updatedAt, fingerprint: item.followUpAt,
      title: `${item.who ? `${item.who}的` : ""}「${short(item.title, 50)}」到了吗？`,
      why: `原定${item.approximate ? "大约" : ""} ${item.expectedAt.slice(5)} 到。${forMilestone ? "到了以后系统会带着它重新拆这个里程碑的步骤。"
        : `在它到之前，依赖它的 ${blocks} 项工作不会排进日历。`}`,
      options: [
        { id: "arrived", label: "到了", recommended: true, ...(forMilestone ? { detail: "写一句放在哪、有什么，重拆更准",
          fields: [{ id: "note", label: "放在哪 / 要点（可选）", kind: "longtext" as const, required: false }] } : { detail: "依赖它的工作排上日历" }) },
        { id: "deferred", label: "还没，推迟", fields: [{ id: "date", label: "推迟到", kind: "date" as const, required: true }] },
        { id: "cancelled", label: "不等了" }
      ] };
  });
}

/** A capture the analysis refused. One blocked for want of an approved milestone is not asked: approving one retries it. */
function captureAsks({ store, ctx }: Source): Ask[] {
  return store.listCaptures(ctx.workspaceId).filter((capture) => capture.state === "blocked"
    && capture.audit.blocker?.code !== "ANALYSIS_APPROVED_MILESTONE_REQUIRED").map((capture) => ({
    id: `cap:${capture.id}:${capture.attempt}`, kind: "capture_blocked" as const, entityId: capture.id, urgency: "later" as const,
    raisedAt: store.listEvents(ctx.workspaceId, { entityId: capture.id }).at(-1)?.createdAt ?? "", fingerprint: String(capture.attempt),
    title: `「${short(capture.title)}」未能自动分析`,
    why: `${clause(capture.audit.blocker?.message || capture.audit.blocker?.code || "分析中止")}。补充说明后重新分析。`,
    options: [
      { id: "context", label: "补充说明，重新分析", recommended: true,
        fields: [{ id: "note", label: "补充什么（要交付什么、为谁、哪天前、手上有什么材料）", kind: "longtext" as const, required: true }] },
      { id: "manual", label: "手动建立任务", href: "/workbench" },
      { id: "discard", label: "不要了", fields: [{ id: "reason", label: "为什么不要", kind: "text" as const, required: true }] }
    ] }));
}

/** Last word wins over a materials trail: blocked unless a later retry asked again. */
function lastMaterialsBlock(events: ReturnType<ReturnType<typeof getStore>["listEvents"]>) {
  let last: (typeof events)[number] | undefined;
  for (const event of events) last = event.type === "materials.blocked" ? event : undefined;
  return last;
}

function materialsAsks({ store, ctx, today }: Source): Ask[] {
  const anchors = deadlines(store, ctx.workspaceId);
  const events = store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"] });
  return store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "preparing").flatMap((order) => {
    const block = lastMaterialsBlock(events.filter((event) => event.entityId === order.id));
    if (!block) return [];
    const detail = block.payload as { code?: string; message?: string };
    const dueDay = dueOf(order, anchors);
    return [{ id: `mat:${block.eventId}`, kind: "materials_blocked" as const, entityId: order.id, line: order.identityId,
      urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}), raisedAt: block.createdAt, fingerprint: block.eventId,
      title: `「${short(order.intent)}」材料未准备完成`,
      why: `${clause(detail.message || detail.code || "准备中止")}。可重试，或不等材料直接开始。`,
      options: [
        { id: "retry", label: "再试一次", recommended: /^(SKILL_|CODEX_)/.test(detail.code ?? "") },
        { id: "self", label: "不需要材料，直接开始", recommended: !/^(SKILL_|CODEX_)/.test(detail.code ?? "") },
        { id: "look", label: "去看缺什么", href: `/workbench/${encodeURIComponent(order.id)}` }
      ] }];
  });
}

type GateReview = { verdict?: string; gaps?: Array<{ whatWouldSatisfyIt: string }>;
  criteriaVerdict?: Array<{ met: string; shortfall?: string }> };

/** The gate's own 「not enough」, and a gate run that did not happen — two different things, asked differently. */
function gateAsks({ store, ctx, today }: Source): Ask[] {
  const anchors = deadlines(store, ctx.workspaceId);
  const asks: Ask[] = [];
  const runFailures = new Map<string, ReturnType<typeof store.listEvents>[number]>();
  for (const event of store.listEvents(ctx.workspaceId, { type: ["milestone_gate.blocked", "milestone_gate.retry_requested"] })) {
    if (event.type === "milestone_gate.blocked") runFailures.set(event.entityId, event); else runFailures.delete(event.entityId);
  }
  for (const order of store.listWorkOrders(ctx.workspaceId)) {
    const dueDay = dueOf(order, anchors);
    const timing = { urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}), line: order.identityId };
    const review = (order.payload as { gateReview?: GateReview }).gateReview;
    if (order.state === "blocked" && review && review.verdict !== "pass") {
      const transition = store.listEvents(ctx.workspaceId, { type: "work_order.transitioned", entityId: order.id }).at(-1);
      const needs = [...(review.gaps ?? []).map((gap) => gap.whatWouldSatisfyIt),
        ...(review.criteriaVerdict ?? []).filter((item) => item.met !== "met" && item.shortfall).map((item) => item.shortfall!)]
        .filter(Boolean).slice(0, 3);
      asks.push({ id: `gate:${transition?.eventId ?? order.id}`, kind: "gate_insufficient", entityId: order.id, ...timing,
        raisedAt: transition?.createdAt ?? "", fingerprint: transition?.eventId ?? "",
        title: `「${short(order.intent)}」未通过验收`,
        why: needs.length ? `验收尚缺：${clause(needs.join("；"))}。补充后重新提交即重新判定。` : "验收证据不足。补充后重新提交即重新判定。",
        options: [
          { id: "redo", label: "重新排上，补做缺的", recommended: true },
          { id: "look", label: "去看判定细节", href: `/workbench/${encodeURIComponent(order.id)}` },
          { id: "drop", label: "不做了", fields: [{ id: "reason", label: "为什么不做", kind: "text", required: true }] }
        ] });
    }
    if (order.state === "evidence_review") {
      const failure = runFailures.get(order.id);
      if (order.milestoneId && failure) {
        const detail = failure.payload as { code?: string; message?: string };
        asks.push({ id: `gaterun:${failure.eventId}`, kind: "gate_failed", entityId: order.id, ...timing, raisedAt: failure.createdAt,
          fingerprint: failure.eventId, title: `「${short(order.intent)}」验收判定未完成`,
          why: `判定过程中断，并非未通过：${clause(detail.message || detail.code)}。处理后重新判定。`,
          options: [{ id: "rejudge", label: "现在重新判定", recommended: true },
            { id: "look", label: "去看看", href: `/workbench/${encodeURIComponent(order.id)}` }] });
      } else if (!order.milestoneId) {
        asks.push({ id: `accept:${order.id}`, kind: "evidence_manual", entityId: order.id, ...timing, raisedAt: "", fingerprint: order.state,
          title: `「${short(order.intent)}」待验收`, why: "未关联里程碑，不经自动验收，由本人验收。",
          options: [{ id: "accept", label: "算数，验收", recommended: true },
            { id: "look", label: "先看看交付", href: `/workbench/${encodeURIComponent(order.id)}` }] });
      }
    }
  }
  return asks;
}

const format = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/**
 * Explains a milestone's risk in the person's terms: when it is due, how much known work is left, when that work
 * finishes if it goes well and if it does not, and by how much the second misses the margin. A forecast, not a verdict,
 * and only of the steps already split out — said so, because with rolling backplans there are usually more.
 */
export function explainRisk(input: { deadline: string; today: string; p50Day: string | null; p85Day: string | null; slackDays: number | null;
  steps: number; p50Minutes: number; p85Minutes: number; moreToSplit: boolean }): string {
  const left = daysBetween(input.today, input.deadline);
  const hours = (minutes: number) => Math.max(0.5, Math.round(minutes / 30) / 2);
  const parts = [`截止 ${format(input.deadline)}（剩 ${left} 天）。已拆分的 ${input.steps} 个步骤剩余约 ${hours(input.p50Minutes)}–${hours(input.p85Minutes)} 小时。`];
  if (!input.p85Day) parts.push("按当前可用时段与优先于它的工作，八周内无法排完（或前置步骤尚未完成）。");
  else {
    const late = input.slackDays !== null && input.slackDays < 0;
    parts.push(`按当前可用时段与优先于它的工作，通常 ${input.p50Day ? format(input.p50Day) : "—"} 完成，保守估计 ${format(input.p85Day)} 完成`
      + (late ? `，比截止晚 ${-input.slackDays!} 天。` : input.slackDays === 0 ? "，恰在截止当日，没有余量。" : `，仅早于截止 ${input.slackDays} 天，余量不足 2 天。`));
  }
  if (input.moreToSplit) parts.push("仅计入已拆分的步骤；尚有未拆分的工作，实际更紧。");
  parts.push("以上为基于已知工作的预测；可增加时间、推迟截止、降低标准，或接受该风险。");
  return parts.join("");
}

const ACCEPT_RISK_DAYS = 7;

/** A milestone whose known work finishes too close to (or after) its deadline. Tability's three-check rule, as a question. */
function riskAsks({ store, ctx, today }: Source): Ask[] {
  const forecast = loadGoalForecast(ctx);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const accepted = live(ctx, store.listEvents(ctx.workspaceId, { type: "risk.accepted" }));
  const milestones = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item]));
  const rolling = new Set(store.listEvents(ctx.workspaceId, { type: "goal.backplan_proposed" })
    .filter((event) => (event.payload as { rolling?: boolean }).rolling).map((event) => event.entityId));
  return forecast.goals.flatMap((goal) => {
    const milestone = milestones.get(goal.milestoneId);
    const deadline = goal.confirmedDeadline;
    if (!milestone || !deadline || deadline < today) return [];
    const own = orders.filter((order) => order.milestoneId === goal.milestoneId && ["approved", "preparing", "ready_for_human", "active"].includes(order.state));
    if (!own.length) return [];
    const atRisk = goal.p85Day === null || (goal.slackDays !== null && goal.slackDays < 2);
    if (!atRisk) return [];
    // 「接受这个风险」 holds for a week, and only while it does not get worse.
    const slack = goal.slackDays ?? -999;
    const acceptedRecently = accepted.some((event) => event.entityId === goal.milestoneId
      && Date.parse(`${today}T12:00:00Z`) - Date.parse(event.createdAt) < ACCEPT_RISK_DAYS * DAY
      && slack >= Number((event.payload as { slackDays?: number }).slackDays ?? -999));
    if (acceptedRecently) return [];
    return [{ id: `risk:${goal.milestoneId}`, kind: "milestone_risk" as const, entityId: goal.milestoneId, line: milestone.identityId,
      urgency: urgencyFor(deadline, today), dueDay: deadline, raisedAt: "", fingerprint: `${goal.p85Day}|${deadline}`,
      title: `「${short(milestone.title)}」可能赶不上 ${format(deadline)}`,
      why: explainRisk({ deadline, today, p50Day: goal.p50Day, p85Day: goal.p85Day, slackDays: goal.slackDays, steps: own.length,
        p50Minutes: own.reduce((sum, order) => sum + order.estimate.p50Minutes, 0), p85Minutes: own.reduce((sum, order) => sum + order.estimate.p85Minutes, 0),
        moreToSplit: rolling.has(goal.milestoneId) }),
      options: [
        { id: "time", label: "加可用时间", href: "/plan#availability" },
        { id: "extend", label: "推迟截止", fields: [{ id: "date", label: "推迟到", kind: "date" as const, required: true }] },
        { id: "lower", label: "降低标准", href: "/milestones" },
        { id: "accept", label: "接受这个风险", detail: `${ACCEPT_RISK_DAYS} 天内不再问，除非变得更糟` }
      ] }];
  });
}

/**
 * 「昨天排的没做」: work the plan gave a time yesterday that nobody started. The scheduler has already moved it to the next free time —
 * that part needs no one — so this asks only when it matters: when the work bears on a deadline within a week, where silently rolling
 * it forward can quietly eat the margin. Morgen asks the same thing the morning after; Motion just moves it, and its users complain
 * that they cannot tell what slipped. Everything else rolls forward without a question.
 */
const MISSED_ASK_HORIZON_DAYS = 7;
function missedAsks({ store, ctx, today }: Source): Ask[] {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const placed = readScheduledDay(ctx, yesterday);
  if (!Object.keys(placed).length) return [];
  const anchors = deadlines(store, ctx.workspaceId);
  const handled = new Set(live(ctx, store.listEvents(ctx.workspaceId, { type: "missed.handled" })).map((event) => (event.payload as { askId?: string }).askId));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  return Object.entries(placed).flatMap(([orderId, start]) => {
    const order = orders.get(orderId);
    const id = `missed:${orderId}:${yesterday}`;
    // Still not begun: approved, preparing or ready. Started (or done, or discarded) is not missed.
    if (!order || !["approved", "preparing", "ready_for_human"].includes(order.state) || handled.has(id)) return [];
    const dueDay = dueOf(order, anchors);
    if (!dueDay || daysBetween(today, dueDay) > MISSED_ASK_HORIZON_DAYS) return [];
    return [{ id, kind: "missed_block" as const, entityId: orderId, line: order.identityId, urgency: urgencyFor(dueDay, today), dueDay,
      raisedAt: `${yesterday}T${start}`, fingerprint: yesterday,
      title: `昨天 ${start} 排的「${short(order.intent)}」没开始`,
      why: `它已经被顺延到后面的空档，关系到 ${format(dueDay)} 的截止（还剩 ${daysBetween(today, dueDay)} 天）。顺延没问题就点一下；要是其实做了，去补记；要是已经不需要，就不做了。`,
      options: [
        { id: "roll", label: "顺延就好", detail: "按重新排的时间做", recommended: true },
        { id: "later", label: "推到某天再做", fields: [{ id: "date", label: "从哪天起再排", kind: "date" as const, required: true }] },
        { id: "done", label: "其实做了，去补记", href: `/workbench/${encodeURIComponent(orderId)}` },
        { id: "drop", label: "不做了", fields: [{ id: "reason", label: "为什么不做", kind: "text" as const, required: true }] }
      ] }];
  });
}

/**
 * Why an assistant result was refused, in the person's words. The refusal itself is written for the model (it is sent back to it to
 * repair: 「你说做了…从 artifacts 里去掉并写进 notDone」), so it is never shown as it is.
 */
const AGENT_REFUSAL: Record<string, string> = {
  AGENT_ARTIFACT_MISSING: "助手报告的产出文件在任务目录里并不存在，结果未被采纳",
  AGENT_ARTIFACT_EMPTY: "助手报告的产出文件是空的，结果未被采纳",
  AGENT_ARTIFACT_PATH: "助手报告的产出不在任务目录内，结果未被采纳",
  AGENT_EVIDENCE_MISSING: "助手的结果缺少可以核对的证据，未被采纳",
  AGENT_UNCHECKED: "助手的结果没有通过自检，未被采纳",
  AGENT_SUMMARY_INVALID: "助手的总结格式不完整，结果未被采纳"
};

function agentAsks({ store, ctx }: Source): Ask[] {
  const acknowledged = new Set(live(ctx, store.listEvents(ctx.workspaceId, { type: "agent.blocked_acknowledged" })).map((event) => event.entityId));
  const titles = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
  const tasks = listAgentTasks(store, ctx.workspaceId);
  // A preparation step's runs: only its latest is asked about, and not while the worker will run it again by itself.
  const stepRuns = new Map<string, typeof tasks>();
  for (const task of tasks.filter((item) => item.stepId)) stepRuns.set(`${task.workOrderId}#${task.stepId}`, [...(stepRuns.get(`${task.workOrderId}#${task.stepId}`) ?? []), task]);
  const settledStep = (task: (typeof tasks)[number]) => {
    const runs = task.stepId ? stepRuns.get(`${task.workOrderId}#${task.stepId}`) : undefined;
    return !runs || (runs[0] === task && !prepStepRetried(runs));
  };
  return tasks.filter((task) => task.status === "blocked" && !acknowledged.has(task.taskId) && settledStep(task)).map((task) => ({
    id: `agent:${task.taskId}`, kind: "agent_blocked" as const, entityId: task.taskId, urgency: "later" as const, raisedAt: task.requestedAt,
    fingerprint: task.blockerCode, title: `助手没做成「${short(titles.get(task.workOrderId) ?? task.title)}」`,
    why: `${AGENT_REFUSAL[task.blockerCode] ?? clause(task.blockerMessage || task.blockerCode)}。助手不会自动重试，该任务转为本人处理。`,
    options: [{ id: "self", label: "本人处理", recommended: true }, { id: "look", label: "查看助手任务", href: "/settings#automation" }] }));
}

function readFailure(store: Source["store"], workspaceId: string, key: string) {
  try { return JSON.parse(store.getSetting(workspaceId, key) || "null") as { code: string; message: string; sources?: string[]; at: string } | null; }
  catch { return null; }
}

function calendarAsks({ store, ctx }: Source): Ask[] {
  const asks: Ask[] = [];
  const publish = readFailure(store, ctx.workspaceId, CALENDAR_PUBLISH_FAILURE);
  // A worker that is down is its own ask (below); the same cause is not asked twice.
  if (publish && publish.code !== "CODEX_SUPERVISOR_UNAVAILABLE") asks.push({ id: `publish:${publish.code}`, kind: "calendar_publish_failed",
    entityId: "calendar", urgency: "soon", raisedAt: publish.at, fingerprint: publish.code, title: "Crossline 日历没同步上",
    why: publish.code === "CALENDAR_WRITE_NOT_AUTHORIZED"
      ? "写入 Crossline 日历的账号登录已过期，重新登录后重试；其他日历不受影响。"
      : `${clause(publish.message || publish.code)}。其他日历未受影响。`,
    options: [{ id: "retry", label: "处理好了，现在重试", recommended: true }] });
  const sync = readFailure(store, ctx.workspaceId, CALENDAR_SYNC_FAILURE);
  if (sync) asks.push({ id: `sync:${sync.code}:${(sync.sources ?? []).join(",")}`, kind: "calendar_sync_failed", entityId: "calendar",
    urgency: "soon", raisedAt: sync.at, fingerprint: sync.code,
    title: sync.sources?.length ? `读不到日历：${sync.sources.join("、")}` : "日历无法读取",
    why: `${clause(sync.message || sync.code)}。在恢复之前，排程照常用最后一次读到的日程；账号登出需要重新登录。`,
    options: [{ id: "settings", label: "去设置看连接", href: "/settings" }] });
  return asks;
}

/** Everything the ledger alone can tell, unranked. Synchronous, so the badge can count it on every page. */
/**
 * A file dates were read from whose project nothing on record decides — not the dates' own project field, not the project the file is
 * filed under, not its name, not the opening of its text (`packages/core/src/belonging.ts`). One question per file, with the project the
 * interview leaned towards recommended. Until answered, its dates are shown without a course.
 */
/**
 * A file only the person can place (`unfiledFiles`, `lib/file-belonging.ts`): one question per file, the interview's lean recommended.
 * The interview no longer asks the same thing — its question about such a file is left out of its batch (`lib/interview-status.ts`).
 */
function sourceProjectAsks({ store, ctx, today, now }: Source): Ask[] {
  // While the interview runs, it asks this itself (its own round, with the projects as options); here only once it is done or put aside.
  const interview = interviewStatus(ctx, now);
  if (interview.started && !interview.complete && !interview.parked) return [];
  const projects = store.listProjects(ctx.workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  return unfiledFiles(ctx, today).map(({ id, fileName, titles, days, lean, raisedAt }) => {
    const dueDay = days.sort()[0];
    // The lean first, then the projects on its line, then the rest.
    const ordered = [...(lean ? [lean] : []), ...projects.filter((project) => project.id !== lean?.id)
      .sort((a, b) => Number(b.identityId === lean?.identityId) - Number(a.identityId === lean?.identityId))].slice(0, 6);
    const named = titles.slice(0, 3).map((title) => `「${short(title, 16)}」`).join("、");
    return { id: `src:${id}`, kind: "source_project" as const, entityId: id, urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}),
      raisedAt, fingerprint: `${id}:${titles.length}`, title: `《${short(fileName, 32)}》属于哪个项目？`,
      why: titles.length
        ? `文件名和正文开头都没有写明所属课程或项目，从中读出的 ${titles.length} 项日程（${named}${titles.length > 3 ? " 等" : ""}）因此无法标明归属`
          + `${lean ? `；访谈时判断更可能是 ${lean.name}` : ""}。确认后，这些日程与截止都会带上项目名。`
        : "文件名和正文开头都没有写明所属课程或项目。确认后，这份文件会作为该项目任务的材料与背景使用。",
      options: [...ordered.map((project) => ({ id: `p:${project.id}`, label: project.name, ...(project.id === lean?.id ? { recommended: true } : {}) })),
        { id: "none", label: "不属于任何项目", detail: titles.length ? "这份文件的日程保持原名" : "作为通用资料保留" }] };
  });
}

/**
 * A calendar event the classifier could not place from anything on record (a title such as 「Busy」 with nothing else, or a line it
 * named that does not exist). At most three open at a time; the answer is the person's and is never refiled by a model.
 */
function calendarLineAsks({ store, ctx }: Source): Ask[] {
  const lines = identityLines(ctx);
  if (!lines.length) return [];
  const filing = calendarFiling(ctx);
  const titles = new Map<string, string>();
  for (const block of ((store.listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: Array<{ id: string; title: string }> } | undefined)?.blocks ?? []))
    if (block.id.startsWith("graph_calendar:") || block.id.startsWith("import:")) titles.set(calendarEventKey(block.title), block.title);
  return Object.entries(filing.entries).filter(([key, entry]) => entry.unclear && entry.by !== "person" && titles.has(key)).slice(0, 3)
    .map(([key, entry]) => ({ id: `calline:${key}`, kind: "calendar_line_unclear" as const, entityId: key, urgency: "later" as const, raisedAt: entry.at,
      fingerprint: entry.at, title: `日历中的「${short(titles.get(key)!, 30)}」属于哪条主线？`,
      why: `标题和时间都看不出它服务于哪条主线${entry.why ? `（${clause(entry.why)}）` : ""}。确认后，它在日历上按该主线着色，以后同名的日程也一样。`,
      options: [...lines.map((line) => ({ id: `l:${line.id}`, label: line.label })), { id: "none", label: "不属于任何主线", detail: "个人事务等，保持无色" }] }));
}

const STAGE_LABEL: Record<string, string> = { orientation: "开场与规则", situation: "现状", compass: "指南针", energy: "能量", lines: "主线", details: "细节" };

/**
 * The main interview stopped with questions still open. The system works meanwhile — approved milestones are worked back and scheduled —
 * but milestone drafts, long-term goals and the proposed hours are designed from what the interview has, so the gap is named here.
 */
function interviewAsks({ ctx, now }: Source): Ask[] {
  const status = interviewStatus(ctx, now);
  // While the interview runs, its questions are asked in it, round by round; only once the person uses the app without finishing it
  // are they asked here, each answerable in place (decided 2026-10-08).
  if (!status.started || status.complete || !status.parked) return [];
  const where = status.stage ? `访谈在「${STAGE_LABEL[status.stage] ?? status.stage}」阶段（第 ${status.stageIndex}/${status.stageCount} 阶段）` : "访谈";
  const questions = status.questions.map((question): Ask => {
    const single = question.kind !== "free" && question.options.length > 0;
    const other: AskField = { id: "other", label: "补充", kind: "text", required: false, placeholder: "可不填" };
    return { id: `iq:${question.id}`, kind: "interview_question", entityId: question.id, urgency: "later", raisedAt: "",
      fingerprint: `${status.sessionId}:${question.id}`, ...(question.identityId ? { line: question.identityId } : {}),
      title: question.text,
      why: `${where}的问题。本轮的问题都答完后，会一起交给访谈，接着下一轮。`,
      options: single
        ? question.options.slice(0, 8).map((option) => ({ id: option.id, label: option.label, ...(option.detail ? { detail: option.detail } : {}),
          ...(question.allowOther ? { fields: [other] } : {}) }))
        : [{ id: "free", label: "回答", fields: [{ id: "other", label: "回答", kind: "longtext" as const, required: true }] }] };
  });
  return [{ id: "interview:open", kind: "interview_open", entityId: "interview", urgency: "later", raisedAt: "",
    fingerprint: `${status.stage}:${status.openQuestions}`,
    title: "访谈未完成",
    why: `${where}${status.openQuestions ? `，${status.openQuestions} 个问题列在下面，可以在这里逐个回答` : ""}。期间系统照常使用；`
      + "补齐后，长期目标、里程碑草稿与建议的可用时段按新信息更新。",
    options: [{ id: "open", label: "回到访谈", href: "/onboarding", recommended: true }] }, ...questions];
}

/**
 * A fixed arrangement the person confirmed (a class, an office hour, an exam with a time) that their own calendar does not hold: offered
 * for the Crossline calendar once the interview is done or its report exists. A recurring one becomes one repeating series, a one-off one
 * event. At most four open at a time, soonest first.
 */
function eventAsks({ ctx, today }: Source): Ask[] {
  return eventProposals(ctx).slice(0, 4).map((event) => {
    const kind = event.repeat ? "周期性" : "一次性";
    const first = event.repeat ? undefined : event.date;
    return { id: `event:${event.id}`, kind: "event_propose" as const, entityId: event.id, urgency: first ? urgencyFor(first, today) : "later" as const,
      ...(first ? { dueDay: first } : {}), ...(event.lineId ? { line: event.lineId } : {}), raisedAt: "", fingerprint: event.id,
      title: `日历中没有「${short(event.title, 24)}」，要创建吗？`,
      why: `${kind}日程：${describeEvent(event)}${event.location ? `，${event.location}` : ""}；来自${event.source === "interview" ? "访谈中的口述" : "上传的文件"}，`
        + "在已同步的日历里没有找到。创建后写入 Crossline 日历——" + (event.repeat ? "作为一个每周重复的系列，" : "作为单个事件，")
        + "提前 10 分钟提醒；排程本来就会绕开这段时间。",
      options: [{ id: "create", label: "创建", recommended: true }, { id: "exists", label: "已在别的日历里", detail: "不再提醒" },
        { id: "skip", label: "不需要", detail: "不写入日历" }] };
  });
}

/**
 * Background work the worker paused for this workspace (`BACKGROUND_BLOCKER`): an unreadable quota (an API-key login reports no
 * windows) or a spent one. It used to stop with nothing said, so captures sat unanalysed while the page looked normal. A worker that is
 * down is its own ask (`runtimeAsk`), not this one.
 */
function backgroundAsks({ store, ctx }: Source): Ask[] {
  const paused = readFailure(store, ctx.workspaceId, BACKGROUND_BLOCKER) as ({ resetsAt?: string; reason?: string } & NonNullable<ReturnType<typeof readFailure>>) | null;
  if (!paused || paused.reason === "CODEX_SUPERVISOR_UNAVAILABLE") return [];
  const until = paused.resetsAt ? `，预计 ${paused.resetsAt.slice(5, 16).replace("T", " ")}（UTC）恢复` : "";
  return [{ id: `background:${paused.code}`, kind: "background_paused", entityId: "background", urgency: "soon", raisedAt: paused.at,
    fingerprint: paused.code, title: "后台自动工作已暂停",
    why: `${clause(paused.message)}${until}。新收集的事项会在恢复后自动分析；需要现在处理的可以在任务页手动点「分析」。`,
    options: [{ id: "settings", label: "去看额度", href: "/settings#usage", recommended: true }] }];
}

export function collectAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const source = { store: getStore(), ctx, today: planToday(ctx, now), now };
  return [backplanAsks, waitingAsks, captureAsks, materialsAsks, gateAsks, riskAsks, missedAsks, agentAsks, calendarAsks, sourceProjectAsks, calendarLineAsks, interviewAsks, eventAsks, stepQuestionAsks,
    ({ ctx: context, now: at }: Source) => relationCheckAsks(context, at), backgroundAsks]
    .flatMap((collect) => { try { return collect(source); } catch { return []; } });
}

/**
 * What a task's step plan could not read from the person's material or facts (decided 2026-10-09): the exam's scope, what they already
 * master, the format of the deliverable. Asked here with the plan's own options; the answer is a confirmed fact every later plan reads,
 * and the task is planned again with it.
 */
function stepQuestionAsks({ store, ctx, today }: Source): Ask[] {
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).filter((order) => ["approved", "preparing", "ready_for_human", "active"].includes(order.state))
    .map((order) => [order.id, order]));
  const answered = new Set(store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT)).map((fact) => `${fact.projectId}|${fact.slot}`));
  return store.listStepPlans(ctx.workspaceId).flatMap((plan) => {
    const order = orders.get(plan.workOrderId);
    if (!order) return [];
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate;
    return plan.questions.filter((question) => !answered.has(`${order.projectId}|${stepAnswerSlot(question.text)}`)).map((question): Ask => ({
      id: `stepq:${order.id}:${stepAnswerSlot(question.text)}`, kind: "step_question", entityId: order.id, line: order.identityId,
      urgency: urgencyFor(due, today), ...(due ? { dueDay: due } : {}), raisedAt: plan.plannedAt, fingerprint: `${plan.version}:${question.text}`,
      title: `「${short(taskTitleOf(order), 24)}」：${question.text}`,
      why: `${question.why ? `${clause(question.why)}。` : ""}回答后，这个任务的步骤会按回答重新安排；材料里已有的信息不会再问。`,
      options: [...question.options.map((option, index) => ({ id: `o${index}`, label: option,
        fields: [{ id: "other", label: "补充", kind: "text" as const, required: false, placeholder: "可不填" }] })),
        { id: "free", label: "都不是，我来写", fields: [{ id: "other", label: "回答", kind: "text" as const, required: true }] }]
    }));
  });
}

function snoozes(ctx: AccessContext): AskSnooze[] {
  return live(ctx, getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" })).map((event) => event.payload as AskSnooze);
}

/**
 * The open asks: snoozed ones left out, most urgent first, then the most important milestone's. Each carries `entersOn` when it is not
 * this week's decision (`lib/horizon.ts`); callers that show this week's decisions use `thisWeek`.
 */
export function openAsks(ctx: AccessContext, now = new Date()): Ask[] {
  return rankAsks(decisionHorizon(ctx, now).annotate(collectAsks(ctx, now)), snoozes(ctx), planToday(ctx, now));
}
export const thisWeek = (asks: Ask[]) => asks.filter((ask) => !ask.entersOn);

let runtimeCheck: { at: number; ask: Ask | null } | undefined;

/**
 * Whether the AI can work at all: signed in, and the worker running. Asked over the network, so only pages call it
 * (cached a minute, given two and a half seconds) — the badge counts the ledger-only asks.
 */
async function runtimeAsk(ctx: AccessContext, now: Date): Promise<Ask | null> {
  if (runtimeCheck && now.getTime() - runtimeCheck.at < 60_000) return runtimeCheck.ask;
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500));
  const account = await Promise.race([requestCodexSupervisor<{ account?: unknown }>(ctx, "/v1/codex/account")
    .then((value) => ({ ok: true as const, value })).catch(() => ({ ok: false as const })), timeout]);
  const base = { entityId: "codex", urgency: "soon" as const, raisedAt: now.toISOString(), options: [{ id: "settings", label: "去设置", href: "/settings" }] };
  const ask: Ask | null = account === "timeout" || !account.ok
    ? { ...base, id: "runtime:worker", kind: "codex_signed_out", fingerprint: "worker", title: "后台没在运行",
      why: "自动分析、倒推、材料准备、验收与提醒均由后台服务执行，当前无法连接；已收集的内容不受影响。重启本机服务后恢复。" }
    : !account.value.account
      ? { ...base, id: "runtime:signed-out", kind: "codex_signed_out", fingerprint: "signed-out", title: "模型服务未登录，自动功能已暂停",
        why: "模型服务未登录，自动分析、倒推、材料准备与验收均暂停；在「设置」中登录后恢复。" }
      : null;
  runtimeCheck = { at: now.getTime(), ask };
  return ask;
}

/** What Today and 待确认 show: the ledger's asks plus whether the AI can run at all. */
export async function loadAsks(ctx: AccessContext, now = new Date()): Promise<Ask[]> {
  const runtime = process.env.CROSSLINE_E2E_DATA_DIR || process.env.VITEST ? null : await runtimeAsk(ctx, now);
  return rankAsks(decisionHorizon(ctx, now).annotate([...(runtime ? [runtime] : []), ...collectAsks(ctx, now)]), snoozes(ctx), planToday(ctx, now));
}

export type AskResult = { ok: true } | { ok: false; code: string };

function record(ctx: AccessContext, type: string, entityId: string, key: string, payload: Record<string, unknown>) {
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: key, type, entityId, payload });
}

/**
 * Takes the step that was getting a missing input out of the plan (the person has it, or is already waiting for it),
 * and lets the steps that waited on that step stand on their own. Only steps nobody has started are touched.
 * Returns the steps that depended on it.
 */
function releaseAcquisition(ctx: AccessContext, milestoneId: string, inputsFrom: string, inputId: string, reason: string): string[] {
  const store = getStore();
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.milestoneId === milestoneId);
  const started = new Set(store.listExecutions(ctx.workspaceId).map((execution) => execution.workOrderId));
  const acquiring = new Set(orders.filter((order) => {
    const backplan = (order.payload as { backplan?: { inputsFrom?: string; acquires?: string } }).backplan;
    return backplan?.inputsFrom === inputsFrom && backplan.acquires === inputId && UNTOUCHED.has(order.state) && !started.has(order.id);
  }).map((order) => order.id));
  const dependents: string[] = [];
  for (const order of orders) {
    const dependsOn = (order.payload as { dependsOn?: string[] }).dependsOn ?? [];
    if (!dependsOn.some((id) => acquiring.has(id))) continue;
    store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), dependsOn: dependsOn.filter((id) => !acquiring.has(id)) } });
    dependents.push(order.id);
  }
  for (const id of acquiring) archiveWorkOrder(ctx, id, reason);
  return dependents;
}

function rerunBackplan(ctx: AccessContext, milestoneId: string) {
  record(ctx, "goal.backplan_rerun_requested", milestoneId, `goal:backplan:rerun:${milestoneId}:${Date.now()}`, {});
  requestAutoBackplan(ctx);
}

function answerBackplan(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>): AskResult {
  const store = getStore();
  const [, eventId, inputId] = ask.id.split(":") as [string, string, string];
  const milestoneId = ask.entityId;
  const milestone = store.listMilestones(ctx.workspaceId).find((item) => item.id === milestoneId && item.status === "approved");
  if (!milestone) return { ok: false, code: "MILESTONE_NOT_APPROVED" };
  const event = store.listEvents(ctx.workspaceId, { type: "goal.backplan_blocked", entityId: milestoneId }).find((item) => item.eventId === eventId);
  const input = missingInputsOf(event?.payload).find((item) => item.id === inputId);
  const resolve = (how: string, id = ask.id) => record(ctx, "goal.backplan_input_resolved", milestoneId, `goal:backplan:resolved:${id}`, { askId: id, how });
  if (optionId === "skip") {
    const started = new Set(store.listExecutions(ctx.workspaceId).map((execution) => execution.workOrderId));
    for (const order of store.listWorkOrders(ctx.workspaceId).filter((item) => item.milestoneId === milestoneId
      && (item.payload as { backplan?: unknown }).backplan && UNTOUCHED.has(item.state) && !started.has(item.id)))
      archiveWorkOrder(ctx, order.id, "本人选择暂不拆分该里程碑");
    record(ctx, "goal.backplan_declined", milestoneId, `goal:backplan:declined:${milestoneId}:${milestone.version}`, { milestoneVersion: milestone.version });
    return { ok: true };
  }
  if (optionId === "retry") { resolve("retry"); rerunBackplan(ctx, milestoneId); return { ok: true }; }
  if (!input) return { ok: false, code: "ASK_STALE" };
  if (optionId === "ask_first") { resolve("will_obtain"); return { ok: true }; }
  if (optionId === "have") {
    releaseAcquisition(ctx, milestoneId, eventId, inputId, "该输入已由本人提供");
    record(ctx, "goal.backplan_input_supplied", milestoneId, `goal:backplan:supplied:${ask.id}`, { what: input.what, text: values.text, askId: ask.id });
    resolve("supplied");
    rerunBackplan(ctx, milestoneId);
    return { ok: true };
  }
  if (optionId === "waiting") {
    const dependents = releaseAcquisition(ctx, milestoneId, eventId, inputId, "该输入已在等待中");
    const index = waitingIndex(store, ctx.workspaceId);
    const existing = index.open.find((item) => index.sameWait(item, values.who ?? "", values.date!, `${milestone.identityId}/${milestone.projectId ?? ""}`));
    const waitingId = existing?.id ?? `wait-bp-${milestoneId}-${eventId.slice(0, 8)}-${inputId}`;
    if (existing) store.addWaitingBlocks(ctx.workspaceId, existing.id, dependents, ctx.principalId);
    else store.saveWaitingItem({ id: waitingId, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      title: input.what, who: values.who ?? "", expectedAt: values.date!, approximate: true, followUpAt: values.date!, state: "open",
      blocks: dependents, source: "backplan" });
    record(ctx, "goal.backplan_input_waiting", milestoneId, `goal:backplan:waiting:${ask.id}`, { waitingId, askId: ask.id, what: input.what });
    resolve("waiting");
    return { ok: true };
  }
  return { ok: false, code: "ASK_OPTION_UNKNOWN" };
}

async function answerOne(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>): Promise<AskResult> {
  const store = getStore();
  switch (ask.kind) {
    case "backplan_input": return answerBackplan(ctx, ask, optionId, values);
    case "waiting_due": {
      const index = waitingIndex(store, ctx.workspaceId);
      const item = index.open.find((row) => row.id === ask.entityId);
      if (!item) return { ok: false, code: "WAITING_ITEM_NOT_FOUND" };
      const answer = optionId === "deferred" ? { kind: "deferred" as const, followUpAt: values.date! }
        : optionId === "cancelled" ? { kind: "cancelled" as const } : { kind: "arrived" as const };
      // The same wait recorded twice is answered once: its twins follow, or the second would be asked about again.
      const twins = index.withTwins(item);
      const result = answerWaiting(ctx, item.id, answer);
      if (!result.ok) return result;
      for (const twin of twins.slice(1)) answerWaiting(ctx, twin.id, answer);
      // Each milestone is handed the input under the name it asked for it by.
      const handOver = new Map(twins.flatMap((twin) => index.inputsOf(twin)));
      if (optionId === "arrived" && handOver.size) {
        for (const [milestoneId, what] of handOver) {
          record(ctx, "goal.backplan_input_supplied", milestoneId, `goal:backplan:supplied:${ask.id}:${milestoneId}`,
            { what, text: values.note || `已从${item.who || "对方"}那里收到`, askId: ask.id });
          record(ctx, "goal.backplan_rerun_requested", milestoneId, `goal:backplan:rerun:${milestoneId}:${Date.now()}`, {});
        }
        requestAutoBackplan(ctx);
      }
      return result;
    }
    case "capture_blocked": {
      if (optionId === "discard") return discardCapture(ctx, ask.entityId, values.reason!);
      try { store.addCaptureContext(ctx.workspaceId, ask.entityId, values.note!); }
      catch (error) { return { ok: false, code: error instanceof Error ? error.message : "CAPTURE_NOTE_FAILED" }; }
      // Started, not awaited: the analysis takes a minute or more and the page only needs to know it was asked for.
      requestCodexSupervisor(ctx, `/v1/captures/${ask.entityId}/analyze`, { method: "POST", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(40_000) }).catch(() => {});
      return { ok: true };
    }
    case "materials_blocked": return optionId === "retry" ? retryMaterialPreparation(ctx, ask.entityId) : markMaterialsReady(ctx, ask.entityId, "human");
    case "gate_insufficient": return optionId === "drop" ? archiveWorkOrder(ctx, ask.entityId, values.reason!) : approveWorkOrderProposal(ctx, ask.entityId);
    case "gate_failed": {
      record(ctx, "milestone_gate.retry_requested", ask.entityId, `milestone-gate:retry:${ask.entityId}:${Date.now()}`, { requestedBy: ctx.principalId });
      await requestCodexSupervisor(ctx, `/v1/work-orders/${ask.entityId}/milestone-gate`, { method: "POST", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      return { ok: true };
    }
    case "evidence_manual": return acceptWorkOrderEvidence(ctx, ask.entityId);
    case "milestone_risk": {
      if (optionId === "extend") {
        const settings = readGoalSettings(ctx, ask.entityId);
        return saveGoalSettings(ctx, ask.entityId, { importance: settings?.importance ?? "ordinary", confirmedDeadline: values.date!,
          sourceQuote: "在「可能赶不上」的询问里推迟" });
      }
      const goal = loadGoalForecast(ctx).goals.find((item) => item.milestoneId === ask.entityId);
      record(ctx, "risk.accepted", ask.entityId, `risk:accepted:${ask.entityId}:${Date.now()}`, { slackDays: goal?.slackDays ?? -999, p85Day: goal?.p85Day ?? null });
      return { ok: true };
    }
    case "missed_block": {
      const handled = () => record(ctx, "missed.handled", ask.entityId, `missed:handled:${ask.id}:${Date.now()}`, { askId: ask.id, how: optionId });
      if (optionId === "drop") { const result = archiveWorkOrder(ctx, ask.entityId, values.reason!); if (result.ok) handled(); return result; }
      if (optionId === "later") {
        const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === ask.entityId);
        if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
        // The planner already honours `notBefore` (a release date): nothing is placed before it.
        store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), notBefore: values.date } });
      }
      handled();
      return { ok: true };
    }
    case "agent_blocked":
      record(ctx, "agent.blocked_acknowledged", ask.entityId, `agent:blocked:ack:${ask.entityId}:${Date.now()}`, {});
      return { ok: true };
    case "calendar_publish_failed":
      getStore().setSetting(ctx.workspaceId, CALENDAR_PUBLISH_FAILURE, "");
      forgetPublishedHash(ctx.workspaceId);
      void autoPublishPass().catch(() => {});
      return { ok: true };
    case "step_question": {
      const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === ask.entityId);
      const plan = order ? store.getStepPlan(ctx.workspaceId, order.id) : undefined;
      const question = plan?.questions.find((item) => ask.id.endsWith(stepAnswerSlot(item.text)));
      if (!order || !question) return { ok: false, code: "STEP_QUESTION_GONE" };
      const option = ask.options.find((item) => item.id === optionId);
      const answer = [option && option.id !== "free" ? option.label : "", (values.other ?? "").trim()].filter(Boolean).join("；");
      if (!answer) return { ok: false, code: "STEP_ANSWER_EMPTY" };
      store.upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: order.identityId, projectId: order.projectId, slot: stepAnswerSlot(question.text),
        value: `【${question.text}】${answer}`, status: "confirmed", sourceRef: "ask", sourceQuote: answer, updatedAt: new Date().toISOString() });
      requestStepReplan(ctx, order.id, `本人回答了「${question.text}」：${answer}。按此重新安排步骤。`);
      return { ok: true };
    }
    case "interview_question": {
      const result = await answerInterviewQuestion(ctx, ask.entityId, optionId === "free" ? "" : optionId, values.other ?? "", async (sessionId, text) => {
        // The round is complete: it goes to the interview as the person's reply; the next round's questions follow when it answers.
        void requestCodexSupervisor(ctx, "/v1/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, text }), signal: AbortSignal.timeout(3 * 60 * 60_000) }).catch(() => undefined);
      });
      return result.ok ? { ok: true } : result;
    }
    case "source_project": {
      if (optionId === "none") { record(ctx, "source.project_cleared", ask.entityId, `source:cleared:${ask.entityId}:${Date.now()}`, { by: "person" }); return { ok: true }; }
      const projectId = optionId.slice(2);
      if (!store.listProjects(ctx.workspaceId).some((project) => project.id === projectId)) return { ok: false, code: "PROJECT_NOT_FOUND" };
      store.assignSourceDocumentProject(ctx.workspaceId, ask.entityId, projectId);
      record(ctx, "source.project_assigned", ask.entityId, `source:assigned:${ask.entityId}:${projectId}:${Date.now()}`, { projectId, by: "person" });
      return { ok: true };
    }
    case "event_propose": {
      decideEvent(ctx, ask.entityId, optionId === "create" ? "create" : optionId === "exists" ? "exists" : "skip");
      // Written now rather than at the next ten-minute pass, so the person sees it on their calendar while they are here.
      if (optionId === "create") void publishFixedEvents(ctx).catch(() => undefined);
      return { ok: true };
    }
    case "calendar_line_unclear": {
      const lineId = optionId === "none" ? "" : optionId.slice(2);
      if (lineId && !identityLines(ctx).some((line) => line.id === lineId)) return { ok: false, code: "LINE_NOT_FOUND" };
      const filing: CalendarLines = calendarFiling(ctx);
      filing.entries[ask.entityId] = { lineId, why: "本人确认", at: new Date().toISOString(), by: "person" };
      store.setSetting(ctx.workspaceId, CALENDAR_LINES, JSON.stringify(filing));
      return { ok: true };
    }
    case "relation_check": return answerRelationCheck(ctx, ask, optionId, values);
    default: return { ok: false, code: "ASK_NOT_ANSWERABLE" };
  }
}

/** Carries out the person's answer to one ask, recording that they answered (the system's own cost, counted on 系统体检). */
export async function answerAsk(ctx: AccessContext, askId: string, optionId: string, values: Record<string, unknown>, now = new Date()): Promise<AskResult> {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  const checked = validateAskAnswer(ask, optionId, values);
  if (!checked.ok) return checked;
  const option = ask.options.find((item) => item.id === optionId)?.label ?? optionId;
  const result = await withUndo(ctx, `${option}：${ask.title}`, () => answerOne(ctx, ask, optionId, checked.values));
  if (result.ok) record(ctx, "ask.answered", ask.entityId, `ask:answered:${ask.id}:${optionId}:${now.getTime()}`, { askId: ask.id, kind: ask.kind, optionId });
  return result;
}

/** 「明天再问」/「下周再问」: hidden until then, back sooner if what it is about changes. */
export function snoozeAsk(ctx: AccessContext, askId: string, choice: "tomorrow" | "week", now = new Date()): AskResult {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  const until = snoozeUntil(choice, planToday(ctx, now));
  // Recorded as an operation, so 「明天再问」 pressed by mistake can be undone like any other answer.
  const before = new Set(getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).map((event) => event.eventId));
  record(ctx, "ask.snoozed", ask.entityId, `ask:snoozed:${ask.id}:${now.getTime()}`,
    { askId: ask.id, until, fingerprint: ask.fingerprint } satisfies AskSnooze);
  const added = getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).filter((event) => !before.has(event.eventId)).map((event) => event.eventId);
  if (added.length) recordOp(ctx, `${choice === "tomorrow" ? "明天再问" : "下周再问"}：${ask.title}`, { kind: "event.retract", eventIds: added });
  return { ok: true };
}

/**
 * Writes what is waiting for the person where the worker's notifications read it, so the morning brief, the badge and
 * an urgent message all count the same things. Called on the web's own timer.
 */
export function writeAttentionSnapshot(ctx: AccessContext, pending: number, now = new Date()): void {
  const asks = openAsks(ctx, now).map((ask) => ({ id: ask.id, title: ask.title, urgency: ask.urgency, dueDay: ask.dueDay ?? null,
    path: ask.urgency === "now" ? "/" : "/approvals#asks" }));
  getStore().setSetting(ctx.workspaceId, ATTENTION_SNAPSHOT, JSON.stringify({ at: now.toISOString(), pending, asks }));
}
