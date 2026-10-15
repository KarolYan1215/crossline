import "server-only";
import { OUTCOME_LEVELS, outcomeCriteriaVerdict, taskTitleOf, type AccessContext, type Ask, type AskOption, type NudgeInput } from "@crossline/core";
import { getStore } from "./crossline";
import type { PendingAssessment } from "./crossline";

/**
 * Following up finished work whose result was not known when it was finished (the owner's decision of 2026-10-15; `completion.ts` in
 * core). Completing already accepted the task; this only learns how it went. The 小帮手 asks at an idle moment (`outcome_check` nudges)
 * and the same question stands as an ask, so the answer can be given from the nudge's buttons, from 待决事项 or by typing it.
 *
 * Ledger: `assessment.pending` (written at completion) → `assessment.answered` (how it went, a score, or 「不再跟进」) or
 * `assessment.deferred` (the day the result comes out; asked again then). A score read against the milestone's one threshold also
 * writes a `milestone_gate.judged` with `source: "person_outcome"`, which is how the milestone's progress learns it.
 */
type Pending = { orderId: string; eventId: string; pending: PendingAssessment; askAfter: string; raisedAt: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const short = (text: string, length = 30) => text.length > length ? `${text.slice(0, length)}…` : text;

/** Every follow-up still open, with when it may next be asked (a deferral moves it). */
export function openAssessments(ctx: AccessContext): Pending[] {
  const store = getStore();
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const closed = new Set(store.listEvents(ctx.workspaceId, { type: "assessment.answered" })
    .map((event) => String((event.payload as { pendingEventId?: string }).pendingEventId ?? "")));
  const deferred = new Map<string, string>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "assessment.deferred" })) {
    const payload = event.payload as { pendingEventId?: string; until?: string };
    if (payload.pendingEventId && payload.until) deferred.set(payload.pendingEventId, payload.until);
  }
  return store.listEvents(ctx.workspaceId, { type: "assessment.pending" }).flatMap((event) => {
    // An order taken back out of `accepted` (revoked, archived) has nothing to follow up.
    if (closed.has(event.eventId) || orders.get(event.entityId)?.state !== "accepted") return [];
    const pending = event.payload as PendingAssessment;
    const until = deferred.get(event.eventId);
    return [{ orderId: event.entityId, eventId: event.eventId, pending, raisedAt: event.createdAt,
      askAfter: until ? `${until}T08:00:00.000Z` > pending.askAfter ? `${until}T08:00:00.000Z` : pending.askAfter : pending.askAfter }];
  });
}

const laterOption: AskOption = { id: "later", label: "结果还没出来", detail: "到那天再问",
  fields: [{ id: "date", label: "预计哪天知道结果", kind: "date", required: true }] };
const stopOption: AskOption = { id: "stop", label: "不再跟进", detail: "任务保持已验收，不记完成情况" };

/** The asks: only those due now (a deferred one stays out until its day). */
export function outcomeAsks(ctx: AccessContext, now: Date): Ask[] {
  const store = getStore();
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  return openAssessments(ctx).filter((item) => Date.parse(item.askAfter) <= now.getTime()).flatMap((item): Ask[] => {
    const order = orders.get(item.orderId);
    if (!order) return [];
    const scored = item.pending.reason === "result_pending";
    const options: AskOption[] = scored
      ? [{ id: "result", label: "结果已出", recommended: true, fields: [{ id: "score", label: "成绩或结果", kind: "text", required: true, placeholder: "例如：92/100，或「已录用」" }] }, laterOption, stopOption]
      : [...OUTCOME_LEVELS.map((level, index) => ({ id: level.id, label: level.label, ...(index === 0 ? { recommended: true } : {}),
        fields: [{ id: "note", label: "一句话", kind: "text" as const, required: false, placeholder: "可不填" }] })), { ...laterOption, label: "还说不准" }, stopOption];
    return [{ id: `outcome:${item.orderId}:${item.eventId}`, kind: "outcome_check", entityId: item.orderId, line: order.identityId,
      urgency: "later", raisedAt: item.raisedAt, fingerprint: `${item.eventId}:${item.askAfter}`,
      title: item.pending.question || `「${short(taskTitleOf(order))}」完成得怎么样？`,
      why: scored ? "任务已验收。成绩或结果出来后记入里程碑进度；还没出来就说哪天出，到那天再问。"
        : "任务已验收。完成情况记入任务记录，帮助之后的安排；不必回答也不影响任何事。",
      freeText: { placeholder: scored ? "例如：92 分；或「下周三出成绩」" : "用一句话说说完成情况" },
      preview: { kind: "task", href: `/workbench/${encodeURIComponent(order.id)}`, label: "看任务" }, options }];
  });
}

/** What the nudge pass offers the 小帮手: due follow-ups with the buttons that answer them in one tap. */
export function outcomeNudgeInputs(ctx: AccessContext, now: Date): NonNullable<NudgeInput["outcomes"]> {
  return outcomeAsks(ctx, now).map((ask) => {
    const scored = ask.options.some((option) => option.id === "result");
    return { askId: ask.id, orderId: ask.entityId, question: ask.title, fingerprint: ask.fingerprint,
      // A score and a date need words, so for a score the buttons are only a cue to type.
      options: scored ? [] : OUTCOME_LEVELS.map((level) => ({ id: level.id, label: level.label })),
      laterLabel: scored ? "说一下成绩，或哪天出结果" : "还说不准，说个日期" };
  });
}

/** Carries out the answer to an `outcome_check` ask. */
export function answerOutcome(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>, note: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const pendingEventId = ask.id.split(":").slice(2).join(":");
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === ask.entityId);
  if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
  const write = (type: string, payload: Record<string, unknown>) => store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `${type}:${pendingEventId}:${Date.now()}`, type, entityId: order.id, payload: { pendingEventId, ...payload } });
  if (optionId === "later") {
    if (!DAY.test(values.date ?? "")) return { ok: false, code: "ASK_FIELD_REQUIRED" };
    write("assessment.deferred", { until: values.date, ...(note ? { note } : {}) });
    return { ok: true };
  }
  if (optionId === "stop") { write("assessment.answered", { level: "", stopped: true }); return { ok: true }; }
  const level = OUTCOME_LEVELS.find((item) => item.id === optionId)?.id ?? "";
  const score = optionId === "result" ? (values.score ?? "").trim() : !level && /\d/.test(note) ? note : "";
  write("assessment.answered", { level, score, note: (values.note ?? note ?? "").trim().slice(0, 300) });
  // A score against the milestone's one threshold is progress on the milestone, recorded the way the gate records it.
  const milestone = order.milestoneId ? store.listMilestones(ctx.workspaceId).filter((item) => item.id === order.milestoneId && item.status === "approved").at(-1) : undefined;
  const readings = milestone && score ? outcomeCriteriaVerdict(milestone.successCriteria, score) : [];
  if (milestone && readings.length) store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `milestone_gate.judged:outcome:${pendingEventId}`, type: "milestone_gate.judged", entityId: order.id,
    payload: { milestoneId: milestone.id, milestoneVersion: milestone.version, verdict: readings.every((item) => item.met === "met") ? "pass" : "partial",
      source: "person_outcome", criteriaVerdict: readings } });
  return { ok: true };
}
