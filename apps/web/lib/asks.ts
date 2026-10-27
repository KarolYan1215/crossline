import "server-only";
import { recordOp, retractedEventIds, withUndo } from "./undo";
import {
  ATTENTION_SNAPSHOT, BACKGROUND_BLOCKER, CALENDAR_LINES, degradedService, CALENDAR_PUBLISH_FAILURE, CALENDAR_SYNC_FAILURE, calendarEventKey, daysBetween, describeEvent, missingInputsOf, rankAsks,
  localStamp, prepStepRetried, readableFromMaterial, snoozeUntil, STEP_ANSWER_SLOT, stepAnswerSlot, taskTitleOf, urgencyFor, type CalendarLines,
  validateAskChoice, withFrozen, type AccessContext, type Ask, type AskField, type AskItem, type AskOption, type AskPreview, type AskSnooze,
  isPreparationOnlyMilestone, onPersonsBoard, preparesOf, workOwner,
  MILESTONE_RISK_KIND_LABEL, MILESTONE_RISK_LEVEL_LABEL, MILESTONE_RISKS_SETTING, milestoneRiskFingerprint, parseMilestoneRisks, riskBufferDays, riskCriteriaKeys, riskLevelOf
} from "@crossline/core";
import { acceptOwnCompletion, listAgentTasks, ownCompletion, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import {
  acceptWorkOrderEvidence, answerWaiting, appNow, approveWorkOrderProposal, archiveWorkOrder, discardCapture, effectiveSchedulePreferences, effectiveWeight, getStore, IMPORTANT_WEIGHT, loadGoalForecast,
  markMaterialsReady, planToday, plannerIdOfBlock, readFrozen, readGoalSettings, retryMaterialPreparation, saveGoalSettings, saveMilestoneEdit, TASK_LIBRARY_WINDOW_DAYS,
  heldConflicts, unlockBlock, writeFrozen, readRiskDecisions, RISK_DECISIONS_SETTING, riskHorizonDays, type RiskDecision
} from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { readScheduledDay } from "./schedule-memory";
import { requestCodexSupervisor } from "./codex-runtime";
import { autoPublishPass, forgetPublishedHash } from "./auto-publish";
import { calendarFiling } from "./timeline";
import { answerInterviewQuestion, flushPendingAnswers, interviewStatus, type InterviewStatus } from "./interview-status";
import { recordStepAnswer, requestStepReplan } from "./steps";
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
  // A reply from the one a wait is on, seen in the person's mailbox (mail triage), brings the question forward to today.
  const replies = new Map(store.listEvents(ctx.workspaceId, { type: "waiting.mail_seen" })
    .map((event) => [event.entityId, { ...(event.payload as { from?: string; subject?: string }), at: event.createdAt }]));
  const replied = (item: WaitingItem) => { const reply = replies.get(item.id); return reply && reply.at > item.updatedAt ? reply : undefined; };
  const due = index.open.filter((item) => item.followUpAt <= today || replied(item));
  // One card for one wait: an item whose twin is already asked about is answered with it.
  return due.filter((item, position) => !due.slice(0, position).some((earlier) => index.withTwins(earlier).includes(item))).map((item) => {
    const twins = index.withTwins(item);
    const forMilestone = twins.some((twin) => index.milestonesOf(twin).length);
    const blocks = new Set(twins.flatMap((twin) => twin.blocks)).size;
    // Important when work waits on it: the answer is what lets that work onto the calendar (or re-splits a milestone).
    const blocked = twins.flatMap((twin) => twin.blocks);
    return { id: `wait:${item.id}`, kind: "waiting_due" as const, entityId: item.id, urgency: "now" as const, dueDay: item.followUpAt,
      important: forMilestone || blocked.length > 0, ...(blocked[0] ? { preview: taskPreview(t, blocked[0], t("看等它的任务")) } : {}),
      raisedAt: item.updatedAt, fingerprint: `${item.followUpAt}${replied(item) ? `:mail:${replied(item)!.at}` : ""}`,
      title: item.who ? t("{{who}}的「{{title}}」到了吗？", { who: item.who, title: short(item.title, 50) }) : t("「{{title}}」到了吗？", { title: short(item.title, 50) }),
      why: (replied(item) ? t("邮箱里收到 {{from}} 的邮件「{{subject}}」，可能就是它。", { from: short(replied(item)!.from ?? "", 40), subject: short(replied(item)!.subject ?? "", 50) })
          + (locale === "en" ? " " : "") : "")
        + (item.approximate ? t("原定大约 {{day}} 到。", { day: dayText(locale, item.expectedAt) }) : t("原定 {{day}} 到。", { day: dayText(locale, item.expectedAt) }))
        + (locale === "en" ? " " : "")
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
  return store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "preparing" && onPersonsBoard(order)).flatMap((order) => {
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
  // Only the person's own work: the assistant's preparation is accepted when delivered and never judged by the gate (docs/work-split.md).
  for (const order of store.listWorkOrders(ctx.workspaceId).filter(onPersonsBoard)) {
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
          // The person had pressed 完成 themselves: that is the acceptance now (2026-10-15), so ending it is the first answer.
          ...(ownCompletion(store, ctx.workspaceId, order.id) ? [{ id: "done", label: t("已经交了，结束"), detail: t("按本人点的完成算验收通过"), recommended: true }] : []),
          { id: "redo", label: t("重新排上，补做缺的"), recommended: !ownCompletion(store, ctx.workspaceId, order.id) },
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

/** The name inside 「…」 (or, in English, "…") of an ask's title, without the brackets; the whole title when there is none. */
const quotedTitle = (title: string) => /「([^」]+)」/.exec(title)?.[1] ?? /"([^"]+)"/.exec(title)?.[1] ?? title;
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
  steps: number; p50Minutes: number; p85Minutes: number; moreToSplit: boolean; horizonDays?: number }, locale?: Locale): string {
  const t = tFor(locale);
  const left = daysBetween(input.today, input.deadline);
  const hours = (minutes: number) => Math.max(0.5, Math.round(minutes / 30) / 2);
  const join = locale === "en" ? " " : "";
  const parts = [t("截止 {{day}}（剩 {{count}} 天）。", { day: format(input.deadline, locale), count: left })
    + join + t("已拆分的 {{count}} 个步骤剩余约 {{low}}–{{high}} 小时。", { count: input.steps, low: hours(input.p50Minutes), high: hours(input.p85Minutes) })];
  if (!input.p85Day) parts.push(t("按当前可用时段与优先于它的工作，截止前（预测到 {{count}} 周后）无法排完（或前置步骤尚未完成）。", { count: Math.round((input.horizonDays ?? 56) / 7) }));
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

/**
 * A milestone whose known work finishes too close to (or after) its deadline. Tability's three-check rule, as a question. Not while the
 * reviewer's risk question on the same milestone waits: the two asked about one milestone side by side, with overlapping answers
 * (2026-10-18 walkthrough); the review goes first and this one comes up afterwards if the forecast still says so.
 */
function riskAsks(source: Source): Ask[] {
  const { store, ctx, today, t, locale } = source;
  const reviewed = new Set(riskReviewMembers(source).map((ask) => ask.entityId));
  // The run reaches past every deadline it judges: a deadline beyond the run would otherwise read as never finishing.
  const horizonDays = riskHorizonDays(ctx);
  const forecast = loadGoalForecast(ctx, horizonDays);
  const lastDay = new Date(Date.parse(`${today}T00:00:00Z`) + (horizonDays - 1) * DAY).toISOString().slice(0, 10);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const accepted = live(ctx, store.listEvents(ctx.workspaceId, { type: "risk.accepted" }));
  const milestones = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item]));
  const rolling = new Set(store.listEvents(ctx.workspaceId, { type: "goal.backplan_proposed" })
    .filter((event) => (event.payload as { rolling?: boolean }).rolling).map((event) => event.entityId));
  return forecast.goals.flatMap((goal) => {
    const milestone = milestones.get(goal.milestoneId);
    const deadline = goal.confirmedDeadline;
    // A milestone that is only preparation carries no risk of its own: the milestone it prepares does (docs/work-split.md §5).
    if (!milestone || !deadline || deadline < today || reviewed.has(goal.milestoneId) || isPreparationOnlyMilestone(milestone)) return [];
    const own = orders.filter((order) => order.milestoneId === goal.milestoneId && ["approved", "preparing", "ready_for_human", "active"].includes(order.state) && onPersonsBoard(order));
    if (!own.length) return [];
    const atRisk = (goal.p85Day === null && deadline <= lastDay) || (goal.slackDays !== null && goal.slackDays < 2);
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
        moreToSplit: rolling.has(goal.milestoneId), horizonDays }, locale),
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
function riskReviewMembers({ store, ctx, today, t, locale }: Source): Ask[] {
  const stored = parseMilestoneRisks(store.getSetting(ctx.workspaceId, MILESTONE_RISKS_SETTING));
  const decisions = readRiskDecisions(ctx);
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const milestones = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item]));
  return [...milestones.values()].flatMap((milestone): Ask[] => {
    const entry = stored[milestone.id];
    if (!entry || !("risks" in entry) || decisions[milestone.id]?.fingerprint === entry.fingerprint || isPreparationOnlyMilestone(milestone)) return [];
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
      // A high risk is important by itself; otherwise the milestone's weight decides (`lib/horizon.ts` annotates it). An explicit
      // `false` here overrode a weight of 65 and filed a milestone due in six days under 不重要不紧急 (W-29).
      raisedAt: entry.at, fingerprint: entry.fingerprint, ...(level === "high" ? { important: true } : {}),
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
 * A deadline the system does not move — a course's, or one the person set — passed with the milestone's work still open (the worker's
 * daily pass writes `milestone.overdue` once per deadline, `apps/worker/src/date-advance.ts`; the person's own other milestones it moves
 * by itself). Asked once: 补做 keeps the date and the work, a new date is the person's, 放弃 archives the milestone and its unstarted work.
 * It goes away when answered, when the date is changed elsewhere, or when no work is left.
 */
function overdueAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  const milestones = new Map(store.listMilestones(ctx.workspaceId).filter((item) => item.status === "approved").map((item) => [item.id, item]));
  const anchors = deadlines(store, ctx.workspaceId);
  const resolved = new Set(live(ctx, store.listEvents(ctx.workspaceId, { type: "milestone.overdue_resolved" }))
    .map((event) => `${event.entityId}|${(event.payload as { deadline?: string }).deadline ?? ""}`));
  const open = store.listWorkOrders(ctx.workspaceId).filter((order) => ["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active", "blocked"].includes(order.state)
    && onPersonsBoard(order));
  const latest = new Map<string, ReturnType<typeof store.listEvents>[number]>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "milestone.overdue" })) latest.set(event.entityId, event);
  return [...latest].flatMap(([milestoneId, event]): Ask[] => {
    const milestone = milestones.get(milestoneId);
    const { deadline, why } = event.payload as { deadline: string; why?: string };
    const current = readGoalSettings(ctx, milestoneId)?.confirmedDeadline || anchors.get(milestoneId);
    const left = open.filter((order) => order.milestoneId === milestoneId);
    if (!milestone || current !== deadline || deadline >= today || resolved.has(`${milestoneId}|${deadline}`) || !left.length) return [];
    return [{ id: `overdue:${milestoneId}:${deadline}`, kind: "milestone_overdue", entityId: milestoneId, line: milestone.identityId,
      preview: milestonePreview(t, milestoneId), urgency: "soon", dueDay: deadline, raisedAt: event.createdAt, fingerprint: deadline, important: true,
      title: t("「{{title}}」的截止 {{day}} 已过，还有 {{count}} 个任务没完成", { title: short(milestone.title), day: format(deadline, locale), count: left.length }),
      why: t(why === "course" ? "这是课程给定的日期，系统不改动。可以照常补做（截止不变，剩下的工作继续排），改成新的日期，或放弃这个里程碑。"
        : "这个日期是本人定的，系统不改动。可以照常补做（截止不变，剩下的工作继续排），改成新的日期，或放弃这个里程碑。"),
      options: [
        { id: "makeup", label: t("补做"), detail: t("截止不变，剩下的工作照常排"), recommended: true },
        { id: "extend", label: t("改为新日期"), fields: [{ id: "date", label: t("截止改到"), kind: "date" as const, required: true }] },
        { id: "drop", label: t("放弃这个里程碑"), detail: t("里程碑和未开始的任务归档，可从已归档恢复") }
      ] }];
  });
}

/** Set by 「逐个决定」 on the folded card: while the same reviews wait, each is its own card again. */
const RISK_REVIEW_SPLIT = "asks.riskReview.split";
const riskBatchFingerprint = (members: Ask[]) => members.map((ask) => `${ask.entityId}:${ask.fingerprint}`).sort().join("|");

/**
 * Two or more reviewed risks waiting are one card, not one each (2026-10-17 walkthrough, W-29: approving twelve milestones put twelve
 * risk questions on the board, five this week). The card is as urgent as its nearest deadline and important when any risk is high or
 * any milestone weighs 60 or more; 「全部接受」 and 「全部不用管」 settle them together, 「逐个决定」 splits them back into one card each.
 */
function riskReviewAsks(source: Source): Ask[] {
  const members = riskReviewMembers(source);
  if (members.length < 2) return members;
  const fingerprint = riskBatchFingerprint(members);
  if (source.store.getSetting(source.ctx.workspaceId, RISK_REVIEW_SPLIT) === fingerprint) return members;
  return [riskReviewBatch(source.ctx, members, source.today, fingerprint)];
}

export function riskReviewBatch(ctx: AccessContext, members: Ask[], today: string, fingerprint: string): Ask {
  const due = members.map((ask) => ask.dueDay).filter((day): day is string => Boolean(day)).sort()[0];
  const weight = Math.max(0, ...members.map((ask) => effectiveWeight(ctx, ask.entityId)));
  const high = members.some((ask) => ask.important);
  // The members as rows the card draws (name, deadline, level, kinds), highest level first, then nearest deadline: a folded card of
  // 25 milestones used to say them all in one sentence (2026-10-21 walkthrough). The sentence keeps only the counts.
  const titles = new Map(getStore().listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone.title]));
  const rank = (ask: Ask) => { const level = riskLevelOf(ask.risks ?? []); return level === "high" ? 0 : level === "medium" ? 1 : 2; };
  const items: AskItem[] = [...members].sort((a, b) => rank(a) - rank(b) || (a.dueDay ?? "9999").localeCompare(b.dueDay ?? "9999"))
    .map((ask) => ({ id: ask.entityId, title: titles.get(ask.entityId) ?? quotedTitle(ask.title), ...(ask.dueDay ? { dueDay: ask.dueDay } : {}),
      ...(ask.line ? { line: ask.line } : {}), href: `/milestones?open=${encodeURIComponent(ask.entityId)}`, risks: ask.risks ?? [] }));
  const levels = { high: items.filter((item) => riskLevelOf(item.risks ?? []) === "high").length };
  const locale = localeFor(ctx);
  const t = tFor(locale);
  return { id: "riskreview:batch", kind: "milestone_risk_review", entityId: "batch", urgency: urgencyFor(due, today), ...(due ? { dueDay: due } : {}),
    raisedAt: members.map((ask) => ask.raisedAt).sort().at(-1) ?? "", fingerprint, important: high || weight >= IMPORTANT_WEIGHT, importance: weight,
    preview: { kind: "milestones", href: "/milestones", label: t("看里程碑") },
    title: t("{{count}} 个里程碑有风险待过目", { count: members.length }), items,
    why: (levels.high ? t("审查在 {{count}} 个里程碑上找出风险，其中 {{high}} 个为高风险，逐个列在下方。", { count: members.length, high: levels.high })
      : t("审查在 {{count}} 个里程碑上找出风险，逐个列在下方。", { count: members.length }))
      + (locale === "en" ? " " : "") + t("接受后，排程让各自的任务提前 1–2 天排完；不接受则排程不变。"),
    options: [
      { id: "accept", label: t("全部接受，按风险提前安排"), recommended: true, detail: t("各自的任务提前 1–2 天排完") },
      { id: "split", label: t("逐个决定"), detail: t("拆成每个里程碑一张卡，可分别调整截止或降低标准") },
      { id: "ignore", label: t("全部不用管"), detail: t("排程不变，这次审查不再问") }
    ] };
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
    if (!order || !["approved", "preparing", "ready_for_human"].includes(order.state) || handled.has(id) || confirmed.has(orderId) || !onPersonsBoard(order)) return [];
    const dueDay = dueOf(order, anchors);
    if (!dueDay || daysBetween(today, dueDay) > MISSED_ASK_HORIZON_DAYS) return [];
    return [{ id, kind: "missed_block" as const, entityId: orderId, line: order.identityId, urgency: urgencyFor(dueDay, today), dueDay, preview: taskPreview(t, orderId),
      raisedAt: `${yesterday}T${start}`, fingerprint: yesterday,
      title: t("昨天 {{time}} 排的「{{title}}」没开始", { time: start, title: short(order.intent) }),
      why: t("它已经被顺延到后面的空档，关系到 {{day}} 的截止（{{left}}）。顺延没问题就点一下；要是其实做了，去补记；要是已经不需要，就不做了。", {
        day: format(dueDay, locale), left: ((left) => left > 0 ? t("还剩 {{count}} 天", { count: left }) : left === 0 ? t("今天截止", { context: "inline" }) : t("已过 {{count}} 天", { count: -left }))(daysBetween(today, dueDay)) }),
      options: [
        { id: "roll", label: t("顺延就好"), detail: t("按重新排的时间做"), recommended: true },
        { id: "later", label: t("推到某天再做"), fields: [{ id: "date", label: t("从哪天起再排"), kind: "date" as const, required: true }] },
        { id: "done", label: t("其实做了，去补记"), href: `/workbench/${encodeURIComponent(orderId)}` },
        { id: "drop", label: t("不做了"), fields: [{ id: "reason", label: t("为什么不做"), kind: "text" as const, required: true }] }
      ] }];
  });
}

/** At most this many questions on one card (docs/work-split.md: ≤2 questions, ≤10 minutes of the person's time). */
export const PREP_QUESTIONS_PER_CARD = 2;
/** The question of an `ask` work order, at most `PREP_QUESTIONS_PER_CARD` sentences of it. */
export function prepQuestionOf(order: StoredWorkOrder): string {
  const own = (order.payload as { question?: unknown } | undefined)?.question;
  const text = (typeof own === "string" && own.trim() ? own.trim() : workOwner({ ...order, owner: "ask" }).question ?? "").replace(/\s+/g, " ");
  const parts = text.split(/(?<=[？?])/).map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, PREP_QUESTIONS_PER_CARD).join(" ").slice(0, 240);
}

/**
 * Work the assistant can do once the person gives one thing only they hold (docs/work-split.md, an `ask` work order): one question on
 * 待决事项, never a task card. The answer goes into the order and the order becomes the assistant's; 「不需要」 archives it. As urgent as
 * the core task it prepares, and important when one waits on it.
 */
function prepQuestionAsks({ store, ctx, today, t, locale }: Source): Ask[] {
  const anchors = deadlines(store, ctx.workspaceId);
  const orders = store.listWorkOrders(ctx.workspaceId);
  const byId = new Map(orders.map((order) => [order.id, order]));
  return orders.filter((order) => (order.payload as { owner?: unknown } | undefined)?.owner === "ask" && !order.tombstone
    && ["awaiting_plan_approval", "approved", "preparing", "ready_for_human"].includes(order.state)).map((order): Ask => {
    const served = byId.get(preparesOf(order));
    const live = served && !["archived", "accepted"].includes(served.state) ? served : undefined;
    const dueDay = (live ? dueOf(live, anchors) : undefined) ?? dueOf(order, anchors);
    const question = prepQuestionOf(order);
    const name = short(taskTitleOf(order), 24);
    const core = live ? short(taskTitleOf(live), 24) : "";
    return { id: `prepq:${order.id}`, kind: "prep_question", entityId: order.id, line: order.identityId,
      urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}), raisedAt: "", fingerprint: question,
      important: Boolean(live), ...(live ? { preview: taskPreview(t, live.id, t("看要用它的任务")) } : {}),
      freeText: { placeholder: t("直接写答案；在文件里的，写文件名或先上传再写在哪") },
      title: t("「{{name}}」需要本人回答：{{question}}", { name, question: short(question, 60) }),
      why: (core ? t("助手为「{{core}}」做「{{name}}」，只差这一点本人知道的信息，回答约需几分钟。", { core, name })
        : t("助手做「{{name}}」，只差这一点本人知道的信息，回答约需几分钟。", { name }))
        + (locale === "en" ? " " : "")
        + (core ? t("回答后由助手做完，结果放在「{{core}}」的「已备好」里；这件事不进任务列表，也不占日程。", { core })
          : t("回答后由助手做完；这件事不进任务列表，也不占日程。")),
      options: [
        { id: "answer", label: t("回答，交给助手"), recommended: true, detail: t("在下方写答案，助手按回答做完"), needsNote: true },
        { id: "skip", label: t("不需要"), detail: t("这项准备不做了，归档，可从已归档恢复") }
      ] };
  });
}

/** The answer to a question for the assistant: kept in the order, which becomes the assistant's and takes effect. */
function answerPrepQuestion(ctx: AccessContext, ask: Ask, optionId: string, note: string): AskResult {
  const store = getStore();
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === ask.entityId);
  if (!order || (order.payload as { owner?: unknown }).owner !== "ask") return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  if (optionId === "skip") return archiveWorkOrder(ctx, order.id, tOf(ctx)("本人表示不需要这项准备"), { bySystem: true });
  const answer = note.trim();
  if (!answer) return { ok: false, code: "ASK_FIELD_REQUIRED" };
  const question = prepQuestionOf(order);
  store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), owner: "assistant", question, answer: answer.slice(0, 2000), answeredAt: new Date().toISOString() } });
  record(ctx, "prep.question_answered", order.id, `prep:answered:${order.id}:${Date.now()}`, { question, answer: answer.slice(0, 2000) });
  // A proposal until now (it never took effect by itself): the person's answer is the go-ahead, and the assistant takes it on its next pass.
  if (order.state === "awaiting_plan_approval")
    store.transitionWorkOrder(ctx.workspaceId, order.id, { type: "plan.approved", approvalId: ctx.principalId }, `prep-answered-approved:${order.id}:${Date.now()}`);
  return { ok: true };
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

const stageWhere = (status: InterviewStatus, t: Translate) =>
  status.stage ? t("访谈在「{{stage}}」阶段（第 {{index}}/{{count}} 阶段）", { stage: STAGE_LABEL[status.stage] ? t(STAGE_LABEL[status.stage]!) : status.stage,
    index: status.stageIndex, count: status.stageCount }) : t("访谈");

/**
 * The main interview stopped with questions still open. The system works meanwhile — approved milestones are worked back and scheduled —
 * but milestone drafts, long-term goals and the proposed hours are designed from what the interview has, so the gap is named here.
 */
function interviewAsks({ ctx, now, t }: Source): Ask[] {
  const status = interviewStatus(ctx);
  // While the interview runs, its questions are asked in it, round by round; only once the start standard stands and the person uses the
  // app (已可开始) with the portrait unfinished are they asked here as well, answerable in place (decided 2026-10-08, 2026-10-12).
  if (!status.started || status.complete || !status.parked) return [];
  // One card, not one per question: the later stages' questions each became an ask and piled eight 「不急」 cards onto Today
  // (2026-10-17 walkthrough, W-21). The first open question not snoozed is asked in place; answering it brings up the next, since an
  // answered question leaves `status.questions` until the round goes to the interview together.
  const today = planToday(ctx, now);
  const held = new Map(snoozes(ctx).map((snooze) => [snooze.askId, snooze]));
  const questions = interviewQuestionAsks(status, t);
  const shown = questions.find((ask) => { const snooze = held.get(ask.id); return !snooze || snooze.until <= today || snooze.fingerprint !== ask.fingerprint; });
  if (shown) return [shown];
  if (questions.length) return [];
  return [{ id: "interview:open", kind: "interview_open", entityId: "interview", urgency: "later", raisedAt: "",
    fingerprint: `${status.stage}:${status.openQuestions}`,
    title: t("访谈未完成"),
    why: t("{{where}}，下一轮问题出来后可以在这里或访谈页回答。期间系统照常使用；补齐后，长期目标、里程碑草稿与建议的可用时段按新信息更新。", { where: stageWhere(status, t) }),
    options: [{ id: "open", label: t("回到访谈"), href: "/onboarding", recommended: true }] }];
}

/** Every open interview question as an answerable ask: `interviewAsks` lists one of them, `answerAsk` accepts any. */
function interviewQuestionAsks(status: InterviewStatus, t: Translate): Ask[] {
  const where = stageWhere(status, t);
  const count = status.questions.length;
  return status.questions.map((question): Ask => {
    const single = question.kind !== "free" && question.options.length > 0;
    const other: AskField = { id: "other", label: t("补充"), kind: "text", required: false, placeholder: t("可不填") };
    const portrait = question.id === "gap-portrait" || question.id === "gap-appearance";
    return { id: `iq:${question.id}`, kind: "interview_question", entityId: question.id, urgency: "later", raisedAt: "",
      fingerprint: `${status.sessionId}:${question.id}`, ...(question.identityId ? { line: question.identityId } : {}),
      title: count > 1 ? t("访谈还有 {{count}} 个问题：{{question}}", { count, question: question.text }) : question.text,
      why: count > 1 ? t("{{where}}的问题。答完这个显示下一个，也可以回到访谈一起回答。本轮的问题都答完后，会一起交给访谈，接着下一轮。", { where })
        : t("{{where}}的问题。本轮的问题都答完后，会一起交给访谈，接着下一轮。", { where }),
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
        source: event.source === "interview" ? t("访谈中的口述") : event.source === "recording" ? t("录音里听到的话（按 1 小时计）") : t("上传的文件") }),
      options: [{ id: "create", label: t("创建"), recommended: true }, { id: "exists", label: t("已在别的日历里"), detail: t("不再提醒") },
        { id: "skip", label: t("不需要"), detail: t("不写入日历") }] };
  });
}

/**
 * Background work the worker paused for this workspace (`BACKGROUND_BLOCKER`): an unreadable quota (an API-key login reports no
 * windows) or a spent one. It used to stop with nothing said, so captures sat unanalysed while the page looked normal. A worker that is
 * down is the runtime banner (`lib/runtime-status.ts`), not this one.
 */
function backgroundAsks({ store, ctx, t, locale }: Source): Ask[] {
  const paused = readFailure(store, ctx.workspaceId, BACKGROUND_BLOCKER) as ({ resetsAt?: string; reason?: string } & NonNullable<ReturnType<typeof readFailure>>) | null;
  if (!paused || paused.reason === "CODEX_SUPERVISOR_UNAVAILABLE") return [];
  const until = paused.resetsAt ? t("，预计 {{at}} 恢复", { at: localStamp(paused.resetsAt, effectiveSchedulePreferences(ctx).preferences.timeZone) }) : "";
  // What still works is said first (2026-10-18 evaluation): the schedule, calendar, reminders and timing need no model, and a person
  // told only 「已暂停」 read the whole system as stopped.
  const service = degradedService(paused.code);
  const spent = paused.code === "RATE_LIMIT_REACHED" || paused.code === "BUDGET_EXHAUSTED";
  const items = (list: string[]) => list.map((item) => t(item)).join(locale === "en" ? "; " : "；");
  // Every analysis, plan and draft waits on this, so it is both urgent and important: on 待确认 it sat in 不重要不紧急 while Today's
  // opener called it the most urgent thing (2026-10-17 walkthrough, W-22).
  return [{ id: `background:${paused.code}`, kind: "background_paused", entityId: "background", urgency: "now", important: true, raisedAt: paused.at,
    fingerprint: paused.code, title: spent ? t("模型额度用完了：排程照常，AI 生成暂停") : t("后台自动工作已暂停"),
    why: t("{{reason}}{{until}}。照常可用：{{works}}。暂停到恢复：{{paused}}。恢复后自动补上，不需要操作。",
      { reason: clause(paused.message), until, works: items(service.works), paused: items(service.paused) }),
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
  return [backplanAsks, waitingAsks, captureAsks, materialsAsks, gateAsks, riskAsks, riskReviewAsks, overdueAsks, missedAsks, prepQuestionAsks, lockedConflictAsks, agentAsks, calendarAsks, sourceProjectAsks, calendarLineAsks, interviewAsks, eventAsks, stepQuestionAsks,
    ({ ctx: context, now: at }: Source) => relationCheckAsks(context, at), backgroundAsks, ({ ctx: context, now: at }: Source) => outcomeAsks(context, at),
    ({ ctx: context, now: at }: Source) => progressAsks(context, at)]
    .flatMap((collect) => { try { return collect(source); } catch { return []; } })
    // One card per id: two with one id are the same question twice, and answering finds only the first.
    .filter((ask, index, all) => all.findIndex((other) => other.id === ask.id) === index);
}

/**
 * What a task's step plan could not read from the person's material or facts (decided 2026-10-09): the exam's scope, what they already
 * master, the format of the deliverable. Asked with the plan's own options; the answer is a confirmed fact every later plan reads, and
 * the task is planned again with it.
 *
 * Several open questions of one project come as one card (2026-10-18 evaluation: approving 19 milestones raised about 60 of them, one
 * card each): 「都按建议」 settles them all in one tap, 「逐条改」 opens one line per question where an empty line keeps the suggestion.
 * Batching interruptions is what the notification evidence supports (Fitz et al. 2019); each answer stays changeable on the task.
 */
type StepQuestionEntry = { order: StoredWorkOrder; plannedAt: string; version: number; question: { text: string; why?: string; options: string[] } };

/** The open step questions, one entry per question, the same question from two tasks of one project once (the answer is per project). */
function openStepQuestions({ store, ctx }: Source): StepQuestionEntry[] {
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).filter((order) => ["approved", "preparing", "ready_for_human", "active"].includes(order.state) && onPersonsBoard(order))
    .map((order) => [order.id, order]));
  const answered = new Set(store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT)).map((fact) => `${fact.projectId}|${fact.slot}`));
  const asked = new Set<string>();
  // What a task's own files answer (the problem set, how it is handed in, the AI rule) is read from them, never asked: the worker's task
  // pass writes it as an assumption, and it is left out here already so it never shows meanwhile.
  const withFiles = new Set(store.listSourceDocuments(ctx.workspaceId).map((doc) => doc.projectId).filter(Boolean));
  return store.listStepPlans(ctx.workspaceId).flatMap((plan) => {
    const order = orders.get(plan.workOrderId);
    if (!order) return [];
    return plan.questions.filter((question) => {
      const key = `${order.projectId}|${stepAnswerSlot(question.text)}`;
      if (withFiles.has(order.projectId) && readableFromMaterial(question.text)) return false;
      return !answered.has(key) && !asked.has(key) && Boolean(asked.add(key));
    }).map((question) => ({ order, plannedAt: plan.plannedAt, version: plan.version, question }));
  });
}

/** At most this many questions on one project card; the rest come on the next one. */
const STEP_QUESTIONS_PER_CARD = 8;

/** Questions with a suggestion, grouped by project where a project has two or more; the others are asked one by one. */
function stepQuestionGroups(source: Source): { groups: Map<string, StepQuestionEntry[]>; single: StepQuestionEntry[] } {
  const byProject = new Map<string, StepQuestionEntry[]>();
  const single: StepQuestionEntry[] = [];
  for (const entry of openStepQuestions(source)) {
    if (!entry.order.projectId || !entry.question.options[0]) { single.push(entry); continue; }
    byProject.set(entry.order.projectId, [...(byProject.get(entry.order.projectId) ?? []), entry]);
  }
  const groups = new Map<string, StepQuestionEntry[]>();
  for (const [projectId, entries] of byProject) {
    if (entries.length >= 2) groups.set(projectId, entries.slice(0, STEP_QUESTIONS_PER_CARD)); else single.push(...entries);
  }
  return { groups, single };
}

const URGENCY_RANK = { now: 0, soon: 1, later: 2 } as const;

function stepQuestionAsks(source: Source): Ask[] {
  const { store, ctx, today, t, locale } = source;
  const { groups, single } = stepQuestionGroups(source);
  const projects = new Map(store.listProjects(ctx.workspaceId, { includeArchived: true }).map((project) => [project.id, project.name]));
  const dueOf = (order: StoredWorkOrder) => (order.payload as { dueDate?: string } | undefined)?.dueDate;
  const batched = [...groups.entries()].map(([projectId, entries]): Ask => {
    const dueDay = entries.map((entry) => dueOf(entry.order)).filter((day): day is string => Boolean(day)).sort()[0];
    const urgency = entries.map((entry) => urgencyFor(dueOf(entry.order), today)).sort((a, b) => URGENCY_RANK[a] - URGENCY_RANK[b])[0]!;
    const name = projects.get(projectId) ?? projectId;
    return {
      id: `stepq:p:${projectId}`, kind: "step_question", entityId: projectId, line: entries[0]!.order.identityId,
      urgency, ...(dueDay ? { dueDay } : {}), raisedAt: entries.map((entry) => entry.plannedAt).sort().at(-1)!,
      fingerprint: entries.map((entry) => `${entry.version}:${stepAnswerSlot(entry.question.text)}`).join("|"),
      important: true, preview: taskPreview(t, entries[0]!.order.id),
      title: t("「{{name}}」有 {{count}} 个问题只有本人知道", { name: short(name, 20), count: entries.length }),
      why: t("{{list}}。", { list: entries.map((entry, index) => t("{{n}}. 「{{task}}」{{question}} → 建议：{{option}}", { n: index + 1,
        task: short(taskTitleOf(entry.order), 16), question: clause(entry.question.text), option: entry.question.options[0] })).join(locale === "en" ? "; " : "；") })
        + (locale === "en" ? " " : "") + t("可以都按建议处理，之后在任务详情里随时改；也可以逐条写自己的答案，留空的按建议。"),
      options: [
        { id: "accept", label: t("都按建议"), detail: t("每个任务按回答重排一次步骤；之后可在任务详情里改"), recommended: true },
        { id: "edit", label: t("逐条改"), fields: entries.map((entry, index) => ({ id: `q${index}`, label: `${index + 1}. ${short(entry.question.text, 40)}`,
          kind: "text" as const, required: false, placeholder: t("留空按建议：{{option}}", { option: entry.question.options[0] }) })) }
      ]
    };
  });
  const one = single.map(({ order, plannedAt, version, question }): Ask => {
    const due = dueOf(order);
    return {
      id: `stepq:${order.id}:${stepAnswerSlot(question.text)}`, kind: "step_question", entityId: order.id, line: order.identityId,
      urgency: urgencyFor(due, today), ...(due ? { dueDay: due } : {}), raisedAt: plannedAt, fingerprint: `${version}:${question.text}`,
      // The step planner asks only for important work and only what it cannot read from the material: its plan waits on the answer.
      important: true, preview: taskPreview(t, order.id),
      freeText: { placeholder: question.options[0] ? t("例如：{{option}}，或用自己的话说", { option: question.options[0] }) : t("用自己的话回答") },
      title: t("「{{task}}」：{{question}}", { task: short(taskTitleOf(order), 24), question: question.text }),
      why: (question.why ? t("{{reason}}。", { reason: clause(question.why) }) + (locale === "en" ? " " : "") : "")
        + t("回答后，这个任务的步骤会按回答重新安排；材料里已有的信息不会再问。"),
      options: [...question.options.map((option, index) => ({ id: `o${index}`, label: option,
        fields: [{ id: "other", label: t("补充"), kind: "text" as const, required: false, placeholder: t("可不填") }] })),
        { id: "free", label: t("都不是，我来写"), fields: [{ id: "other", label: t("回答"), kind: "text" as const, required: true }] }]
    };
  });
  return [...batched, ...one];
}

/** A project card's answer: each question its own line or the suggestion; each task asked is planned again once, with all its answers. */
function answerStepQuestionBatch(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>): AskResult {
  const entries = stepQuestionGroups({ store: getStore(), ctx, today: planToday(ctx), now: appNow(), t: tOf(ctx), locale: localeFor(ctx) }).groups.get(ask.entityId);
  if (!entries?.length) return { ok: false, code: "STEP_QUESTION_GONE" };
  if (optionId !== "accept" && optionId !== "edit") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const byOrder = new Map<string, string[]>();
  entries.forEach((entry, index) => {
    const own = optionId === "edit" ? (values[`q${index}`] ?? "").trim() : "";
    const answer = own || entry.question.options[0]!;
    /* i18n-ignore-start: the fact's quote and the replan note are read by the step planner (model context) */
    recordStepAnswer(ctx, entry.order, entry.question.text, answer, own || `按建议：${answer}`);
    byOrder.set(entry.order.id, [...(byOrder.get(entry.order.id) ?? []), `「${entry.question.text}」：${answer}`]);
  });
  for (const [orderId, lines] of byOrder) requestStepReplan(ctx, orderId, `本人回答了${lines.join("；")}。按此重新安排步骤。`);
  /* i18n-ignore-end */
  return { ok: true };
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
    case "gate_insufficient":
      if (optionId === "done") return acceptOwnCompletion(store, ctx.workspaceId, ask.entityId, `own-completion:${ask.entityId}:${ask.fingerprint}`)
        ? { ok: true } : { ok: false, code: "NOT_COMPLETED_BY_PERSON" };
      return optionId === "drop" ? archiveWorkOrder(ctx, ask.entityId, values.reason!) : approveWorkOrderProposal(ctx, ask.entityId);
    case "gate_failed": {
      record(ctx, "milestone_gate.retry_requested", ask.entityId, `milestone-gate:retry:${ask.entityId}:${Date.now()}`, { requestedBy: ctx.principalId });
      await requestCodexSupervisor(ctx, `/v1/work-orders/${ask.entityId}/milestone-gate`, { method: "POST", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      return { ok: true };
    }
    case "evidence_manual": return acceptWorkOrderEvidence(ctx, ask.entityId);
    case "milestone_risk": {
      if (optionId === "extend") {
        // Only the date: passing an importance here demoted every milestone moved this way to 「ordinary」 (2026-10-18 walkthrough).
        return saveGoalSettings(ctx, ask.entityId, { confirmedDeadline: values.date!, sourceQuote: tOf(ctx)("在「可能赶不上」的询问里推迟") });
      }
      const goal = loadGoalForecast(ctx, riskHorizonDays(ctx)).goals.find((item) => item.milestoneId === ask.entityId);
      record(ctx, "risk.accepted", ask.entityId, `risk:accepted:${ask.entityId}:${Date.now()}`, { slackDays: goal?.slackDays ?? -999, p85Day: goal?.p85Day ?? null });
      return { ok: true };
    }
    case "milestone_overdue": {
      const deadline = ask.fingerprint;
      const resolve = (how: string) => record(ctx, "milestone.overdue_resolved", ask.entityId, `milestone-overdue:resolved:${ask.entityId}:${deadline}:${Date.now()}`, { deadline, how });
      if (optionId === "extend") {
        const saved = saveGoalSettings(ctx, ask.entityId, { confirmedDeadline: values.date!, sourceQuote: tOf(ctx)("在「截止已过」的询问里改期") });
        if (!saved.ok) return saved;
      } else if (optionId === "drop") {
        const milestone = store.listMilestones(ctx.workspaceId).find((item) => item.id === ask.entityId);
        if (!milestone) return { ok: false, code: "MILESTONE_NOT_FOUND" };
        const saved = saveMilestoneEdit(ctx, { id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
          status: "archived", successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) });
        if (!saved.ok) return saved;
        // Work being timed stays; the rest of the milestone's open work goes with it.
        for (const order of store.listWorkOrders(ctx.workspaceId).filter((item) => item.milestoneId === milestone.id
          && ["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "blocked"].includes(item.state)))
          archiveWorkOrder(ctx, order.id, tOf(ctx)("里程碑「{{title}}」截止已过，本人选择放弃", { title: short(milestone.title, 20) }));
      } else if (optionId !== "makeup") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
      resolve(optionId);
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
    case "prep_question": return answerPrepQuestion(ctx, ask, optionId, choice.note || values.answer || "");
    case "agent_blocked": return answerAgentAsk(ctx, ask, { optionIds: choice.optionIds, values, note: choice.note });
    case "calendar_publish_failed":
      getStore().setSetting(ctx.workspaceId, CALENDAR_PUBLISH_FAILURE, "");
      forgetPublishedHash(ctx.workspaceId);
      void autoPublishPass().catch(() => {});
      return { ok: true };
    case "step_question": {
      if (ask.id.startsWith("stepq:p:")) return answerStepQuestionBatch(ctx, ask, optionId, values as Record<string, string>);
      const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === ask.entityId);
      const plan = order ? store.getStepPlan(ctx.workspaceId, order.id) : undefined;
      const question = plan?.questions.find((item) => ask.id.endsWith(stepAnswerSlot(item.text)));
      if (!order || !question) return { ok: false, code: "STEP_QUESTION_GONE" };
      const labels = ask.options.filter((item) => choice.optionIds.includes(item.id) && item.id !== "free").map((item) => item.label);
      const answer = [...new Set([...labels, (values.other ?? "").trim(), choice.note].filter(Boolean))].join("；");
      if (!answer) return { ok: false, code: "STEP_ANSWER_EMPTY" };
      recordStepAnswer(ctx, order, question.text, answer);
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
      if (ask.entityId === "batch") {
        const members = riskReviewMembers({ store, ctx, today: planToday(ctx), now: appNow(), t: tOf(ctx), locale: localeFor(ctx) });
        if (optionId === "split") {
          store.setSetting(ctx.workspaceId, RISK_REVIEW_SPLIT, ask.fingerprint);
          return { ok: true };
        }
        if (optionId !== "accept" && optionId !== "ignore") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
        const at = new Date().toISOString();
        store.setSetting(ctx.workspaceId, RISK_DECISIONS_SETTING, JSON.stringify({ ...readRiskDecisions(ctx),
          ...Object.fromEntries(members.map((member) => [member.entityId, { fingerprint: member.fingerprint, how: optionId, at } satisfies RiskDecision])) }));
        return { ok: true };
      }
      const how: RiskDecision["how"] | undefined = optionId === "accept" ? "accept" : optionId === "extend" ? "extend" : optionId === "ignore" ? "ignore" : undefined;
      if (!how) return { ok: false, code: "ASK_OPTION_UNKNOWN" };
      if (how === "extend") {
        const saved = saveGoalSettings(ctx, ask.entityId, { confirmedDeadline: values.date!, sourceQuote: tOf(ctx)("在里程碑风险的询问里调整截止") });
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
export async function answerAsk(ctx: AccessContext, askId: string, choice: string | { optionIds?: string[]; note?: string; seconds?: number },
  values: Record<string, unknown>, now = appNow()): Promise<AskResult> {
  // An interview question further down the round is not listed (one card at a time) but is still the person's to answer.
  const ask = collectAsks(ctx, now).find((item) => item.id === askId)
    ?? (askId.startsWith("iq:") && interviewStatus(ctx).parked ? interviewQuestionAsks(interviewStatus(ctx), tOf(ctx)).find((item) => item.id === askId) : undefined);
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
  // The question ledger keeps the answer beside the question, numbered, for the models that read it.
  if (result.ok && ask.kind !== "interview_question") {
    const store = getStore();
    const id = store.questionByKey(ctx.workspaceId, `ask:${ask.id}`)?.id ?? recordAsk(ctx, ask, now.toISOString());
    /* i18n-ignore-start: the question ledger is read by models */
    store.answerQuestion(ctx.workspaceId, id, { text: [checked.options.map((option) => option.label).join("、"), checked.note].filter(Boolean).join("。补充："),
      at: now.toISOString() });
    /* i18n-ignore-end */
  }
  if (result.ok) record(ctx, "ask.answered", ask.entityId, `ask:answered:${ask.id}:${ids.join("+") || "note"}:${now.getTime()}`,
    { askId: ask.id, kind: ask.kind, optionId: ids[0] ?? "", ...(ids.length > 1 ? { optionIds: ids } : {}), ...(checked.note ? { note: checked.note } : {}),
      // Seconds the card was on screen before the answer, when the page measured it: the decision's cost on 系统体检.
      ...(typeof choice !== "string" && choice.seconds !== undefined ? { seconds: choice.seconds } : {}) });
  return result;
}

/** 「明天再问」/「下周再问」: hidden until then, back sooner if what it is about changes. */
export function snoozeAsk(ctx: AccessContext, askId: string, choice: "tomorrow" | "week", now = appNow(), seconds?: number): AskResult {
  const ask = collectAsks(ctx, now).find((item) => item.id === askId);
  if (!ask) return { ok: false, code: "ASK_NOT_FOUND" };
  const until = snoozeUntil(choice, planToday(ctx, now));
  // Recorded as an operation, so 「明天再问」 pressed by mistake can be undone like any other answer.
  const before = new Set(getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).map((event) => event.eventId));
  record(ctx, "ask.snoozed", ask.entityId, `ask:snoozed:${ask.id}:${now.getTime()}`,
    { askId: ask.id, until, fingerprint: ask.fingerprint, ...(seconds === undefined ? {} : { seconds }) } satisfies AskSnooze & { seconds?: number });
  const added = getStore().listEvents(ctx.workspaceId, { type: "ask.snoozed" }).filter((event) => !before.has(event.eventId)).map((event) => event.eventId);
  if (added.length) recordOp(ctx, tOf(ctx)(choice === "tomorrow" ? "明天再问：{{title}}" : "下周再问：{{title}}", { title: ask.title }), { kind: "event.retract", eventIds: added });
  return { ok: true };
}

/**
 * Writes what is waiting for the person where the worker's notifications read it, so the morning brief, the badge and
 * an urgent message all count the same things. Called on the web's own timer.
 */
export function writeAttentionSnapshot(ctx: AccessContext, pending: number, now = new Date()): void {
  const open = openAsks(ctx, now);
  syncAskLedger(ctx, open, now.toISOString());
  const asks = listed(open).map((ask) => ({ id: ask.id, title: ask.title, urgency: ask.urgency, dueDay: ask.dueDay ?? null,
    path: ask.urgency === "now" ? "/" : "/approvals#asks" }));
  getStore().setSetting(ctx.workspaceId, ATTENTION_SNAPSHOT, JSON.stringify({ at: now.toISOString(), pending, asks }));
  // A round whose remaining questions were dead (answered, no longer asked, screened out) still holds the answers given on 待决事项:
  // they go to the interview here, on the same timer, so a restarted resident app settles it by itself.
  void flushPendingAnswers(ctx, sendInterviewReply(ctx)).catch(() => undefined);
}

/** One ask in the question ledger (`ask:<id>`), open; returns its number. The interview's own questions are kept by the interview. */
function recordAsk(ctx: AccessContext, ask: Ask, at: string): number {
  return getStore().recordQuestion(ctx.workspaceId, { kind: "ask", key: `ask:${ask.id}`, text: ask.title, options: ask.options.map((option) => option.label),
    identityId: ask.line ?? "", status: "open", at });
}

/**
 * 待决事项 in the question ledger (2026-10-19), on the web's ten-minute timer: every open ask once, numbered, and an ask whose cause went
 * away no longer asked. Step questions are asks, so they are here too.
 */
export function syncAskLedger(ctx: AccessContext, asks: Ask[], at: string): void {
  const live = new Set<string>();
  for (const ask of asks) {
    if (ask.kind === "interview_question") continue;
    live.add(`ask:${ask.id}`);
    recordAsk(ctx, ask, at);
  }
  const store = getStore();
  for (const question of store.listQuestions(ctx.workspaceId, { kind: "ask", statuses: ["pending", "open"] }))
    if (!live.has(question.key)) store.dropQuestion(ctx.workspaceId, question.id, at);
}
