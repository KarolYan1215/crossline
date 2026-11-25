import "server-only";
import {
  CANNOT_JUDGE, estimateRatio, GATE_CONFIRMED, GATE_GOAL_MAX_CHARS, GATE_GOAL_SETTING, GATE_IDS, GATE_JUDGED, GATE_LABEL, GATE_OVERRIDDEN, GATE_SPEC, GATE_VERDICT_LABEL, GATE_VERDICTS,
  gateWeekStats, latestGateJudgements, MILESTONE_PARKED, MILESTONE_UNPARKED, nightCounts, OPEN_TASK_STATES, parkedMilestones, taskTitleOf, todaysFront, verdictOf,
  type AccessContext, type Ask, type GateJudgedPayload, type GateJudgement, type GateOverriddenPayload, type GateWeekStats
} from "@crossline/core";
import { appNow, getStore, planToday, saveMilestoneEdit } from "./crossline";
import { tFor } from "./i18n";
import { localeFor } from "./locale";

/**
 * The execution gates, the web's half (docs/plans/execution-gates-1124.md §四). The worker judges and records (`gate.judged`); here the
 * person sees a judgement put to them (`gate_check` on 待确认), turns one over (`gate.overridden`) or says it was right
 * (`gate.confirmed`), sees today's front task first on Today, reports a setback, and reads the week's gates in the weekly review.
 */
const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const gateEvents = (workspaceId: string) => getStore().listEvents(workspaceId, { type: [GATE_JUDGED, GATE_OVERRIDDEN, GATE_CONFIRMED] });
/** A parked milestone is asked about once a month (the person's rule, §四 J2a). */
const PARK_ASK_DAYS = 30;
const DAY = 86_400_000;

function subjectTitle(ctx: AccessContext, judgement: GateJudgement): string {
  const store = getStore();
  const { kind, id } = judgement.payload.subject;
  if (kind === "task") { const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === id); return order ? taskTitleOf(order) : id; }
  if (kind === "milestone") return store.listMilestones(ctx.workspaceId).find((item) => item.id === id)?.title ?? id;
  return judgement.payload.output.reason;
}

/**
 * What the person last said about each subject, by gate: the verdict they confirmed or turned it to. A re-judgement that says the same
 * again is not asked again.
 */
function lastAnswers(events: ReturnType<typeof gateEvents>): Map<string, string> {
  const judged = new Map(events.filter((event) => event.type === GATE_JUDGED).map((event) => [event.eventId, event.payload as GateJudgedPayload]));
  const out = new Map<string, string>();
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const original = event.type === GATE_CONFIRMED || event.type === GATE_OVERRIDDEN ? judged.get(event.type === GATE_CONFIRMED ? event.entityId : (event.payload as GateOverriddenPayload).judgedId) : undefined;
    if (!original) continue;
    out.set(`${original.gate}:${original.subject.kind}:${original.subject.id}`, event.type === GATE_CONFIRMED ? original.output.verdict : (event.payload as GateOverriddenPayload).to);
  }
  return out;
}

/** Judgements the worker marked `asked` (`gateNeedsPerson`) that the person has not answered, and that say something new to them. */
export function gateCheckAsks(ctx: AccessContext, now = appNow()): Ask[] {
  const t = tFor(localeFor(ctx));
  const events = gateEvents(ctx.workspaceId);
  const confirmed = new Set(events.filter((event) => event.type === GATE_CONFIRMED).map((event) => event.entityId));
  const answered = lastAnswers(events);
  const asks: Ask[] = [];
  for (const gate of GATE_IDS.filter((id) => GATE_SPEC[id].asks)) {
    for (const judgement of latestGateJudgements(events, gate).values()) {
      const { payload } = judgement;
      if (!payload.asked || judgement.overridden || confirmed.has(judgement.eventId)) continue;
      if (answered.get(`${gate}:${payload.subject.kind}:${payload.subject.id}`) === payload.output.verdict) continue;
      const verdict = payload.output.verdict;
      const title = subjectTitle(ctx, judgement);
      asks.push({
        id: `gatecheck:${judgement.eventId}`, kind: "gate_check", entityId: judgement.eventId, urgency: payload.output.ifWrong.harm === "deadline" || payload.output.ifWrong.harm === "external" ? "soon" : "later",
        raisedAt: judgement.at, fingerprint: `${judgement.eventId}|${verdict}`,
        title: t("{{gate}}：「{{title}}」判为「{{verdict}}」，对吗？", { gate: t(GATE_LABEL[gate]), title: short(title, 40), verdict: t(GATE_VERDICT_LABEL[verdict] ?? verdict) }),
        why: [payload.output.reason, payload.asked && (payload.output.ifWrong.harm === "external" || payload.output.ifWrong.harm === "deadline")
          ? t("判错的代价：{{harm}}", { harm: payload.output.ifWrong.harm === "external" ? t("会影响到别人") : t("会误截止") }) : "",
          ...(payload.output.evidence.slice(0, 2).map((item) => `「${short(item.quote, 80)}」`))].filter(Boolean).join(" "),
        options: [{ id: "right", label: t("对"), recommended: true },
          ...GATE_VERDICTS[gate].filter((item) => item !== verdict).map((item) => ({ id: `to:${item}`, label: t("改为「{{verdict}}」", { verdict: t(GATE_VERDICT_LABEL[item] ?? item) }) }))],
        freeText: { placeholder: t("哪里判错了（可不填）") }
      });
    }
  }
  return [...asks, ...parkedAsks(ctx, now)];
}

/** Once a month per parked milestone: 开 / 继续停 / 丢掉. */
function parkedAsks(ctx: AccessContext, now: Date): Ask[] {
  const t = tFor(localeFor(ctx));
  const store = getStore();
  const parked = parkedMilestones(store.listEvents(ctx.workspaceId, { type: [MILESTONE_PARKED, MILESTONE_UNPARKED, "milestone.kept_parked"] }));
  const kept = new Map<string, string>();
  for (const event of store.listEvents(ctx.workspaceId, { type: "milestone.kept_parked" })) if ((kept.get(event.entityId) ?? "") < event.createdAt) kept.set(event.entityId, event.createdAt);
  const milestones = new Map(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item]));
  return [...parked.entries()].flatMap(([id, entry]): Ask[] => {
    const milestone = milestones.get(id);
    if (!milestone || milestone.status !== "draft") return [];
    const last = [entry.at, kept.get(id) ?? ""].sort().at(-1)!;
    if (now.getTime() - Date.parse(last) < PARK_ASK_DAYS * DAY) return [];
    return [{ id: `gatecheck:parked:${id}`, kind: "gate_check", entityId: `parked:${id}`, urgency: "later", line: milestone.identityId,
      raisedAt: last, fingerprint: `parked|${id}|${last}`,
      title: t("停放的里程碑「{{title}}」：现在开吗？", { title: short(milestone.title, 40) }),
      why: entry.unparkWhen ? t("停放时说等「{{after}}」完成再开。", { after: entry.unparkWhen }) : entry.reason,
      options: [{ id: "open", label: t("开") }, { id: "keep", label: t("继续停"), recommended: true }, { id: "drop", label: t("丢掉"), detail: t("归档，不再问") }] }];
  });
}

/** Turns a judgement over (or says it was right): the record the weekly review counts. */
export function overrideGate(ctx: AccessContext, input: { judgedId: string; to: string; note?: string }): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const judged = store.listEvents(ctx.workspaceId, { type: GATE_JUDGED }).find((event) => event.eventId === input.judgedId);
  if (!judged) return { ok: false, code: "GATE_JUDGEMENT_NOT_FOUND" };
  const payload = judged.payload as GateJudgedPayload;
  const note = (input.note ?? "").trim().slice(0, 500);
  if (input.to === payload.output.verdict) {
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: GATE_CONFIRMED, entityId: input.judgedId,
      idempotencyKey: `${GATE_CONFIRMED}:${input.judgedId}`, payload: { gate: payload.gate, subject: payload.subject, ...(note ? { note } : {}) } });
    return { ok: true };
  }
  if (!GATE_VERDICTS[payload.gate].includes(input.to) && input.to !== CANNOT_JUDGE) return { ok: false, code: "GATE_VERDICT_UNKNOWN" };
  const override: GateOverriddenPayload = { judgedId: input.judgedId, gate: payload.gate, subject: payload.subject, from: payload.output.verdict, to: input.to, ...(note ? { note } : {}) };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: GATE_OVERRIDDEN, entityId: input.judgedId,
    idempotencyKey: `${GATE_OVERRIDDEN}:${input.judgedId}:${Date.now()}`, payload: override });
  return { ok: true };
}

export function answerGateCheck(ctx: AccessContext, ask: Ask, optionId: string, note: string): { ok: true } | { ok: false; code: string } {
  if (ask.entityId.startsWith("parked:")) return answerParked(ctx, ask.entityId.slice("parked:".length), optionId);
  const judged = getStore().listEvents(ctx.workspaceId, { type: GATE_JUDGED }).find((event) => event.eventId === ask.entityId);
  if (!judged) return { ok: false, code: "GATE_JUDGEMENT_NOT_FOUND" };
  const from = (judged.payload as GateJudgedPayload).output.verdict;
  if (optionId === "right") return overrideGate(ctx, { judgedId: ask.entityId, to: from, note });
  if (optionId.startsWith("to:")) return overrideGate(ctx, { judgedId: ask.entityId, to: optionId.slice(3), note });
  return { ok: false, code: "ASK_OPTION_UNKNOWN" };
}

/** 开: approved again (its worked-back tasks follow the approval as usual). 继续停: asked again in a month. 丢掉: archived. */
function answerParked(ctx: AccessContext, milestoneId: string, optionId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const milestone = store.listMilestones(ctx.workspaceId).find((item) => item.id === milestoneId);
  if (!milestone) return { ok: false, code: "MILESTONE_NOT_FOUND" };
  const at = Date.now();
  if (optionId === "keep") {
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: "milestone.kept_parked", entityId: milestoneId, idempotencyKey: `milestone.kept_parked:${milestoneId}:${at}`, payload: {} });
    return { ok: true };
  }
  if (optionId !== "open" && optionId !== "drop") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const saved = saveMilestoneEdit(ctx, { id: milestoneId, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: milestone.title,
    status: optionId === "open" ? "approved" : "archived", successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) });
  if (!saved.ok) return saved;
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: MILESTONE_UNPARKED, entityId: milestoneId, idempotencyKey: `${MILESTONE_UNPARKED}:${milestoneId}:${at}`,
    payload: { by: "person", choice: optionId } });
  return { ok: true };
}

/** Today's front task (J4), when the model picked one and the person did not turn it over. */
export function frontForToday(ctx: AccessContext, now = appNow()) {
  const pick = todaysFront(gateEvents(ctx.workspaceId), planToday(ctx, now));
  if (!pick) return null;
  const order = getStore().listWorkOrders(ctx.workspaceId).find((item) => item.id === pick.task);
  if (!order || order.tombstone || !OPEN_TASK_STATES.has(order.state)) return null;
  return { ...pick, title: taskTitleOf(order) };
}

/** 「不是这件」 on Today: today's pick turned to `none`. */
export function dismissFront(ctx: AccessContext, eventId: string, note?: string) {
  return overrideGate(ctx, { judgedId: eventId, to: "none", ...(note ? { note } : {}) });
}

/** The goal the gates judge against, pasted by the person (`GATE_GOAL_SETTING`; read by the worker's gates). */
export const gateGoal = (ctx: AccessContext) => getStore().getSetting(ctx.workspaceId, GATE_GOAL_SETTING) ?? "";
export function saveGateGoal(ctx: AccessContext, text: string): { ok: true } {
  getStore().setSetting(ctx.workspaceId, GATE_GOAL_SETTING, text.trim().slice(0, GATE_GOAL_MAX_CHARS));
  return { ok: true };
}

/** The person names a setback in their own words (J2b): the worker classifies it at its next pass. */
export function reportSetback(ctx: AccessContext, text: string, line?: string): { ok: true; id: string } | { ok: false; code: string } {
  const clean = text.trim().slice(0, 2000);
  if (!clean) return { ok: false, code: "SETBACK_EMPTY" };
  const written = getStore().appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, type: "setback.reported", entityId: ctx.workspaceId,
    idempotencyKey: `setback.reported:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, payload: { text: clean, ...(line ? { line } : {}) } });
  return { ok: true, id: written.eventId };
}

export type GateReview = {
  stats: Array<GateWeekStats & { label: string; code: string }>;
  /** P1 / outward tasks the person pressed 完成 on that the completion gate did not find done or submitted (§四 J1). */
  claimedNoEvidence: Array<{ id: string; title: string; verdict: string; reason: string }>;
  attention: { verdict: string; reason: string; hours: Record<string, number>; crossline: number; metaShare: number; unclear: string } | null;
  ratio: { median: number; p25: number; p75: number; n: number } | null;
  night: { own: number; ownIrreversible: number; held: number };
  parked: Array<{ id: string; title: string; unparkWhen: string; at: string }>;
  overrides: Array<{ gate: string; title: string; from: string; to: string; note: string; at: string }>;
};

/** The weekly review's 「关口」 section for the week `[sinceIso, untilIso)`. */
export function loadGateReview(ctx: AccessContext, sinceIso: string, untilIso: string, now = appNow()): GateReview {
  const store = getStore();
  const t = tFor(localeFor(ctx));
  const events = gateEvents(ctx.workspaceId);
  const stats = gateWeekStats(events, sinceIso, untilIso).map((row) => ({ ...row, label: t(GATE_LABEL[row.gate]), code: row.gate }));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const completion = latestGateJudgements(events, "completion");
  const priority = latestGateJudgements(events, "priority");
  const claimedNoEvidence = store.listEvents(ctx.workspaceId, { type: "human.completed" }).filter((event) => event.createdAt >= sinceIso && event.createdAt < untilIso).flatMap((event) => {
    const id = String((event.payload as { workOrderId?: string }).workOrderId ?? event.entityId);
    const label = priority.get(`task:${id}`);
    if (!label || verdictOf(label) === "normal") return [];
    const judged = completion.get(`task:${id}`);
    const verdict = judged ? verdictOf(judged) : "";
    if (verdict === "done" || verdict === "submitted") return [];
    const order = orders.get(id);
    return [{ id, title: order ? taskTitleOf(order) : id, verdict: verdict || "not_judged", reason: judged?.payload.output.reason ?? "" }];
  });
  // The audit of this week, written at the start of the next one: the only one shown here.
  const audit = latestGateJudgements(events, "attention").get(`week:${sinceIso.slice(0, 10)}`);
  const computed = (audit?.payload.computed ?? {}) as { hours?: Record<string, number>; crossline?: number; metaShare?: number };
  const attention = audit ? { verdict: verdictOf(audit), reason: audit.payload.output.reason, hours: computed.hours ?? {},
    crossline: computed.crossline ?? 0, metaShare: computed.metaShare ?? 0, unclear: String((audit.payload.output.detail as { unclear?: string }).unclear ?? "") } : null;
  const ratio = estimateRatio(store.listAllDurationObservations(ctx.workspaceId), now);
  const night = nightCounts(events, sinceIso, untilIso);
  const milestones = new Map(store.listMilestones(ctx.workspaceId).map((item) => [item.id, item]));
  const parked = [...parkedMilestones(store.listEvents(ctx.workspaceId, { type: [MILESTONE_PARKED, MILESTONE_UNPARKED] })).entries()]
    .filter(([id]) => milestones.get(id)?.status === "draft").map(([id, entry]) => ({ id, title: milestones.get(id)?.title ?? id, unparkWhen: entry.unparkWhen, at: entry.at }));
  const judgedById = new Map(events.filter((event) => event.type === GATE_JUDGED).map((event) => [event.eventId, event.payload as GateJudgedPayload]));
  const overrides = events.filter((event) => event.type === GATE_OVERRIDDEN && event.createdAt >= sinceIso && event.createdAt < untilIso).map((event) => {
    const payload = event.payload as GateOverriddenPayload;
    const judged = judgedById.get(payload.judgedId);
    const order = judged?.subject.kind === "task" ? orders.get(judged.subject.id) : undefined;
    return { gate: t(GATE_LABEL[payload.gate]), title: order ? taskTitleOf(order) : milestones.get(payload.subject.id)?.title ?? payload.subject.id,
      from: t(GATE_VERDICT_LABEL[payload.from] ?? payload.from), to: t(GATE_VERDICT_LABEL[payload.to] ?? payload.to), note: payload.note ?? "", at: event.createdAt };
  });
  return { stats, claimedNoEvidence, attention, ratio: ratio ? { median: ratio.median, p25: ratio.p25, p75: ratio.p75, n: ratio.n } : null,
    night: { own: night.own, ownIrreversible: night.ownIrreversible, held: night.held }, parked, overrides };
}
