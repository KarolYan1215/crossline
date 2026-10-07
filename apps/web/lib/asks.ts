import "server-only";
import {
  ATTENTION_SNAPSHOT, CALENDAR_PUBLISH_FAILURE, CALENDAR_SYNC_FAILURE, daysBetween, missingInputsOf, rankAsks, snoozeUntil, urgencyFor,
  validateAskAnswer, type AccessContext, type Ask, type AskOption, type AskSnooze
} from "@crossline/core";
import { listAgentTasks, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import {
  acceptWorkOrderEvidence, answerWaiting, approveWorkOrderProposal, archiveWorkOrder, discardCapture, getStore, loadGoalForecast,
  markMaterialsReady, planToday, readGoalSettings, retryMaterialPreparation, saveGoalSettings
} from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { requestCodexSupervisor } from "./codex-runtime";
import { autoPublishPass, forgetPublishedHash } from "./auto-publish";

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

type Source = { store: ReturnType<typeof getStore>; ctx: AccessContext; today: string };

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
    const dueDay = anchors.get(milestoneId);
    const base = { entityId: milestoneId, line: milestone.identityId, raisedAt: event.createdAt, fingerprint: event.eventId,
      urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}) };
    const missing = missingInputsOf(event.payload);
    const skip: AskOption = { id: "skip", label: "这个里程碑先不拆", detail: "撤掉它还没开始的自动步骤，这一版不再自动倒推" };
    if (!missing.length) {
      const id = `bp:${event.eventId}:all`;
      if (resolved.has(id)) continue;
      asks.push({ ...base, id, kind: "backplan_input", title: `「${short(milestone.title)}」没能自动拆出步骤`,
        why: `自动倒推停在这里：${payload.message || payload.code}。可以让它再试一次，或者你自己写下第一步。`,
        options: [{ id: "retry", label: "再试一次", recommended: true }, { id: "own", label: "我自己写第一步", href: "/#capture-title" }, skip] });
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
        why: `自动倒推这个里程碑时发现：${input.message}${acquiring ? " 我先把「拿到它」排成了第一步（等你批准）。" : " 没有它，后面的步骤只能靠猜。"}你现在的情况是？`,
        options: [
          { id: "have", label: "我有，现在给你", detail: "贴内容或写存放位置，系统带着它重新拆",
            fields: [{ id: "text", label: "内容或存放位置（文件路径、链接、要点）", kind: "longtext", required: true }] },
          { id: "waiting", label: "已经要了，在等", detail: "到那天问你到了没；在那之前依赖它的步骤不排",
            fields: [{ id: "who", label: "谁给", kind: "text", required: false, initial: input.whoHas },
              { id: "date", label: "大约哪天到", kind: "date", required: true }] },
          acquiring ? { id: "ask_first", label: "还没要，就按第一步去要", detail: "保留「拿到它」这一步", recommended: true }
            : { id: "ask_first", label: "我自己去弄", detail: "记下了，不再问", recommended: true },
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
    title: `「${short(capture.title)}」没能自动拆解`,
    why: `${capture.audit.blocker?.message || capture.audit.blocker?.code || "分析停下了"}。补一句说明，系统会带着它重新分析。`,
    options: [
      { id: "context", label: "补充说明，重新分析", recommended: true,
        fields: [{ id: "note", label: "补充什么（要交付什么、为谁、哪天前、手上有什么材料）", kind: "longtext" as const, required: true }] },
      { id: "manual", label: "我自己建成任务", href: "/workbench" },
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
      title: `「${short(order.intent)}」的材料没准备成`,
      why: `${detail.message || detail.code || "准备停下了"}。可以再试一次，或者不等材料直接开始。`,
      options: [
        { id: "retry", label: "再试一次", recommended: /^(SKILL_|CODEX_)/.test(detail.code ?? "") },
        { id: "self", label: "不用材料了，我直接做", recommended: !/^(SKILL_|CODEX_)/.test(detail.code ?? "") },
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
        title: `「${short(order.intent)}」没通过验收`,
        why: needs.length ? `验收判断还差：${needs.join("；")}。补上后重新提交，会再判一次。` : "验收判断证据不够。补上后重新提交，会再判一次。",
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
          fingerprint: failure.eventId, title: `「${short(order.intent)}」的验收没跑成`,
          why: `这不是判你没通过，是判定本身没完成：${detail.message || detail.code}。处理好之后让它再判一次。`,
          options: [{ id: "rejudge", label: "现在重新判定", recommended: true },
            { id: "look", label: "去看看", href: `/workbench/${encodeURIComponent(order.id)}` }] });
      } else if (!order.milestoneId) {
        asks.push({ id: `accept:${order.id}`, kind: "evidence_manual", entityId: order.id, ...timing, raisedAt: "", fingerprint: order.state,
          title: `「${short(order.intent)}」等你验收`, why: "它没挂在里程碑上，没有自动验收，交付算不算数由你说了算。",
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
  const parts = [`截止 ${format(input.deadline)}（还剩 ${left} 天）。已拆出的 ${input.steps} 步还要约 ${hours(input.p50Minutes)}–${hours(input.p85Minutes)} 小时。`];
  if (!input.p85Day) parts.push("按你现在的可用时间和排在它前面的工作，八周内排不完它（或者它等的前置步骤还没做完）。");
  else {
    const late = input.slackDays !== null && input.slackDays < 0;
    parts.push(`按你现在的可用时间和排在它前面的工作，顺利的话 ${input.p50Day ? format(input.p50Day) : "—"} 做完，不顺（按保守估时）要到 ${format(input.p85Day)}`
      + (late ? `，比截止晚 ${-input.slackDays!} 天。` : input.slackDays === 0 ? "，正好卡在截止那天，没有余地。" : `，只比截止早 ${input.slackDays} 天，留给意外的余地不到 2 天。`));
  }
  if (input.moreToSplit) parts.push("这还只算了已经拆出来的步骤，后面还有没拆的，实际会更紧。");
  parts.push("这是按已知工作的预测，不是判决；你可以给它加时间、推迟截止、降低标准，或者接受这个风险。");
  return parts.join("");
}

const ACCEPT_RISK_DAYS = 7;

/** A milestone whose known work finishes too close to (or after) its deadline. Tability's three-check rule, as a question. */
function riskAsks({ store, ctx, today }: Source): Ask[] {
  const forecast = loadGoalForecast(ctx);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const accepted = store.listEvents(ctx.workspaceId, { type: "risk.accepted" });
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

function agentAsks({ store, ctx }: Source): Ask[] {
  const acknowledged = new Set(store.listEvents(ctx.workspaceId, { type: "agent.blocked_acknowledged" }).map((event) => event.entityId));
  const titles = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.intent]));
  return listAgentTasks(store, ctx.workspaceId).filter((task) => task.status === "blocked" && !acknowledged.has(task.taskId)).map((task) => ({
    id: `agent:${task.taskId}`, kind: "agent_blocked" as const, entityId: task.taskId, urgency: "later" as const, raisedAt: task.requestedAt,
    fingerprint: task.blockerCode, title: `助手没做成「${short(titles.get(task.workOrderId) ?? task.title)}」`,
    why: `${task.blockerMessage || task.blockerCode}。它不会自己再试；这件事回到你手上。`,
    options: [{ id: "self", label: "知道了，我自己做", recommended: true }, { id: "look", label: "去看它做到哪了", href: "/assistant" }] }));
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
      ? "写入用的账号登录过期了。在本机运行 pnpm exec tsx scripts/graph-write-login.ts 重新登录（只写名为 Crossline 的日历，你的其他日历不会被动），然后点重试。"
      : `${publish.message || publish.code}。你的其他日历没有被动。`,
    options: [{ id: "retry", label: "处理好了，现在重试", recommended: true }] });
  const sync = readFailure(store, ctx.workspaceId, CALENDAR_SYNC_FAILURE);
  if (sync) asks.push({ id: `sync:${sync.code}:${(sync.sources ?? []).join(",")}`, kind: "calendar_sync_failed", entityId: "calendar",
    urgency: "soon", raisedAt: sync.at, fingerprint: sync.code,
    title: sync.sources?.length ? `读不到日历：${sync.sources.join("、")}` : "读不到你的日历了",
    why: `${sync.message || sync.code}。在恢复之前，排程照常用最后一次读到的日程；账号登出需要重新登录。`,
    options: [{ id: "settings", label: "去设置看连接", href: "/settings" }] });
  return asks;
}

/** Everything the ledger alone can tell, unranked. Synchronous, so the badge can count it on every page. */
export function collectAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const source = { store: getStore(), ctx, today: planToday(ctx, now) };
  return [backplanAsks, waitingAsks, captureAsks, materialsAsks, gateAsks, riskAsks, agentAsks, calendarAsks]
    .flatMap((collect) => { try { return collect(source); } catch { return []; } });
}

function snoozes(ctx: AccessContext): AskSnooze[] {
  return getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).map((event) => event.payload as AskSnooze);
}

/** The asks to show now: snoozed ones left out, most urgent first. */
export function openAsks(ctx: AccessContext, now = new Date()): Ask[] {
  return rankAsks(collectAsks(ctx, now), snoozes(ctx), planToday(ctx, now));
}

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
      why: "自动拆解、倒推、准备材料、验收和提醒都由后台进程做，现在连不上它。重新运行 scripts/start-crossline.ps1 即可；你记下的东西都在。" }
    : !account.value.account
      ? { ...base, id: "runtime:signed-out", kind: "codex_signed_out", fingerprint: "signed-out", title: "AI 未登录，自动的事都停着",
        why: "Codex 没有登录，所以自动拆解、倒推、准备材料和验收都不会发生。去「设置」里登录一次就好。" }
      : null;
  runtimeCheck = { at: now.getTime(), ask };
  return ask;
}

/** What Today and 待确认 show: the ledger's asks plus whether the AI can run at all. */
export async function loadAsks(ctx: AccessContext, now = new Date()): Promise<Ask[]> {
  const runtime = process.env.CROSSLINE_E2E_DATA_DIR || process.env.VITEST ? null : await runtimeAsk(ctx, now);
  return rankAsks([...(runtime ? [runtime] : []), ...collectAsks(ctx, now)], snoozes(ctx), planToday(ctx, now));
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
      archiveWorkOrder(ctx, order.id, "你说这个里程碑先不拆");
    record(ctx, "goal.backplan_declined", milestoneId, `goal:backplan:declined:${milestoneId}:${milestone.version}`, { milestoneVersion: milestone.version });
    return { ok: true };
  }
  if (optionId === "retry") { resolve("retry"); rerunBackplan(ctx, milestoneId); return { ok: true }; }
  if (!input) return { ok: false, code: "ASK_STALE" };
  if (optionId === "ask_first") { resolve("will_obtain"); return { ok: true }; }
  if (optionId === "have") {
    releaseAcquisition(ctx, milestoneId, eventId, inputId, "你已经提供了这项输入");
    record(ctx, "goal.backplan_input_supplied", milestoneId, `goal:backplan:supplied:${ask.id}`, { what: input.what, text: values.text, askId: ask.id });
    resolve("supplied");
    rerunBackplan(ctx, milestoneId);
    return { ok: true };
  }
  if (optionId === "waiting") {
    const dependents = releaseAcquisition(ctx, milestoneId, eventId, inputId, "你已经在等这项输入");
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
    case "agent_blocked":
      record(ctx, "agent.blocked_acknowledged", ask.entityId, `agent:blocked:ack:${ask.entityId}`, {});
      return { ok: true };
    case "calendar_publish_failed":
      getStore().setSetting(ctx.workspaceId, CALENDAR_PUBLISH_FAILURE, "");
      forgetPublishedHash(ctx.workspaceId);
      void autoPublishPass().catch(() => {});
      return { ok: true };
    default: return { ok: false, code: "ASK_NOT_ANSWERABLE" };
  }
}

/** Carries out the person's answer to one ask, recording that they answered (the system's own cost, counted on 系统体检). */
export async function answerAsk(ctx: AccessContext, askId: string, optionId: string, values: Record<string, unknown>, now = new Date()): Promise<AskResult> {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  const checked = validateAskAnswer(ask, optionId, values);
  if (!checked.ok) return checked;
  const result = await answerOne(ctx, ask, optionId, checked.values);
  if (result.ok) record(ctx, "ask.answered", ask.entityId, `ask:answered:${ask.id}:${optionId}:${now.getTime()}`, { askId: ask.id, kind: ask.kind, optionId });
  return result;
}

/** 「明天再问」/「下周再问」: hidden until then, back sooner if what it is about changes. */
export function snoozeAsk(ctx: AccessContext, askId: string, choice: "tomorrow" | "week", now = new Date()): AskResult {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  record(ctx, "ask.snoozed", ask.entityId, `ask:snoozed:${ask.id}:${now.getTime()}`,
    { askId: ask.id, until: snoozeUntil(choice, planToday(ctx, now)), fingerprint: ask.fingerprint } satisfies AskSnooze);
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
