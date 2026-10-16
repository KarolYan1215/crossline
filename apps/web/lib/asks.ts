import "server-only";
import { recordOp, retractedEventIds, withUndo } from "./undo";
import {
  ATTENTION_SNAPSHOT, BACKGROUND_BLOCKER, CALENDAR_LINES, CALENDAR_PUBLISH_FAILURE, CALENDAR_SYNC_FAILURE, calendarEventKey, daysBetween, describeEvent, missingInputsOf, rankAsks,
  localStamp, prepStepRetried, readableFromMaterial, snoozeUntil, STEP_ANSWER_SLOT, stepAnswerSlot, taskTitleOf, urgencyFor, type CalendarLines,
  validateAskChoice, withFrozen, type AccessContext, type Ask, type AskField, type AskOption, type AskPreview, type AskSnooze,
  MILESTONE_RISK_KIND_LABEL, MILESTONE_RISK_LEVEL_LABEL, MILESTONE_RISKS_SETTING, milestoneRiskFingerprint, parseMilestoneRisks, riskBufferDays, riskCriteriaKeys, riskLevelOf
} from "@crossline/core";
import { listAgentTasks, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import {
  acceptWorkOrderEvidence, answerWaiting, appNow, approveWorkOrderProposal, archiveWorkOrder, discardCapture, effectiveSchedulePreferences, getStore, loadGoalForecast,
  markMaterialsReady, planToday, plannerIdOfBlock, readFrozen, readGoalSettings, retryMaterialPreparation, saveGoalSettings, TASK_LIBRARY_WINDOW_DAYS,
  heldConflicts, unlockBlock, writeFrozen, readRiskDecisions, RISK_DECISIONS_SETTING, type RiskDecision
} from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { readScheduledDay } from "./schedule-memory";
import { requestCodexSupervisor } from "./codex-runtime";
import { autoPublishPass, forgetPublishedHash } from "./auto-publish";
import { calendarFiling } from "./timeline";
import { answerInterviewQuestion, flushPendingAnswers, interviewStatus } from "./interview-status";
import { requestStepReplan } from "./steps";
import { unfiledFiles } from "./file-belonging";
import { decideEvent, eventProposals, publishFixedEvents } from "./fixed-events";
import { identityLines } from "./lines";
import { decisionHorizon } from "./horizon";
import { answerRelationCheck, relationCheckAsks } from "./artifact-relations";
import { agentBlockedAsks, answerAgentAsk } from "./agent-ask";
import { answerOutcome, outcomeAsks } from "./outcome-check";
import { answerProgress, progressAsks } from "./progress-check";
import { memoByLedger } from "./ledger-memo";
import { localeFor, tOf } from "./locale";
import { intlLocale, monthDay, tFor, type Locale, type Translate } from "./i18n";

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

type Source = { store: ReturnType<typeof getStore>; ctx: AccessContext; today: string; now: Date; t: Translate; locale: Locale };

/** What a question is about, to look at before answering (`Ask.preview`). */
const taskPreview = (t: Translate, orderId: string, label = t("看任务")): AskPreview => ({ kind: "task", href: `/workbench/${encodeURIComponent(orderId)}`, label });
const milestonePreview = (t: Translate, milestoneId: string, label = t("看里程碑")): AskPreview => ({ kind: "milestones", href: `/milestones?open=${encodeURIComponent(milestoneId)}`, label });
const filePreview = (t: Translate, documentId: string, label = t("打开文件")): AskPreview => ({ kind: "file", href: `/api/source-documents/${encodeURIComponent(documentId)}/file`, label });

function deadlines(store: Source["store"], workspaceId: string) {
  return new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
}
const dueOf = (order: StoredWorkOrder, anchors: Map<string, string>) =>
  (order.payload as { dueDate?: string } | undefined)?.dueDate ?? anchors.get(order.milestoneId);

/** A backplan the model refused, or split with missing inputs: one ask per missing thing it named. */
function backplanAsks({ store, ctx, today, t }: Source): Ask[] {
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
    const skip: AskOption = { id: "skip", label: t("暂不拆分该里程碑"), detail: t("撤回尚未开始的自动步骤，本版本不再自动倒推") };
    if (!missing.length) {
      const id = `bp:${event.eventId}:all`;
      if (resolved.has(id)) continue;
      // Important: until it is split, none of the milestone's work exists to be scheduled.
      asks.push({ ...base, id, kind: "backplan_input", important: true, preview: milestonePreview(t, milestoneId), title: t("「{{title}}」未能自动拆分", { title: short(milestone.title) }),
        why: t("自动倒推中止：{{reason}}。可重试，或手动填写第一步。", { reason: clause(payload.message || payload.code) }),
        options: [{ id: "retry", label: t("再试一次"), recommended: true }, { id: "own", label: t("手动填写第一步"), href: "/#capture-title" }, skip] });
      continue;
    }
    // Missing inputs are not asked about (docs/review-2026-10-13.md §11, the person's decision): the split run makes getting each one a
    // step of its own, and the person supplies it when they do that step. Asking as well was twelve decisions on the real account.
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
function waitingAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  const index = waitingIndex(store, ctx.workspaceId);
  const due = index.open.filter((item) => item.followUpAt <= today);
  // One card for one wait: an item whose twin is already asked about is answered with it.
  return due.filter((item, position) => !due.slice(0, position).some((earlier) => index.withTwins(earlier).includes(item))).map((item) => {
    const twins = index.withTwins(item);
    const forMilestone = twins.some((twin) => index.milestonesOf(twin).length);
    const blocks = new Set(twins.flatMap((twin) => twin.blocks)).size;
    // Important when work waits on it: the answer is what lets that work onto the calendar (or re-splits a milestone).
    const blocked = twins.flatMap((twin) => twin.blocks);
    return { id: `wait:${item.id}`, kind: "waiting_due" as const, entityId: item.id, urgency: "now" as const, dueDay: item.followUpAt,
      important: forMilestone || blocked.length > 0, ...(blocked[0] ? { preview: taskPreview(t, blocked[0], t("看等它的任务")) } : {}),
      raisedAt: item.updatedAt, fingerprint: item.followUpAt,
      title: item.who ? t("{{who}}的「{{title}}」到了吗？", { who: item.who, title: short(item.title, 50) }) : t("「{{title}}」到了吗？", { title: short(item.title, 50) }),
      why: (item.approximate ? t("原定大约 {{day}} 到。", { day: dayText(locale, item.expectedAt) }) : t("原定 {{day}} 到。", { day: dayText(locale, item.expectedAt) }))
        + (forMilestone ? t("到了以后系统会带着它重新拆这个里程碑的步骤。") : t("在它到之前，依赖它的 {{count}} 项工作不会排进日历。", { count: blocks })),
      options: [
        { id: "arrived", label: t("到了"), recommended: true, ...(forMilestone ? { detail: t("写一句放在哪、有什么，重拆更准"),
          fields: [{ id: "note", label: t("放在哪 / 要点（可选）"), kind: "longtext" as const, required: false }] } : { detail: t("依赖它的工作排上日历") }) },
        { id: "deferred", label: t("还没，推迟"), fields: [{ id: "date", label: t("推迟到"), kind: "date" as const, required: true }] },
        { id: "cancelled", label: t("不等了") }
      ] };
  });
}

/** A capture the analysis refused. One blocked for want of an approved milestone is not asked: approving one retries it. */
function captureAsks({ store, ctx, t }: Source): Ask[] {
  return store.listCaptures(ctx.workspaceId).filter((capture) => capture.state === "blocked"
    && capture.audit.blocker?.code !== "ANALYSIS_APPROVED_MILESTONE_REQUIRED").map((capture) => ({
    id: `cap:${capture.id}:${capture.attempt}`, kind: "capture_blocked" as const, entityId: capture.id, urgency: "later" as const,
    // The analysis needs the answer to go on; what is written in place is the context it is re-run with.
    important: true, preview: { kind: "task" as const, href: "/workbench", label: t("看收集的事项") },
    freeText: { placeholder: t("例如：交给导师的一页周报，周五组会前，手上有上周的实验数据") },
    raisedAt: store.listEvents(ctx.workspaceId, { entityId: capture.id }).at(-1)?.createdAt ?? "", fingerprint: String(capture.attempt),
    title: t("「{{title}}」未能自动分析", { title: short(capture.title) }),
    why: t("{{reason}}。补充说明后重新分析。", { reason: clause(capture.audit.blocker?.message || capture.audit.blocker?.code || t("分析中止")) }),
    options: [
      { id: "context", label: t("补充说明，重新分析"), recommended: true,
        fields: [{ id: "note", label: t("补充什么（要交付什么、为谁、哪天前、手上有什么材料）"), kind: "longtext" as const, required: true }] },
      { id: "manual", label: t("手动建立任务"), href: "/workbench" },
      { id: "discard", label: t("不要了"), fields: [{ id: "reason", label: t("为什么不要"), kind: "text" as const, required: true }] }
    ] }));
}

/** Last word wins over a materials trail: blocked unless a later retry asked again. */
function lastMaterialsBlock(events: ReturnType<ReturnType<typeof getStore>["listEvents"]>) {
  let last: (typeof events)[number] | undefined;
  for (const event of events) last = event.type === "materials.blocked" ? event : undefined;
  return last;
}

function materialsAsks({ store, ctx, today, t }: Source): Ask[] {
  const anchors = deadlines(store, ctx.workspaceId);
  const events = store.listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"] });
  return store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "preparing").flatMap((order) => {
    const block = lastMaterialsBlock(events.filter((event) => event.entityId === order.id));
    if (!block) return [];
    const detail = block.payload as { code?: string; message?: string };
    const dueDay = dueOf(order, anchors);
    // Important: the task waits in preparation until this is answered.
    return [{ id: `mat:${block.eventId}`, kind: "materials_blocked" as const, entityId: order.id, line: order.identityId, important: true, preview: taskPreview(t, order.id),
      urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}), raisedAt: block.createdAt, fingerprint: block.eventId,
      title: t("「{{title}}」材料未准备完成", { title: short(order.intent) }),
      why: t("{{reason}}。可重试，或不等材料直接开始。", { reason: clause(detail.message || detail.code || t("准备中止")) }),
      options: [
        { id: "retry", label: t("再试一次"), recommended: /^(SKILL_|CODEX_)/.test(detail.code ?? "") },
        { id: "self", label: t("不需要材料，直接开始"), recommended: !/^(SKILL_|CODEX_)/.test(detail.code ?? "") },
        { id: "look", label: t("去看缺什么"), href: `/workbench/${encodeURIComponent(order.id)}` }
      ] }];
  });
}

type GateReview = { verdict?: string; gaps?: Array<{ whatWouldSatisfyIt: string }>;
  criteriaVerdict?: Array<{ met: string; shortfall?: string }>; fit?: { fits: boolean; violated: string[]; why: string } };

/** The gate's own 「not enough」, and a gate run that did not happen — two different things, asked differently. */
function gateAsks({ store, ctx, today, t }: Source): Ask[] {
  const anchors = deadlines(store, ctx.workspaceId);
  const asks: Ask[] = [];
  const runFailures = new Map<string, ReturnType<typeof store.listEvents>[number]>();
  for (const event of store.listEvents(ctx.workspaceId, { type: ["milestone_gate.blocked", "milestone_gate.retry_requested"] })) {
    if (event.type === "milestone_gate.blocked") runFailures.set(event.entityId, event); else runFailures.delete(event.entityId);
  }
  for (const order of store.listWorkOrders(ctx.workspaceId)) {
    const dueDay = dueOf(order, anchors);
    const timing = { urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}), line: order.identityId, preview: taskPreview(t, order.id, t("看交付与判定")) };
    const review = (order.payload as { gateReview?: GateReview }).gateReview;
    if (order.state === "blocked" && review && review.verdict !== "pass") {
      const transition = store.listEvents(ctx.workspaceId, { type: "work_order.transitioned", entityId: order.id }).at(-1);
      const needs = [...(review.gaps ?? []).map((gap) => gap.whatWouldSatisfyIt),
        ...(review.criteriaVerdict ?? []).filter((item) => item.met !== "met" && item.shortfall).map((item) => item.shortfall!)]
        .filter(Boolean).slice(0, 3);
      // Covered its contract but not done the person's way (their line skill): the broken rules are the return note.
      const offPlay = review.verdict === "partial" && review.fit && !review.fit.fits;
      // Important when a milestone rests on it: its acceptance waits for the redo. Otherwise left to the milestone's weight.
      asks.push({ id: `gate:${transition?.eventId ?? order.id}`, kind: "gate_insufficient", entityId: order.id, ...timing, ...(order.milestoneId ? {} : { important: false }),
        raisedAt: transition?.createdAt ?? "", fingerprint: transition?.eventId ?? "",
        title: offPlay ? t("「{{title}}」不符合本人的打法", { title: short(order.intent) }) : t("「{{title}}」未通过验收", { title: short(order.intent) }),
        why: offPlay ? t("契约要求已覆盖，但违背了主线 skill：{{rules}}。", { rules: clause(review.fit!.violated.join(t("；"))) })
            + (review.fit!.why ? t("{{reason}}。", { reason: clause(review.fit!.why) }) : "") + t("改后重新提交即重新判定。")
          : needs.length ? t("验收尚缺：{{needs}}。补充后重新提交即重新判定。", { needs: clause(needs.join(t("；"))) }) : t("验收证据不足。补充后重新提交即重新判定。"),
        options: [
          { id: "redo", label: t("重新排上，补做缺的"), recommended: true },
          { id: "look", label: t("去看判定细节"), href: `/workbench/${encodeURIComponent(order.id)}` },
          { id: "drop", label: t("不做了"), fields: [{ id: "reason", label: t("为什么不做"), kind: "text", required: true }] }
        ] });
    }
    if (order.state === "evidence_review") {
      const failure = runFailures.get(order.id);
      if (order.milestoneId && failure) {
        const detail = failure.payload as { code?: string; message?: string };
        asks.push({ id: `gaterun:${failure.eventId}`, kind: "gate_failed", entityId: order.id, ...timing, raisedAt: failure.createdAt,
          fingerprint: failure.eventId, title: t("「{{title}}」验收判定未完成", { title: short(order.intent) }),
          why: t("判定过程中断，并非未通过：{{reason}}。处理后重新判定。", { reason: clause(detail.message || detail.code) }),
          options: [{ id: "rejudge", label: t("现在重新判定"), recommended: true },
            { id: "look", label: t("去看看"), href: `/workbench/${encodeURIComponent(order.id)}` }] });
      } else if (!order.milestoneId) {
        asks.push({ id: `accept:${order.id}`, kind: "evidence_manual", entityId: order.id, ...timing, raisedAt: "", fingerprint: order.state,
          title: t("「{{title}}」待验收", { title: short(order.intent) }), why: t("未关联里程碑，不经自动验收，由本人验收。"),
          options: [{ id: "accept", label: t("算数，验收"), recommended: true },
            { id: "look", label: t("先看看交付"), href: `/workbench/${encodeURIComponent(order.id)}` }] });
      }
    }
  }
  return asks;
}

/** 「10/17」 / "Oct 17". */
const format = (day: string, locale?: Locale) => locale === "en" ? monthDay(locale, day.slice(0, 10)) : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/** Items listed as each language lists them inline: 「A、B、C」 / "A, B, C". */
const listOf = (locale: Locale | undefined, items: string[]) => items.join(locale === "en" ? ", " : "、");
/** A waiting item's day: 「10-17」 as it always read, "Oct 17" in English. */
const dayText = (locale: Locale, day: string) => locale === "en" ? monthDay(locale, day.slice(0, 10)) : day.slice(5);

/**
 * Explains a milestone's risk in the person's terms: when it is due, how much known work is left, when that work
 * finishes if it goes well and if it does not, and by how much the second misses the margin. A forecast, not a verdict,
 * and only of the steps already split out — said so, because with rolling backplans there are usually more.
 */
export function explainRisk(input: { deadline: string; today: string; p50Day: string | null; p85Day: string | null; slackDays: number | null;
  steps: number; p50Minutes: number; p85Minutes: number; moreToSplit: boolean }, locale?: Locale): string {
  const t = tFor(locale);
  const left = daysBetween(input.today, input.deadline);
  const hours = (minutes: number) => Math.max(0.5, Math.round(minutes / 30) / 2);
  const join = locale === "en" ? " " : "";
  const parts = [t("截止 {{day}}（剩 {{count}} 天）。", { day: format(input.deadline, locale), count: left })
    + join + t("已拆分的 {{count}} 个步骤剩余约 {{low}}–{{high}} 小时。", { count: input.steps, low: hours(input.p50Minutes), high: hours(input.p85Minutes) })];
  if (!input.p85Day) parts.push(t("按当前可用时段与优先于它的工作，八周内无法排完（或前置步骤尚未完成）。"));
  else {
    const late = input.slackDays !== null && input.slackDays < 0;
    const values = { usual: input.p50Day ? format(input.p50Day, locale) : "—", cautious: format(input.p85Day, locale) };
    parts.push(late ? t("按当前可用时段与优先于它的工作，通常 {{usual}} 完成，保守估计 {{cautious}} 完成，比截止晚 {{count}} 天。", { ...values, count: -input.slackDays! })
      : input.slackDays === 0 ? t("按当前可用时段与优先于它的工作，通常 {{usual}} 完成，保守估计 {{cautious}} 完成，恰在截止当日，没有余量。", values)
      : t("按当前可用时段与优先于它的工作，通常 {{usual}} 完成，保守估计 {{cautious}} 完成，仅早于截止 {{count}} 天，余量不足 2 天。", { ...values, count: input.slackDays }));
  }
  if (input.moreToSplit) parts.push(t("仅计入已拆分的步骤；尚有未拆分的工作，实际更紧。"));
  parts.push(t("以上为基于已知工作的预测；可增加时间、推迟截止、降低标准，或接受该风险。"));
  return parts.join(join);
}

const ACCEPT_RISK_DAYS = 7;

/** A milestone whose known work finishes too close to (or after) its deadline. Tability's three-check rule, as a question. */
function riskAsks({ store, ctx, today, t, locale }: Source): Ask[] {
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
      preview: milestonePreview(t, goal.milestoneId),
      urgency: urgencyFor(deadline, today), dueDay: deadline, raisedAt: "", fingerprint: `${goal.p85Day}|${deadline}`,
      title: t("「{{title}}」可能赶不上 {{day}}", { title: short(milestone.title), day: format(deadline, locale) }),
      why: explainRisk({ deadline, today, p50Day: goal.p50Day, p85Day: goal.p85Day, slackDays: goal.slackDays, steps: own.length,
        p50Minutes: own.reduce((sum, order) => sum + order.estimate.p50Minutes, 0), p85Minutes: own.reduce((sum, order) => sum + order.estimate.p85Minutes, 0),
        moreToSplit: rolling.has(goal.milestoneId) }, locale),
      options: [
        { id: "time", label: t("加可用时间"), href: "/plan#availability" },
        { id: "extend", label: t("推迟截止"), fields: [{ id: "date", label: t("推迟到"), kind: "date" as const, required: true }] },
        { id: "lower", label: t("降低标准"), href: "/milestones" },
        { id: "accept", label: t("接受这个风险"), detail: t("{{count}} 天内不再问，除非变得更糟", { count: ACCEPT_RISK_DAYS }) }
      ] }];
  });
}

/**
 * A medium or high risk the reviewer found on an approved milestone (`milestones.risks`, `source: "model"`, current for the milestone as
 * it stands). It used to move the schedule silently; now it is put to the person first (the owner's decision of 2026-10-15), and only
 * 「接受，按风险提前安排」 lets the scheduler aim the milestone's work 1–2 days early (`riskBufferOf` in `lib/crossline.ts`). Asked once per
 * review: any answer is kept against the review's fingerprint, so a later review of an edited milestone asks again.
 */
function riskReviewAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  const stored = parseMilestoneRisks(store.getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING));
  const decisions = readRiskDecisions(ctx);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const milestones = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item]));
  return [...milestones.values()].flatMap((milestone): Ask[] => {
    const entry = stored[milestone.id];
    if (!entry || !("risks" in entry) || decisions[milestone.id]?.fingerprint === entry.fingerprint) return [];
    const anchor = anchors.get(milestone.id);
    const deadline = readGoalSettings(ctx, milestone.id)?.confirmedDeadline || anchor?.deadline || null;
    // Read the way the reviewer read it (`apps/worker/src/milestone-risk-review.ts`): a review of an earlier form is not this one's.
    const fingerprint = milestoneRiskFingerprint({ title: milestone.title, deadline, criteria: riskCriteriaKeys(milestone.successCriteria ?? []), dependsOn: anchor?.dependsOn ?? [] });
    const days = riskBufferDays(entry.risks);
    if (entry.fingerprint !== fingerprint || !days || (deadline && deadline < today)) return [];
    const risks = entry.risks.filter((risk) => risk.level !== "low");
    const level = riskLevelOf(risks)!;
    return [{ id: `riskreview:${milestone.id}`, kind: "milestone_risk_review", entityId: milestone.id, line: milestone.identityId, risks,
      preview: milestonePreview(t, milestone.id), urgency: urgencyFor(deadline ?? undefined, today), ...(deadline ? { dueDay: deadline } : {}),
      raisedAt: entry.at, fingerprint: entry.fingerprint, important: level === "high",
      title: t("「{{title}}」有{{level}}风险：{{kinds}}", { title: short(milestone.title), level: t(MILESTONE_RISK_LEVEL_LABEL[level]),
        kinds: listOf(locale, risks.map((risk) => t(MILESTONE_RISK_KIND_LABEL[risk.kind]))) }),
      why: t("审查认为：{{notes}}。", { notes: clause(risks.map((risk) => risk.note).join(locale === "en" ? "; " : "；")) })
        + (deadline ? (locale === "en" ? " " : "") + t("截止 {{day}}。", { day: format(deadline, locale) }) : "")
        + (locale === "en" ? " " : "") + t("接受后，排程让它的任务提前 {{count}} 天排完；不接受则排程不变。", { count: days }),
      options: [
        { id: "accept", label: t("接受，按风险提前安排"), recommended: true, detail: t("它的任务提前 {{count}} 天排完", { count: days }) },
        { id: "extend", label: t("调整截止"), fields: [{ id: "date", label: t("截止改到"), kind: "date" as const, required: true, ...(deadline ? { initial: deadline } : {}) }] },
        { id: "lower", label: t("降低标准"), href: `/milestones?open=${encodeURIComponent(milestone.id)}` },
        { id: "ignore", label: t("不用管"), detail: t("排程不变，这次审查不再问") }
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
function missedAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const placed = readScheduledDay(ctx, yesterday);
  if (!Object.keys(placed).length) return [];
  const anchors = deadlines(store, ctx.workspaceId);
  const handled = new Set(live(ctx, store.listEvents(ctx.workspaceId, { type: "missed.handled" })).map((event) => (event.payload as { askId?: string }).askId));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  // A block the person already answered the completion check for (any answer, 未执行 included) is not asked about again.
  const confirmed = new Set(store.listEvents(ctx.workspaceId, { type: "block.confirmed" })
    .filter((event) => (event.payload as { day?: string }).day === yesterday).map((event) => String((event.payload as { workOrderId?: string }).workOrderId)));
  return Object.entries(placed).flatMap(([orderId, start]) => {
    const order = orders.get(orderId);
    const id = `missed:${orderId}:${yesterday}`;
    // Still not begun: approved, preparing or ready. Started (or done, or discarded) is not missed.
    if (!order || !["approved", "preparing", "ready_for_human"].includes(order.state) || handled.has(id) || confirmed.has(orderId)) return [];
    const dueDay = dueOf(order, anchors);
    if (!dueDay || daysBetween(today, dueDay) > MISSED_ASK_HORIZON_DAYS) return [];
    return [{ id, kind: "missed_block" as const, entityId: orderId, line: order.identityId, urgency: urgencyFor(dueDay, today), dueDay, preview: taskPreview(t, orderId),
      raisedAt: `${yesterday}T${start}`, fingerprint: yesterday,
      title: t("昨天 {{time}} 排的「{{title}}」没开始", { time: start, title: short(order.intent) }),
      why: t("它已经被顺延到后面的空档，关系到 {{day}} 的截止（{{left}}）。顺延没问题就点一下；要是其实做了，去补记；要是已经不需要，就不做了。", {
        day: format(dueDay, locale), left: ((left) => left > 0 ? t("还剩 {{count}} 天", { count: left }) : left === 0 ? t("今天截止") : t("已过 {{count}} 天", { count: -left }))(daysBetween(today, dueDay)) }),
      options: [
        { id: "roll", label: t("顺延就好"), detail: t("按重新排的时间做"), recommended: true },
        { id: "later", label: t("推到某天再做"), fields: [{ id: "date", label: t("从哪天起再排"), kind: "date" as const, required: true }] },
        { id: "done", label: t("其实做了，去补记"), href: `/workbench/${encodeURIComponent(orderId)}` },
        { id: "drop", label: t("不做了"), fields: [{ id: "reason", label: t("为什么不做"), kind: "text" as const, required: true }] }
      ] }];
  });
}

/** The assistant's work that stopped and will not be run again by itself, with its progress and the next step to choose (`lib/agent-ask.ts`). */
const agentAsks = ({ ctx, now, today }: Source): Ask[] => agentBlockedAsks(ctx, now, today);

function readFailure(store: Source["store"], workspaceId: string, key: string) {
  try { return JSON.parse(store.getSetting(workspaceId, key) || "null") as { code: string; message: string; sources?: string[]; at: string } | null; }
  catch { return null; }
}

function calendarAsks({ store, ctx, t, locale }: Source): Ask[] {
  const asks: Ask[] = [];
  const publish = readFailure(store, ctx.workspaceId, CALENDAR_PUBLISH_FAILURE);
  // A worker that is down is its own ask (below); the same cause is not asked twice.
  if (publish && publish.code !== "CODEX_SUPERVISOR_UNAVAILABLE") asks.push({ id: `publish:${publish.code}`, kind: "calendar_publish_failed",
    entityId: "calendar", urgency: "soon", raisedAt: publish.at, fingerprint: publish.code, title: t("Crossline 日历没同步上"),
    why: publish.code === "CALENDAR_WRITE_NOT_AUTHORIZED"
      ? t("写入 Crossline 日历的账号登录已过期，重新登录后重试；其他日历不受影响。")
      : t("{{reason}}。其他日历未受影响。", { reason: clause(publish.message || publish.code) }),
    options: [{ id: "retry", label: t("处理好了，现在重试"), recommended: true }] });
  const sync = readFailure(store, ctx.workspaceId, CALENDAR_SYNC_FAILURE);
  if (sync) asks.push({ id: `sync:${sync.code}:${(sync.sources ?? []).join(",")}`, kind: "calendar_sync_failed", entityId: "calendar",
    urgency: "soon", raisedAt: sync.at, fingerprint: sync.code,
    title: sync.sources?.length ? t("读不到日历：{{names}}", { names: listOf(locale, sync.sources) }) : t("日历无法读取"),
    why: t("{{reason}}。在恢复之前，排程照常用最后一次读到的日程；账号登出需要重新登录。", { reason: clause(sync.message || sync.code) }),
    options: [{ id: "settings", label: t("去设置看连接"), href: "/settings" }] });
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
function sourceProjectAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  // While the interview runs, it asks this itself (its own round, with the projects as options); here only once it is done or 已可开始.
  const interview = interviewStatus(ctx);
  if (interview.started && !interview.complete && !interview.parked) return [];
  const projects = store.listProjects(ctx.workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  return unfiledFiles(ctx, today).map(({ id, fileName, titles, days, lean, raisedAt }) => {
    const dueDay = days.sort()[0];
    // The lean first, then the projects on its line, then the rest.
    const ordered = [...(lean ? [lean] : []), ...projects.filter((project) => project.id !== lean?.id)
      .sort((a, b) => Number(b.identityId === lean?.identityId) - Number(a.identityId === lean?.identityId))].slice(0, 6);
    const named = listOf(locale, titles.slice(0, 3).map((title) => t("「{{title}}」", { title: short(title, 16) })));
    // Important when dates were read from it: until it is filed they carry no course, and its deadlines bear on no project.
    return { id: `src:${id}`, kind: "source_project" as const, entityId: id, urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}),
      important: titles.length > 0, preview: filePreview(t, id, t("打开《{{name}}》", { name: short(fileName, 20) })),
      raisedAt, fingerprint: `${id}:${titles.length}`, title: t("《{{name}}》属于哪个项目？", { name: short(fileName, 32) }),
      why: titles.length
        ? (lean
          ? t("文件名和正文开头都没有写明所属课程或项目，从中读出的 {{count}} 项日程（{{named}}{{more}}）因此无法标明归属；访谈时判断更可能是 {{lean}}。确认后，这些日程与截止都会带上项目名。",
            { count: titles.length, named, more: titles.length > 3 ? t(" 等") : "", lean: lean.name })
          : t("文件名和正文开头都没有写明所属课程或项目，从中读出的 {{count}} 项日程（{{named}}{{more}}）因此无法标明归属。确认后，这些日程与截止都会带上项目名。",
            { count: titles.length, named, more: titles.length > 3 ? t(" 等") : "" }))
        : t("文件名和正文开头都没有写明所属课程或项目。确认后，这份文件会作为该项目任务的材料与背景使用。"),
      options: [...ordered.map((project) => ({ id: `p:${project.id}`, label: project.name, ...(project.id === lean?.id ? { recommended: true } : {}) })),
        { id: "none", label: t("不属于任何项目"), detail: titles.length ? t("这份文件的日程保持原名") : t("作为通用资料保留") }] };
  });
}

/**
 * A calendar event the classifier could not place from anything on record (a title such as 「Busy」 with nothing else, or a line it
 * named that does not exist). At most three open at a time; the answer is the person's and is never refiled by a model.
 */
function calendarLineAsks({ store, ctx, t }: Source): Ask[] {
  const lines = identityLines(ctx);
  if (!lines.length) return [];
  const filing = calendarFiling(ctx);
  const titles = new Map<string, string>();
  for (const block of ((store.listPlanVersions(ctx.workspaceId)[0]?.payload as { blocks?: Array<{ id: string; title: string }> } | undefined)?.blocks ?? []))
    if (block.id.startsWith("graph_calendar:") || block.id.startsWith("import:")) titles.set(calendarEventKey(block.title), block.title);
  return Object.entries(filing.entries).filter(([key, entry]) => entry.unclear && entry.by !== "person" && titles.has(key)).slice(0, 3)
    .map(([key, entry]) => ({ id: `calline:${key}`, kind: "calendar_line_unclear" as const, entityId: key, urgency: "later" as const, raisedAt: entry.at, important: false,
      fingerprint: entry.at, title: t("日历中的「{{title}}」属于哪条主线？", { title: short(titles.get(key)!, 30) }),
      why: entry.why ? t("标题和时间都看不出它服务于哪条主线（{{why}}）。确认后，它在日历上按该主线着色，以后同名的日程也一样。", { why: clause(entry.why) })
        : t("标题和时间都看不出它服务于哪条主线。确认后，它在日历上按该主线着色，以后同名的日程也一样。"),
      options: [...lines.map((line) => ({ id: `l:${line.id}`, label: line.label })), { id: "none", label: t("不属于任何主线"), detail: t("个人事务等，保持无色") }] }));
}

/** The app's own interview questions that are start items (`profileGaps`: LINE_UNCONFIRMED, PROJECT_DEADLINE). */
const START_GAP = /^gap-(line|deadline)-/;
/** The recommended answer in words, as the input's placeholder: the app's own questions say what a good answer looks like. */
const GAP_PLACEHOLDER: Array<[RegExp, string]> = [
  [/^gap-line-/, "例如：在做 MoS₂ 器件测量，12 月底前交初稿，卡在等数据"],
  [/^gap-deadline-/, "例如：2026-12-15；没有截止就写「没有截止」"],
  [/^gap-undated-/, "例如：大约学期最后一周，通知下来再改"],
  [/^gap-meetings-/, "例如：周二、四 11:00–12:15"],
  [/^gap-portrait$/, "例如：符合；第二句里的“…”要改成…"],
  [/^gap-appearance$/, "例如：男，狼尾长发，常穿全黑"]
];
const interviewPlaceholder = (t: Translate, question: { id: string; kind: string; options: Array<{ label: string }> }) => {
  const own = GAP_PLACEHOLDER.find(([pattern]) => pattern.test(question.id))?.[1];
  return own ? t(own) : question.kind !== "free" && question.options[0] ? t("例如：{{option}}，或用自己的话说", { option: question.options[0].label }) : t("用自己的话回答");
};

const STAGE_LABEL: Record<string, string> = { orientation: "开场与规则", situation: "现状", compass: "指南针", energy: "能量", lines: "主线", details: "细节" };

/**
 * The main interview stopped with questions still open. The system works meanwhile — approved milestones are worked back and scheduled —
 * but milestone drafts, long-term goals and the proposed hours are designed from what the interview has, so the gap is named here.
 */
function interviewAsks({ ctx, t, locale }: Source): Ask[] {
  const status = interviewStatus(ctx);
  // While the interview runs, its questions are asked in it, round by round; only once the start standard stands and the person uses the
  // app (已可开始) with the portrait unfinished are they asked here as well, each answerable in place (decided 2026-10-08, 2026-10-12).
  if (!status.started || status.complete || !status.parked) return [];
  const where = status.stage ? t("访谈在「{{stage}}」阶段（第 {{index}}/{{count}} 阶段）", { stage: STAGE_LABEL[status.stage] ? t(STAGE_LABEL[status.stage]!) : status.stage,
    index: status.stageIndex, count: status.stageCount }) : t("访谈");
  const questions = status.questions.map((question): Ask => {
    const single = question.kind !== "free" && question.options.length > 0;
    const other: AskField = { id: "other", label: t("补充"), kind: "text", required: false, placeholder: t("可不填") };
    const portrait = question.id === "gap-portrait" || question.id === "gap-appearance";
    return { id: `iq:${question.id}`, kind: "interview_question", entityId: question.id, urgency: "later", raisedAt: "",
      fingerprint: `${status.sessionId}:${question.id}`, ...(question.identityId ? { line: question.identityId } : {}),
      title: question.text,
      why: t("{{where}}的问题。本轮的问题都答完后，会一起交给访谈，接着下一轮。", { where }),
      // A line resting on guesses and a project's deadline are start items: milestones are designed from them.
      important: START_GAP.test(question.id),
      select: question.kind === "multi" ? "many" : "one",
      ...(portrait ? { preview: { kind: "portrait" as const, href: "/portrait", label: t("看画像") } } : {}),
      ...(single && !question.allowOther ? {} : { freeText: { placeholder: interviewPlaceholder(t, question) } }),
      options: single
        ? question.options.slice(0, 8).map((option) => ({ id: option.id, label: option.label, ...(option.detail ? { detail: option.detail } : {}),
          ...(question.allowOther ? { fields: [other] } : {}) }))
        : [{ id: "free", label: t("回答"), fields: [{ id: "other", label: t("回答"), kind: "longtext" as const, required: true }] }] };
  });
  return [{ id: "interview:open", kind: "interview_open", entityId: "interview", urgency: "later", raisedAt: "",
    fingerprint: `${status.stage}:${status.openQuestions}`,
    title: t("访谈未完成"),
    why: (status.openQuestions ? t("{{where}}，{{count}} 个问题列在下面，可以在这里逐个回答。", { where, count: status.openQuestions }) : t("{{where}}。", { where }))
      + (locale === "en" ? " " : "") + t("期间系统照常使用；补齐后，长期目标、里程碑草稿与建议的可用时段按新信息更新。"),
    options: [{ id: "open", label: t("回到访谈"), href: "/onboarding", recommended: true }] }, ...questions];
}

/**
 * A fixed arrangement the person confirmed (a class, an office hour, an exam with a time) that their own calendar does not hold: offered
 * for the Crossline calendar once the interview is done or its report exists. A recurring one becomes one repeating series, a one-off one
 * event. At most four open at a time, soonest first.
 */
function eventAsks({ ctx, today, t, locale }: Source): Ask[] {
  // Without an account to write the Crossline calendar with, 「创建」 can only answer 「未连接」: an invitee was asked this for every class
  // (2026-10-15 walkthrough), while the schedule already keeps those hours free either way.
  if (!getStore().getSetting(ctx.workspaceId, "calendar.write.account")) return [];
  return eventProposals(ctx).slice(0, 4).map((event) => {
    const first = event.repeat ? undefined : event.date;
    return { id: `event:${event.id}`, kind: "event_propose" as const, entityId: event.id, urgency: first ? urgencyFor(first, today) : "later" as const,
      ...(first ? { dueDay: first } : {}), ...(event.lineId ? { line: event.lineId } : {}), raisedAt: "", fingerprint: event.id,
      title: t("日历中没有「{{title}}」，要创建吗？", { title: short(event.title, 24) }),
      why: t(event.repeat ? "周期性日程：{{what}}；来自{{source}}，在已同步的日历里没有找到。创建后写入 Crossline 日历——作为一个每周重复的系列，提前 10 分钟提醒；排程本来就会绕开这段时间。"
        : "一次性日程：{{what}}；来自{{source}}，在已同步的日历里没有找到。创建后写入 Crossline 日历——作为单个事件，提前 10 分钟提醒；排程本来就会绕开这段时间。", {
        what: `${describeEvent(event, locale)}${event.location ? `${locale === "en" ? ", " : "，"}${event.location}` : ""}`,
        source: event.source === "interview" ? t("访谈中的口述") : t("上传的文件") }),
      options: [{ id: "create", label: t("创建"), recommended: true }, { id: "exists", label: t("已在别的日历里"), detail: t("不再提醒") },
        { id: "skip", label: t("不需要"), detail: t("不写入日历") }] };
  });
}

/**
 * Background work the worker paused for this workspace (`BACKGROUND_BLOCKER`): an unreadable quota (an API-key login reports no
 * windows) or a spent one. It used to stop with nothing said, so captures sat unanalysed while the page looked normal. A worker that is
 * down is the runtime banner (`lib/runtime-status.ts`), not this one.
 */
function backgroundAsks({ store, ctx, t }: Source): Ask[] {
  const paused = readFailure(store, ctx.workspaceId, BACKGROUND_BLOCKER) as ({ resetsAt?: string; reason?: string } & NonNullable<ReturnType<typeof readFailure>>) | null;
  if (!paused || paused.reason === "CODEX_SUPERVISOR_UNAVAILABLE") return [];
  const until = paused.resetsAt ? t("，预计 {{at}} 恢复", { at: localStamp(paused.resetsAt, effectiveSchedulePreferences(ctx).preferences.timeZone) }) : "";
  return [{ id: `background:${paused.code}`, kind: "background_paused", entityId: "background", urgency: "soon", raisedAt: paused.at,
    fingerprint: paused.code, title: t("后台自动工作已暂停"),
    why: t("{{reason}}{{until}}。新收集的事项会在恢复后自动分析；需要现在处理的可以在任务页手动点「分析」。", { reason: clause(paused.message), until }),
    options: [{ id: "settings", label: t("去看额度"), href: "/settings#usage", recommended: true }] }];
}

/**
 * A block the person started or locked that a calendar event now lands on (docs/loop-and-scout.md §1): it is not moved without a word —
 * the person picks: the next free time, tomorrow, or keep the overlap.
 */
function lockedConflictAsks({ store, ctx, today, now, t, locale }: Source): Ask[] {
  // Calendar events, class meetings, the person's own events and other held blocks alike (`heldConflicts`, `settleFrozen`).
  const conflicts = heldConflicts(ctx, now);
  if (!conflicts.length) return [];
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  return conflicts.flatMap(({ entry: item, title }) => {
    const hit = { title };
    const order = orders.get(plannerIdOfBlock(item.blockId).split("#")[0]!);
    if (!order) return [];
    const clock = (iso: string) => new Date(iso).toLocaleTimeString(intlLocale(locale), { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false });
    const day = new Date(item.start).toLocaleDateString("sv-SE", { timeZone: zone });
    return [{ id: `locked:${item.blockId}`, kind: "locked_conflict" as const, entityId: order.id, line: order.identityId,
      preview: { kind: "plan" as const, href: "/", label: t("看当天日程") },
      urgency: urgencyFor(day, today), dueDay: day, raisedAt: now.toISOString(), fingerprint: `${item.start}|${hit.title}`,
      title: t("锁定的「{{task}}」与「{{event}}」重叠", { task: short(taskTitleOf(order), 20), event: short(hit.title, 20) }),
      why: t("{{day}} {{start}}–{{end}} 这段是本人锁定的，「{{event}}」占了同一时间。锁定的块不会被自动挪走，请选一个处理方式。", {
        day: format(day, locale), start: clock(item.start), end: clock(item.end), event: hit.title }),
      options: [
        { id: "move", label: t("挪到下一个空档"), detail: t("解除锁定，由排程重新放"), recommended: true },
        { id: "tomorrow", label: t("换到明天"), detail: t("解除锁定，明天起再排") },
        { id: "keep", label: t("保留重叠"), detail: t("两件事都留在原时间") }
      ] }];
  });
}

export function collectAsks(ctx: AccessContext, now = appNow()): Ask[] {
  const locale = localeFor(ctx);
  const source = { store: getStore(), ctx, today: planToday(ctx, now), now, t: tFor(locale), locale };
  return [backplanAsks, waitingAsks, captureAsks, materialsAsks, gateAsks, riskAsks, riskReviewAsks, missedAsks, lockedConflictAsks, agentAsks, calendarAsks, sourceProjectAsks, calendarLineAsks, interviewAsks, eventAsks, stepQuestionAsks,
    ({ ctx: context, now: at }: Source) => relationCheckAsks(context, at), backgroundAsks, ({ ctx: context, now: at }: Source) => outcomeAsks(context, at),
    ({ ctx: context, now: at }: Source) => progressAsks(context, at)]
    .flatMap((collect) => { try { return collect(source); } catch { return []; } })
    // One card per id: two with one id are the same question twice, and answering finds only the first.
    .filter((ask, index, all) => all.findIndex((other) => other.id === ask.id) === index);
}

/**
 * What a task's step plan could not read from the person's material or facts (decided 2026-10-09): the exam's scope, what they already
 * master, the format of the deliverable. Asked here with the plan's own options; the answer is a confirmed fact every later plan reads,
 * and the task is planned again with it.
 */
function stepQuestionAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).filter((order) => ["approved", "preparing", "ready_for_human", "active"].includes(order.state))
    .map((order) => [order.id, order]));
  const answered = new Set(store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT)).map((fact) => `${fact.projectId}|${fact.slot}`));
  // The answer is kept per project, so the same question from two tasks of one project is one question: asked once, it answers both.
  const asked = new Set<string>();
  // What a task's own files answer (the problem set, how it is handed in, the AI rule) is read from them, never asked: the worker's task
  // pass writes it as an assumption, and it is left out here already so it never shows meanwhile.
  const withFiles = new Set(store.listSourceDocuments(ctx.workspaceId).map((doc) => doc.projectId).filter(Boolean));
  return store.listStepPlans(ctx.workspaceId).flatMap((plan) => {
    const order = orders.get(plan.workOrderId);
    if (!order) return [];
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate;
    return plan.questions.filter((question) => {
      const key = `${order.projectId}|${stepAnswerSlot(question.text)}`;
      if (withFiles.has(order.projectId) && readableFromMaterial(question.text)) return false;
      return !answered.has(key) && !asked.has(key) && Boolean(asked.add(key));
    }).map((question): Ask => ({
      id: `stepq:${order.id}:${stepAnswerSlot(question.text)}`, kind: "step_question", entityId: order.id, line: order.identityId,
      urgency: urgencyFor(due, today), ...(due ? { dueDay: due } : {}), raisedAt: plan.plannedAt, fingerprint: `${plan.version}:${question.text}`,
      // The step planner asks only for important work and only what it cannot read from the material: its plan waits on the answer.
      important: true, preview: taskPreview(t, order.id),
      freeText: { placeholder: question.options[0] ? t("例如：{{option}}，或用自己的话说", { option: question.options[0] }) : t("用自己的话回答") },
      title: t("「{{task}}」：{{question}}", { task: short(taskTitleOf(order), 24), question: question.text }),
      why: (question.why ? t("{{reason}}。", { reason: clause(question.why) }) + (locale === "en" ? " " : "") : "")
        + t("回答后，这个任务的步骤会按回答重新安排；材料里已有的信息不会再问。"),
      options: [...question.options.map((option, index) => ({ id: `o${index}`, label: option,
        fields: [{ id: "other", label: t("补充"), kind: "text" as const, required: false, placeholder: t("可不填") }] })),
        { id: "free", label: t("都不是，我来写"), fields: [{ id: "other", label: t("回答"), kind: "text" as const, required: true }] }]
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
export function openAsks(ctx: AccessContext, now?: Date): Ask[] {
  const build = (at: Date) => rankAsks(decisionHorizon(ctx, at).annotate(collectAsks(ctx, at)), snoozes(ctx), planToday(ctx, at));
  // At the present moment the answer is reused until the ledger changes or half a minute passes (`lib/ledger-memo.ts`).
  return now ? build(now) : memoByLedger(getStore(), `asks:${ctx.workspaceId}:${localeFor(ctx)}:${appNow().toISOString().slice(0, 16)}`, 30_000, () => build(appNow()));
}
export const thisWeek = (asks: Ask[]) => asks.filter((ask) => !ask.entersOn);

/**
 * What Today and 待确认 show. Whether the worker and its model runtime can run at all is not an ask: it is an error the banner on
 * every page shows (`lib/runtime-status.ts`), so the list and the count always agree.
 */
export async function loadAsks(ctx: AccessContext, now?: Date): Promise<Ask[]> {
  return listed(openAsks(ctx, now));
}

/**
 * The asks that are listed and counted (Today's stack, 待确认, the badge, the opener). A follow-up on finished work (`outcome_check`) is
 * only ever asked by the 小帮手 at an idle moment (decided 2026-10-15): it stays answerable — from the nudge's buttons or typed into the
 * box — but is never a decision waiting on the person. The same holds for 「做到哪了」 after a partial answer on the return page (`progress_check`).
 */
export const listed = (asks: Ask[]) => asks.filter((ask) => ask.kind !== "outcome_check" && ask.kind !== "progress_check");

export type AskResult = { ok: true } | { ok: false; code: string };

function record(ctx: AccessContext, type: string, entityId: string, key: string, payload: Record<string, unknown>) {
  getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: key, type, entityId, payload });
}

function rerunBackplan(ctx: AccessContext, milestoneId: string) {
  record(ctx, "goal.backplan_rerun_requested", milestoneId, `goal:backplan:rerun:${milestoneId}:${Date.now()}`, {});
  requestAutoBackplan(ctx);
}

function answerBackplan(ctx: AccessContext, ask: Ask, optionId: string): AskResult {
  const store = getStore();
  const milestoneId = ask.entityId;
  const milestone = store.listMilestones(ctx.workspaceId).find((item) => item.id === milestoneId && item.status === "approved");
  if (!milestone) return { ok: false, code: "MILESTONE_NOT_APPROVED" };
  const resolve = (how: string, id = ask.id) => record(ctx, "goal.backplan_input_resolved", milestoneId, `goal:backplan:resolved:${id}`, { askId: id, how });
  if (optionId === "skip") {
    const started = new Set(store.listExecutions(ctx.workspaceId).map((execution) => execution.workOrderId));
    for (const order of store.listWorkOrders(ctx.workspaceId).filter((item) => item.milestoneId === milestoneId
      && (item.payload as { backplan?: unknown }).backplan && UNTOUCHED.has(item.state) && !started.has(item.id)))
      archiveWorkOrder(ctx, order.id, "本人选择暂不拆分该里程碑"); // i18n-ignore: a system reason `archivedBySystem` matches
    record(ctx, "goal.backplan_declined", milestoneId, `goal:backplan:declined:${milestoneId}:${milestone.version}`, { milestoneVersion: milestone.version });
    return { ok: true };
  }
  if (optionId === "retry") { resolve("retry"); rerunBackplan(ctx, milestoneId); return { ok: true }; }
  return { ok: false, code: "ASK_OPTION_UNKNOWN" };
}

/** What the person chose: the options (several only where `select` is `many`) and their own words (`freeText`), already checked. */
type AskChoice = { optionIds: string[]; note: string };

async function answerOne(ctx: AccessContext, ask: Ask, choice: AskChoice, values: Record<string, string>): Promise<AskResult> {
  const store = getStore();
  const optionId = choice.optionIds[0] ?? "";
  switch (ask.kind) {
    case "backplan_input": return answerBackplan(ctx, ask, optionId);
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
            // Handed to the backplanner as the supplied input (model context).
            { what, text: values.note || `已从${item.who || "对方"}那里收到`, askId: ask.id }); // i18n-ignore
          record(ctx, "goal.backplan_rerun_requested", milestoneId, `goal:backplan:rerun:${milestoneId}:${Date.now()}`, {});
        }
        requestAutoBackplan(ctx);
      }
      return result;
    }
    case "capture_blocked": {
      if (optionId === "discard") return discardCapture(ctx, ask.entityId, values.reason!);
      // The person's own words are the context, whether typed into the option's field or straight into the card.
      const context = values.note || choice.note;
      if (!context) return { ok: false, code: "ASK_FIELD_REQUIRED" };
      try { store.addCaptureContext(ctx.workspaceId, ask.entityId, context); }
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
          sourceQuote: tOf(ctx)("在「可能赶不上」的询问里推迟") });
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
    case "locked_conflict": {
      const blockId = ask.id.slice("locked:".length);
      if (optionId === "keep") {
        const frozen = readFrozen(ctx, appNow());
        const entry = frozen.find((item) => item.blockId === blockId);
        if (entry) writeFrozen(ctx, withFrozen(frozen, { ...entry, overlapOk: true }));
        return { ok: true };
      }
      unlockBlock(ctx, blockId);
      if (optionId === "tomorrow") {
        const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === ask.entityId);
        if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
        const tomorrow = new Date(Date.parse(`${planToday(ctx)}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
        store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), notBefore: tomorrow } });
      }
      return { ok: true };
    }
    case "agent_blocked": return answerAgentAsk(ctx, ask, { optionIds: choice.optionIds, values, note: choice.note });
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
      const labels = ask.options.filter((item) => choice.optionIds.includes(item.id) && item.id !== "free").map((item) => item.label);
      const answer = [...new Set([...labels, (values.other ?? "").trim(), choice.note].filter(Boolean))].join("；");
      if (!answer) return { ok: false, code: "STEP_ANSWER_EMPTY" };
      store.upsertProfileFact({ workspaceId: ctx.workspaceId, identityId: order.identityId, projectId: order.projectId, slot: stepAnswerSlot(question.text),
        value: `【${question.text}】${answer}`, status: "confirmed", sourceRef: "ask", sourceQuote: answer, updatedAt: new Date().toISOString() });
      // i18n-ignore: feedback for the step planner (model context)
      requestStepReplan(ctx, order.id, `本人回答了「${question.text}」：${answer}。按此重新安排步骤。`);
      return { ok: true };
    }
    case "interview_question": {
      // Several options and the person's own words go into the reply as the interview screen writes them (「选择：A；B。补充：…」).
      const other = [...new Set([values.other ?? "", choice.note].map((text) => text.trim()).filter(Boolean))].join("；");
      const result = await answerInterviewQuestion(ctx, ask.entityId, choice.optionIds.filter((id) => id !== "free"), other, sendInterviewReply(ctx));
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
      filing.entries[ask.entityId] = { lineId, why: tOf(ctx)("本人确认"), at: new Date().toISOString(), by: "person" };
      store.setSetting(ctx.workspaceId, CALENDAR_LINES, JSON.stringify(filing));
      return { ok: true };
    }
    case "relation_check": return answerRelationCheck(ctx, ask, optionId, values);
    case "outcome_check": return answerOutcome(ctx, ask, optionId, values, choice.note);
    case "progress_check": return answerProgress(ctx, ask, optionId, choice.note);
    case "milestone_risk_review": {
      const how: RiskDecision["how"] | undefined = optionId === "accept" ? "accept" : optionId === "extend" ? "extend" : optionId === "ignore" ? "ignore" : undefined;
      if (!how) return { ok: false, code: "ASK_OPTION_UNKNOWN" };
      if (how === "extend") {
        const settings = readGoalSettings(ctx, ask.entityId);
        const saved = saveGoalSettings(ctx, ask.entityId, { importance: settings?.importance ?? "ordinary", confirmedDeadline: values.date!,
          sourceQuote: tOf(ctx)("在里程碑风险的询问里调整截止") });
        if (!saved.ok) return saved;
      }
      // A `schedule.` setting, so the answer is undone with the rest of the operation.
      store.setSetting(ctx.workspaceId, RISK_DECISIONS_SETTING, JSON.stringify({ ...readRiskDecisions(ctx),
        [ask.entityId]: { fingerprint: ask.fingerprint, how, at: new Date().toISOString() } satisfies RiskDecision }));
      return { ok: true };
    }
    default: return { ok: false, code: "ASK_NOT_ANSWERABLE" };
  }
}

/** A round answered in full goes to the interview as the person's reply; the next round's questions follow when it answers. */
const sendInterviewReply = (ctx: AccessContext) => async (sessionId: string, text: string) => {
  void requestCodexSupervisor(ctx, "/v1/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, text }), signal: AbortSignal.timeout(3 * 60 * 60_000) }).catch(() => undefined);
};

/**
 * An option's one required text field left empty while the person wrote in the card itself: their words fill it (「不要了」 with the reason
 * typed into the card), so the free text is never a second, ignored place to answer.
 */
function withNoteInFields(ask: Ask, optionIds: string[], values: Record<string, unknown>, note: string): Record<string, unknown> {
  if (!note.trim()) return values;
  const filled = { ...values };
  for (const option of ask.options.filter((item) => optionIds.includes(item.id))) {
    const empty = (option.fields ?? []).filter((field) => field.kind !== "date" && !(typeof filled[field.id] === "string" && String(filled[field.id]).trim()));
    const required = empty.filter((field) => field.required);
    const target = required.length === 1 ? required[0] : !required.length && empty.length === 1 && ask.kind !== "interview_question" && ask.kind !== "step_question" ? empty[0] : undefined;
    if (target) filled[target.id] = note.trim();
  }
  return filled;
}

/**
 * Carries out the person's answer to one ask, recording that they answered (the system's own cost, counted on 系统体检). `choice` is one
 * option id (the original shape) or `{optionIds, note}`: several options where the ask takes several, and the person's own words where it
 * takes them. Where nothing downstream reads the words they are kept on the `ask.answered` event.
 */
export async function answerAsk(ctx: AccessContext, askId: string, choice: string | { optionIds?: string[]; note?: string },
  values: Record<string, unknown>, now = appNow()): Promise<AskResult> {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  const optionIds = typeof choice === "string" ? [choice] : choice.optionIds ?? [];
  const note = typeof choice === "string" ? "" : choice.note ?? "";
  // A note written into an ask that takes no free text, beside an option, still reaches a field that option asks for.
  const checked = validateAskChoice(ask.freeText ? ask : { ...ask, freeText: { placeholder: "" } }, optionIds, withNoteInFields(ask, optionIds, values, note), note);
  if (!checked.ok) return checked;
  if (!ask.freeText && !checked.options.length) return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const ids = checked.options.map((option) => option.id);
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const label = listOf(locale, checked.options.map((option) => option.label)) || t("自己回答");
  const result = await withUndo(ctx, t("{{label}}：{{title}}", { label, title: ask.title }), () => answerOne(ctx, ask, { optionIds: ids, note: checked.note }, checked.values));
  if (result.ok) record(ctx, "ask.answered", ask.entityId, `ask:answered:${ask.id}:${ids.join("+") || "note"}:${now.getTime()}`,
    { askId: ask.id, kind: ask.kind, optionId: ids[0] ?? "", ...(ids.length > 1 ? { optionIds: ids } : {}), ...(checked.note ? { note: checked.note } : {}) });
  return result;
}

/** 「明天再问」/「下周再问」: hidden until then, back sooner if what it is about changes. */
export function snoozeAsk(ctx: AccessContext, askId: string, choice: "tomorrow" | "week", now = appNow()): AskResult {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  const until = snoozeUntil(choice, planToday(ctx, now));
  // Recorded as an operation, so 「明天再问」 pressed by mistake can be undone like any other answer.
  const before = new Set(getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).map((event) => event.eventId));
  record(ctx, "ask.snoozed", ask.entityId, `ask:snoozed:${ask.id}:${now.getTime()}`,
    { askId: ask.id, until, fingerprint: ask.fingerprint } satisfies AskSnooze);
  const added = getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).filter((event) => !before.has(event.eventId)).map((event) => event.eventId);
  if (added.length) recordOp(ctx, tOf(ctx)(choice === "tomorrow" ? "明天再问：{{title}}" : "下周再问：{{title}}", { title: ask.title }), { kind: "event.retract", eventIds: added });
  return { ok: true };
}

/**
 * Writes what is waiting for the person where the worker's notifications read it, so the morning brief, the badge and
 * an urgent message all count the same things. Called on the web's own timer.
 */
export function writeAttentionSnapshot(ctx: AccessContext, pending: number, now = new Date()): void {
  const asks = listed(openAsks(ctx, now)).map((ask) => ({ id: ask.id, title: ask.title, urgency: ask.urgency, dueDay: ask.dueDay ?? null,
    path: ask.urgency === "now" ? "/" : "/approvals#asks" }));
  getStore().setSetting(ctx.workspaceId, ATTENTION_SNAPSHOT, JSON.stringify({ at: now.toISOString(), pending, asks }));
  // A round whose remaining questions were dead (answered, no longer asked, screened out) still holds the answers given on 待决事项:
  // they go to the interview here, on the same timer, so a restarted resident app settles it by itself.
  void flushPendingAnswers(ctx, sendInterviewReply(ctx)).catch(() => undefined);
}
