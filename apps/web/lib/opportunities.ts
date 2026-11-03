import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY_PART_LABEL, LESS_REASONS, LESS_REASON_LABEL, SCOUT_STATS_SETTING, WEEKDAY_LABEL, eligibilityAnswer, exploreAccount,
  nextDeadline, prepStartFor, readScoutStats, stepLeavesMachine, taskTitleOf, watchYield, type AccessContext, type Ask, type AskField, type AskOption, type FormRunState, type FormStop,
  type LessEntry, type LessReason, type OpportunityOutcome, type StoredWatch, type WatchTarget
} from "@crossline/core";
import {
  addPersonWatch, assistantAvailable, decideWatch, editWatch, isScoutFind, lessLog, lessOpportunity, opportunityCosts, outcomesOf, queueFormRun,
  readFormRuns, readWatchList, readWatchTuning, recordApplicationResult, recordEligibilityAnswer, recordOpportunityOutcome, setWatchState,
  surfacedOpportunities, undoLessEntry, watchOf, type StoredOpportunity, type WatchEdit
} from "@crossline/db";
import { getStore, planToday, saveGoalSettings, saveMilestoneEdit } from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { identityLines } from "./lines";
import { localeFor } from "./locale";
import { tFor } from "./i18n";
import { answerClash, clashOptions, holdEventTime, judgeOpportunity, spaceLines } from "./opportunity-space";

/**
 * The web side of the opportunity agent (docs/opportunity-agent.md §5, §8, §17): the cards for proposed watches (盯住 / 不要), for each
 * opportunity the person qualifies for or might (报名 / 申请 / 加入计划 / 少来 / 不要 / 以后再说), a registration's progress while the form
 * filler works on it, the result of an application once its deadline passed — and what each answer writes. Then the watches on the line
 * card, the settings table and the weekly review's 视野外. Everything exists only in the machine owner's workspace (the worker runs
 * watches only there), so no card appears anywhere else.
 */

const DAY = 86_400_000;
const daysUntil = (today: string, day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
const short = (text: string, length = 40) => text.length > length ? `${text.slice(0, length)}…` : text;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** The machine owner's workspace, never on the hosted beta: where the worker runs watches and the form filler works (§0). */
export const opportunityOwner = (ctx: AccessContext): boolean => assistantAvailable(getStore(), ctx.workspaceId);

/** Where a watch looks, in the person's words. */
export function targetLabel(target: WatchTarget, t: ReturnType<typeof tFor>): string {
  switch (target.tool) {
    case "ats_board": return t("{{provider}} 岗位 {{board}}", { provider: target.provider, board: target.board });
    case "deadline_list": return t("截止库 {{list}}：{{query}}", { list: target.list, query: target.query });
    case "devpost": return t("Devpost：{{query}}", { query: target.query });
    case "events_site": return t("{{site}}：{{query}}", { site: target.site, query: target.query });
    case "web_fetch": return target.url;
    case "mail_search": return target.from ? t("邮件 {{from}}：{{query}}", { from: target.from, query: target.query }) : t("邮件：{{query}}", { query: target.query });
    case "web_search": return t("网页检索：{{query}}", { query: target.query });
    case "site_read": return `${target.host}${target.path}`;
  }
}
const whereOf = (watch: StoredWatch, t: ReturnType<typeof tFor>) =>
  (watch.targets ?? []).map((target) => targetLabel(target, t)).slice(0, 4).join(", ") || t("网页检索：{{query}}", { query: short(watch.query, 60) });

/** Proposed watches the line's derivation wrote; the scout's and exploration's wait for 视野外 in the weekly review instead. */
export function opportunityNeedAsks(ctx: AccessContext): Ask[] {
  const t = tFor(localeFor(ctx));
  const sep = localeFor(ctx) === "en" ? " " : "";
  return readWatchList(getStore(), ctx.workspaceId).filter((watch) => watch.state === "proposed" && (watch.origin === "derived" || watch.origin === "migrated") && !watch.explore).map((watch): Ask => ({
    id: `oppneed:${watch.id}`, kind: "opportunity_need", entityId: watch.id, line: watch.lineId, urgency: "soon",
    raisedAt: watch.createdAt, fingerprint: `${watch.title}|${watch.query}|${watch.cycle?.opens ?? ""}`,
    important: watch.basis.milestoneIds.length > 0,
    title: t("要不要盯住「{{title}}」？", { title: watch.title }),
    why: watch.why + sep + t("会看：{{where}}。盯住后每 {{days}} 天看一次，找到符合资格的会出现在早报和这里。", { where: whereOf(watch, t), days: watch.everyDays }),
    options: [
      { id: "track", label: t("盯住"), recommended: true, detail: watch.cycle?.opens ? t("写一条「预计 {{month}} 开放」的等待项", { month: watch.cycle.opens }) : t("每 {{days}} 天看一次", { days: watch.everyDays }) },
      { id: "decline", label: t("不要"), detail: t("记成偏好，不再推同类"), fields: [{ id: "note", label: t("原因"), kind: "text", required: false }] }
    ]
  }));
}

export function answerOpportunityNeed(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>): { ok: true } | { ok: false; code: string } {
  if (optionId !== "track" && optionId !== "decline") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const decided = decideWatch(getStore(), ctx.workspaceId, ctx.principalId, ask.entityId, optionId === "track" ? "active" : "retired", new Date(), values.note ?? "");
  return decided ? { ok: true } : { ok: false, code: "OPPORTUNITY_NEED_NOT_FOUND" };
}

/** A registration's progress in the person's words (§17.9 gap): what the offer card shows while the form filler works on it. */
export const FORM_PROGRESS: Record<FormRunState, string> = {
  queued: "填写中", filling: "填写中", waiting_person: "等本人", ready_to_submit: "等本人", stopped: "等本人", submitted: "已提交", confirmed: "已确认"
};
/** How long a confirmed registration stays on the card, so the person sees it went through. */
const CONFIRMED_SHOWN_MS = DAY;

/** The reasons under 少来, as the one-tap choice field. */
const lessReasonField = (t: ReturnType<typeof tFor>): AskField => ({ id: "reason", label: t("原因"), kind: "choice", required: false,
  choices: LESS_REASONS.map((reason) => ({ id: reason, label: t(LESS_REASON_LABEL[reason]) })) });

export function opportunityOfferAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const sep = locale === "en" ? " " : "";
  const store = getStore();
  const today = planToday(ctx, now);
  // Judged on read from the worker's caches (§17.6): what can no longer be reached is not shown at all.
  const offers = surfacedOpportunities(store, ctx.workspaceId, today).filter((row) => row.inbox)
    .flatMap((row) => { const verdict = judgeOpportunity(ctx, row, now, locale); return verdict.state === "infeasible" ? [] : [{ row, verdict }]; })
    .map(({ row, verdict }): Ask => {
    const deadline = nextDeadline(row, today);
    const watch = row.watch;
    const left = deadline ? daysUntil(today, deadline) : undefined;
    const start = prepStartFor(deadline, watch?.leadDays ?? 0);
    const quote = row.deadlines.find((item) => item.day === deadline)?.quote;
    const facts = row.verdict.state === "eligible" && row.terms.length ? t("资格：按记录全部符合。") : "";
    const questions = row.verdict.state === "unknown" ? row.verdict.questions : [];
    const parts = [
      watch ? t("来自监视项「{{title}}」。", { title: watch.title }) : isScoutFind(row) ? t("每周侦察发现。") : "",
      deadline ? t("截止 {{day}}（原文：{{quote}}）。", { day: deadline, quote: short(quote ?? "", 80) }) : t("页面没写截止。"),
      start && start > today ? t("最晚 {{day}} 开始准备。", { day: start }) : "",
      row.cost ? t("费用：{{amount}} {{currency}}。", { amount: row.cost.amount, currency: row.cost.currency }) : "",
      row.location && !row.place ? t("地点：{{place}}。", { place: row.location }) : "",
      ...spaceLines(row, verdict, locale),
      facts,
      questions.length ? t("还差 {{count}} 条资格要本人确认，答案会记进资料，下次不再问。", { count: questions.length }) : "",
      row.materials.length ? t("需要：{{items}}。", { items: row.materials.slice(0, 4).join(locale === "en" ? ", " : "、") }) : "",
      row.consents.length ? t("报名即同意：{{items}}。", { items: row.consents.slice(0, 3).join(locale === "en" ? "; " : "；") }) : ""
    ].filter(Boolean);
    const answerFields: AskField[] = questions.map((question, index) => ({ id: `q${index}`, label: question.question, kind: "text", required: true }));
    const options: AskOption[] = [
      ...(answerFields.length ? [{ id: "answer", label: t("回答资格问题"), recommended: true, fields: answerFields }] : []),
      row.kind === "event"
        ? { id: "register", label: t("报名"), detail: t("交给代填：免费活动填完自动提交，其余停在提交前等本人"), recommended: !answerFields.length }
        : { id: "apply", label: t("申请"), detail: t("写一个已批准的里程碑「提交申请」，按截止倒推准备；准备做完后问要不要代填"), recommended: !answerFields.length },
      { id: "plan", label: t("加入计划"), detail: t("只写截止与准备，不代填") },
      ...clashOptions(ctx, row, verdict, locale),
      { id: "less_kind", label: t("少来这类"), detail: t("这类机会隔久一点再看") },
      { id: "less", label: t("少来，说原因"), detail: t("按原因调整，周报里可撤销"), fields: [lessReasonField(t), { id: "note", label: t("一句话"), kind: "text", required: false }] },
      { id: "decline", label: t("不要"), detail: t("记成偏好，同类降权"), fields: [{ id: "note", label: t("原因"), kind: "text", required: false }] },
      { id: "later", label: t("以后再说"), detail: start ? t("最晚开始日前一周再问") : t("一周后再问") }
    ];
    return {
      id: `opp:${row.id}`, kind: "opportunity_offer", entityId: row.id, line: row.lineId,
      urgency: left !== undefined && left <= 2 ? "now" : left !== undefined && left <= 7 ? "soon" : "later",
      ...(deadline ? { dueDay: deadline } : {}), raisedAt: row.foundAt,
      fingerprint: `${row.updatedAt}|${row.verdict.state}|${verdict.state}|${verdict.state === "conflict" ? verdict.clashes.map((clash) => clash.blockId).join(",") : ""}`,
      important: Boolean(watch?.basis.milestoneIds.length),
      preview: { kind: "file", href: row.url, label: row.organizer || new URL(row.url).hostname },
      title: row.organizer ? t("{{title}}（{{organizer}}）", { title: row.title, organizer: short(row.organizer, 30) }) : row.title,
      why: parts.join(sep), options
    };
  });
  return [...offers, ...formProgressAsks(ctx, now), ...applicationResultAsks(ctx, now)];
}

/**
 * The offer card after 报名 (§17.9 gap A/B): the same opportunity, now saying how far the form filler got — 填写中 / 等本人 / 已提交 /
 * 已确认 — with a link to the run on 报名资料卡. Shown until the registration is confirmed, then one more day.
 */
export function formProgressAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const t = tFor(localeFor(ctx));
  const store = getStore();
  const runs = new Map<string, ReturnType<typeof readFormRuns>[number]>();
  for (const run of readFormRuns(store, ctx.workspaceId)) if (!runs.has(run.opportunityId)) runs.set(run.opportunityId, run);
  return store.listOpportunities(ctx.workspaceId).filter((row) => row.decision === "register").flatMap((row): Ask[] => {
    const run = runs.get(row.id);
    if (!run) return [];
    if (run.state === "confirmed" && now.getTime() - Date.parse(run.confirmation?.at ?? run.updatedAt) > CONFIRMED_SHOWN_MS) return [];
    const progress = t(FORM_PROGRESS[run.state]);
    const waiting = run.state === "waiting_person" || run.state === "ready_to_submit" || run.state === "stopped";
    return [{
      id: `oppform:${run.id}`, kind: "opportunity_offer", entityId: row.id, line: row.lineId, urgency: waiting ? "soon" : "later",
      raisedAt: run.queuedAt, fingerprint: `${run.id}|${run.state}|${run.updatedAt}`,
      title: t("报名「{{title}}」：{{progress}}", { title: short(row.title, 60), progress }),
      why: run.state === "confirmed" ? t("已收到确认：{{quote}}", { quote: short(run.confirmation?.quote ?? "", 120) })
        : waiting ? t("代填停在第 {{page}} 页，要本人看一下。", { page: run.pageNo }) : t("代填在第 {{page}} 页。", { page: run.pageNo }),
      options: [{ id: "open", label: t("看代填进度"), href: "/settings#apply" }]
    }];
  });
}

/**
 * After an application's deadline, what came of it (§17.4): 录取 / 没过 — the outcome that most moves the watch's yield. Asked for
 * applications the person sent or planned, until a result is recorded or four months pass.
 */
export function applicationResultAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const t = tFor(localeFor(ctx));
  const store = getStore();
  const today = planToday(ctx, now);
  return store.listOpportunities(ctx.workspaceId).filter((row) => row.kind === "application" && (row.decision === "apply" || row.decision === "plan")).flatMap((row): Ask[] => {
    const last = row.deadlines.map((item) => item.day).sort().at(-1);
    if (!last || last >= today || daysUntil(last, today) > 120) return [];
    const outcomes = outcomesOf(store, ctx.workspaceId, row.id);
    if (outcomes.has("accepted") || outcomes.has("rejected")) return [];
    return [{
      id: `oppresult:${row.id}`, kind: "opportunity_result", entityId: row.id, line: row.lineId, urgency: "later",
      raisedAt: `${last}T00:00:00.000Z`, fingerprint: `${row.id}|${last}`,
      title: t("「{{title}}」结果出来了吗？", { title: short(row.title, 60) }),
      why: t("截止 {{day}} 已过。结果会记到找到它的监视项上，下次更准。", { day: last }),
      options: [{ id: "accepted", label: t("通过了") }, { id: "rejected", label: t("没过"), detail: t("没过也说明这类找对了") }]
    }];
  });
}

export function answerApplicationResult(ctx: AccessContext, ask: Ask, optionId: string): { ok: true } | { ok: false; code: string } {
  if (optionId !== "accepted" && optionId !== "rejected") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  recordApplicationResult(getStore(), ctx.workspaceId, ctx.principalId, ask.entityId, optionId);
  return { ok: true };
}

/** A milestone 「提交 X 申请」 on the line, approved by the person's click (§9): deadline the opportunity's own, then the backplan. */
function writeApplicationMilestone(ctx: AccessContext, row: StoredOpportunity, today: string): { ok: true } | { ok: false; code: string } {
  const t = tFor(localeFor(ctx));
  const store = getStore();
  const deadline = nextDeadline(row, today);
  const watch = row.needId ? watchOf(store, ctx.workspaceId, row.needId) : undefined;
  // Rolling admission: the latest start plus about two weeks of preparation, marked as such.
  const due = deadline ?? addDays(today, Math.max(14, watch?.leadDays ?? 14));
  const title = row.kind === "event" ? t("报名 {{title}}", { title: short(row.title, 80) }) : t("提交 {{title}} 申请", { title: short(row.title, 80) });
  const saved = saveMilestoneEdit(ctx, { identityId: row.lineId, projectId: "", title, status: "approved", successCriteria: [{
    id: "submitted", statement: row.kind === "event" ? t("报名成功并收到确认") : t("提交成功并收到回执"), required: true, evidenceOf: "outcome",
    measure: { kind: "judgement", rubric: t("有提交确认页或确认邮件"), failsWhen: t("截止前没有提交") } }] });
  if (!saved.ok) return saved;
  store.saveMilestoneAnchor({ workspaceId: ctx.workspaceId, milestoneId: saved.id, stage: 1, deadline: due, baseline: "",
    target: deadline ? row.url : t("滚动录取，越早越好：{{url}}", { url: row.url }), stakeholders: row.organizer ? [row.organizer] : [],
    sourceFactIds: watch?.basis.factIds ?? [], dependsOn: [], updatedAt: new Date().toISOString() });
  saveGoalSettings(ctx, saved.id, { confirmedDeadline: due, sourceQuote: row.deadlines.find((item) => item.day === deadline)?.quote ?? "" });
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `opportunity.milestone:${row.id}`, type: "opportunity.milestone_written",
    entityId: row.id, payload: { milestoneId: saved.id, deadline: due, rolling: !deadline } });
  requestAutoBackplan(ctx);
  return { ok: true };
}

const isLessReason = (value: string | undefined): value is LessReason => (LESS_REASONS as readonly string[]).includes(value ?? "");

export async function answerOpportunityOffer(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>, now = new Date()): Promise<{ ok: true } | { ok: false; code: string }> {
  const store = getStore();
  const row = store.listOpportunities(ctx.workspaceId, { id: ask.entityId })[0];
  if (!row) return { ok: false, code: "OPPORTUNITY_NOT_FOUND" };
  const today = planToday(ctx, now);
  const t = tFor(localeFor(ctx));
  const at = now.toISOString();
  const record = (decision: string) => store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `opportunity.decided:${row.id}:${at}`,
    type: "opportunity.decided", entityId: row.id, payload: { decision, title: row.title, lineId: row.lineId } });
  const outcome = (value: OpportunityOutcome) => recordOpportunityOutcome(store, ctx.workspaceId, row.id, value, at);
  switch (optionId) {
    case "answer": {
      if (row.verdict.state !== "unknown") return { ok: false, code: "OPPORTUNITY_NOTHING_TO_ANSWER" };
      const terms = row.verdict.questions.map((question) => row.terms.find((term) => term.dim === question.dim && (term.dim !== "other" || question.question.includes(term.rule))) ?? row.terms.find((term) => term.dim === question.dim));
      for (const [index, term] of terms.entries()) {
        const value = values[`q${index}`] ?? "";
        const answer = term ? eligibilityAnswer(term, value) : undefined;
        if (!answer) return { ok: false, code: "OPPORTUNITY_ANSWER_UNREADABLE" };
        recordEligibilityAnswer(store, ctx.workspaceId, answer.slot, answer.value, row.id, now);
      }
      return { ok: true };
    }
    case "register": {
      if (!store.decideOpportunity(ctx.workspaceId, row.id, "register", at)) return { ok: false, code: "OPPORTUNITY_NOT_FOUND" };
      // The form-filling track's queue: one run for this opportunity's registration host, started by the worker's form pass.
      const { terms: _terms, verdict: _verdict, decision: _decision, decidedAt: _decidedAt, laterUntil: _laterUntil, confirmedBy: _confirmedBy, updatedAt: _updatedAt,
        feasibility: _feasibility, ...opportunity } = row;
      queueFormRun(store, ctx.workspaceId, { opportunity, choice: "register", at });
      outcome("planned");
      await holdEventTime(ctx, row, now);
      record("register");
      return { ok: true };
    }
    case "apply":
    case "plan": {
      const written = writeApplicationMilestone(ctx, row, today);
      if (!written.ok) return written;
      store.decideOpportunity(ctx.workspaceId, row.id, optionId, at);
      outcome("planned");
      await holdEventTime(ctx, row, now);
      record(optionId);
      return { ok: true };
    }
    case "less_kind":
    case "less": {
      const reason = optionId === "less" && isLessReason(values.reason) ? values.reason : undefined;
      const note = optionId === "less" ? values.note?.trim() ?? "" : "";
      if (optionId === "less" && !reason && !note) return { ok: false, code: "OPPORTUNITY_LESS_EMPTY" };
      const entry = lessOpportunity(store, ctx.workspaceId, ctx.principalId, { opportunityId: row.id, scope: reason ? "item" : "kind",
        ...(reason ? { reason } : {}), ...(note ? { note } : {}) }, now);
      if (!entry) return { ok: false, code: "OPPORTUNITY_NOT_FOUND" };
      store.decideOpportunity(ctx.workspaceId, row.id, "decline", at);
      return { ok: true };
    }
    case "decline": {
      store.decideOpportunity(ctx.workspaceId, row.id, "decline", at);
      store.addPreference({ workspaceId: ctx.workspaceId, source: "opportunity_declined", scope: row.lineId, weight: 0.5, refId: row.id,
        text: values.note?.trim() ? t("不要「{{title}}」（{{organizer}}）：{{note}}", { title: short(row.title, 60), organizer: row.organizer, note: values.note.trim() })
          : t("不要「{{title}}」（{{organizer}}）", { title: short(row.title, 60), organizer: row.organizer }) });
      outcome("declined");
      record("decline");
      return { ok: true };
    }
    case "later": {
      const watch = row.needId ? watchOf(store, ctx.workspaceId, row.needId) : undefined;
      const start = prepStartFor(nextDeadline(row, today), watch?.leadDays ?? 0);
      const weekBefore = start ? addDays(start, -7) : undefined;
      const until = weekBefore && weekBefore > today ? weekBefore : addDays(today, 7);
      store.decideOpportunity(ctx.workspaceId, row.id, "later", at, until);
      outcome("later");
      record("later");
      return { ok: true };
    }
    case "adjust": case "adjust_move": case "adjust_skip": case "adjust_self": case "adjust_note":
      return answerClash(ctx, row, judgeOpportunity(ctx, row, now, localeFor(ctx)), optionId, values, now);
    default: return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  }
}

const DRAFTS_MAX = 6;
const DRAFT_CHARS = 8_000;
type ApplyReady = { row: StoredOpportunity; milestoneId: string; deadline?: string | undefined; prepared: string[]; drafts: Record<string, { text: string; version: string }> };

/**
 * Applications whose preparation is done (§9 「材料齐了，⑥ 才开始」): the opportunity the person chose to apply for, its milestone's work
 * all accepted but a submission step (the person's, `stepLeavesMachine`), no form run yet, its deadline not passed, not handed in by the
 * person themselves. Filling then starts only on the person's press: no tracker or agent studied starts filling an application when
 * materials are ready, and a tailored résumé or essay going out unseen is what Simplify's own help warns against.
 */
function applicationsReady(ctx: AccessContext, today: string): ApplyReady[] {
  const store = getStore();
  const runs = new Set(readFormRuns(store, ctx.workspaceId).map((run) => run.opportunityId));
  const orders = store.listWorkOrders(ctx.workspaceId);
  const claims = store.listEvidenceClaims(ctx.workspaceId);
  return store.listOpportunities(ctx.workspaceId).flatMap((row): ApplyReady[] => {
    if (row.decision !== "apply" || row.confirmedBy || runs.has(row.id)) return [];
    if (row.deadlines.length && !nextDeadline(row, today)) return [];
    if (store.listEvents(ctx.workspaceId, { type: "opportunity.apply_self", entityId: row.id }).length) return [];
    const written = store.listEvents(ctx.workspaceId, { type: "opportunity.milestone_written", entityId: row.id })[0];
    const milestoneId = (written?.payload as { milestoneId?: string } | undefined)?.milestoneId;
    if (!milestoneId) return [];
    const work = orders.filter((order) => order.milestoneId === milestoneId && order.state !== "archived");
    const preparation = work.filter((order) => !stepLeavesMachine(taskTitleOf(order)));
    if (!preparation.length || preparation.some((order) => order.state !== "accepted")) return [];
    // Approved drafts for long answers: the accepted preparation's own text files (the person's or the assistant's), never anything else.
    const drafts: ApplyReady["drafts"] = {};
    for (const order of preparation) for (const claim of claims) {
      if (Object.keys(drafts).length >= DRAFTS_MAX) break;
      if (claim.workOrderId !== order.id || claim.reviewStatus !== "accepted" || claim.kind !== "file" || !claim.uri.startsWith("file://") || !/\.(txt|md|markdown)$/i.test(claim.uri)) continue;
      try {
        const text = readFileSync(fileURLToPath(claim.uri), "utf8").trim().slice(0, DRAFT_CHARS);
        if (text) drafts[`d${Object.keys(drafts).length + 1}`] = { text, version: `${path.basename(fileURLToPath(claim.uri))} · ${taskTitleOf(order).slice(0, 40)}` };
      } catch { /* a file removed from disk is no draft */ }
    }
    return [{ row, milestoneId, deadline: nextDeadline(row, today), prepared: preparation.map((order) => taskTitleOf(order)), drafts }];
  });
}

export function opportunityApplyReadyAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const sep = locale === "en" ? " " : "";
  const today = planToday(ctx, now);
  return applicationsReady(ctx, today).map(({ row, deadline, prepared, drafts }): Ask => {
    const left = deadline ? daysUntil(today, deadline) : undefined;
    const count = Object.keys(drafts).length;
    return {
      id: `oppready:${row.id}`, kind: "opportunity_apply_ready", entityId: row.id, line: row.lineId, important: true,
      urgency: left !== undefined && left <= 2 ? "now" : left !== undefined && left <= 7 ? "soon" : "later",
      ...(deadline ? { dueDay: deadline } : {}), raisedAt: row.decidedAt ?? row.updatedAt, fingerprint: `${prepared.length}|${count}`,
      preview: { kind: "file", href: row.url, label: row.organizer || new URL(row.url).hostname },
      title: t("「{{title}}」的申请准备做完了，要代填吗？", { title: short(row.title, 60) }),
      why: [t("已完成：{{items}}。", { items: prepared.slice(0, 4).join(locale === "en" ? ", " : "、") }),
        deadline ? t("截止 {{day}}。", { day: deadline }) : t("滚动录取，越早越好。"),
        count ? t("{{count}} 份文稿会作为长回答的草稿交给代填。", { count }) : t("没有可用的文稿，长回答处会停下由本人填写。")].join(sep),
      options: [
        { id: "fill", label: t("代填申请"), recommended: true, detail: t("打开报名网站的窗口填好，停在提交前，由本人核对后提交") },
        { id: "self", label: t("我自己去交"), detail: t("不代填，这条不再问") }
      ]
    };
  });
}

export function answerOpportunityApplyReady(ctx: AccessContext, ask: Ask, optionId: string, now = new Date()): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const ready = applicationsReady(ctx, planToday(ctx, now)).find((item) => item.row.id === ask.entityId);
  if (!ready) return { ok: false, code: "OPPORTUNITY_NOT_READY" };
  if (optionId === "self") {
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `opportunity.apply_self:${ready.row.id}`, type: "opportunity.apply_self",
      entityId: ready.row.id, payload: { milestoneId: ready.milestoneId } });
    return { ok: true };
  }
  if (optionId !== "fill") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const { terms: _terms, verdict: _verdict, decision: _decision, decidedAt: _decidedAt, laterUntil: _laterUntil, confirmedBy: _confirmedBy, updatedAt: _updatedAt, ...opportunity } = ready.row;
  queueFormRun(store, ctx.workspaceId, { opportunity, choice: "apply", at: now.toISOString(), ...(Object.keys(ready.drafts).length ? { drafts: ready.drafts } : {}) });
  return { ok: true };
}

export type OpportunityWeek = { found: number; eligible: number; unknown: number; ineligible: number; registered: number; applied: number;
  /** Each registration or application handed to the form filler that is still under way, or ended this week, with its state. */
  forms: Array<{ id: string; title: string; state: FormRunState; stoppedFor?: FormStop | undefined }>; ruledOut: Array<{ id: string; title: string; why: string }> };

/** The week's discovery for the weekly review (§8): found, signed up, applied, ruled out with the reasons, and where each form run stands. */
export function loadOpportunityWeek(ctx: AccessContext, now = new Date()): OpportunityWeek {
  const store = getStore();
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const rows = store.listOpportunities(ctx.workspaceId);
  const week = rows.filter((row) => row.foundAt >= since);
  const decidedThisWeek = rows.filter((row) => (row.decidedAt ?? "") >= since);
  const runs = new Map(readFormRuns(store, ctx.workspaceId).map((run) => [run.opportunityId, run]));
  return {
    found: week.length, eligible: week.filter((row) => row.verdict.state === "eligible").length, unknown: week.filter((row) => row.verdict.state === "unknown").length,
    ineligible: week.filter((row) => row.verdict.state === "ineligible").length,
    registered: decidedThisWeek.filter((row) => row.decision === "register").length, applied: decidedThisWeek.filter((row) => row.decision === "apply").length,
    forms: [...runs.values()].filter((run) => (run.state !== "confirmed" && run.state !== "stopped") || run.updatedAt >= since)
      .map((run) => ({ id: run.id, title: run.opportunity.title, state: run.state, ...(run.state === "waiting_person" ? { stoppedFor: run.stoppedFor } : {}) })),
    ruledOut: week.flatMap((row) => row.verdict.state === "ineligible"
      ? [{ id: row.id, title: row.title, why: row.verdict.failed.map((item) => `${item.rule}（${item.why}）`).join("；") }] : []) // i18n-ignore: the page's own words joined
  };
}

// ── Watches as the person sees and edits them (§17.9 UI) ────────────────────────────────────────────────────────────

export type WatchRow = { id: string; lineId: string; title: string; why: string; query: string; judge: string; where: string; origin: StoredWatch["origin"];
  explore: boolean; state: StoredWatch["state"]; everyDays: number; runs: number; surfaced: number; yield: number; cost: number;
  lastRunAt?: string; lastYieldAt?: string; retiredBy?: "person" | "system" };

function watchRow(watch: StoredWatch, t: ReturnType<typeof tFor>): WatchRow {
  return { id: watch.id, lineId: watch.lineId, title: watch.title, why: watch.why, query: watch.query, judge: watch.judge, where: whereOf(watch, t), origin: watch.origin,
    explore: watch.explore, state: watch.state, everyDays: watch.everyDays, runs: watch.stats.runs, surfaced: watch.stats.surfaced,
    yield: Math.round(watchYield(watch.stats) * 100) / 100, cost: Math.round(watch.stats.cost),
    ...(watch.stats.lastRunAt ? { lastRunAt: watch.stats.lastRunAt } : {}), ...(watch.stats.lastYieldAt ? { lastYieldAt: watch.stats.lastYieldAt } : {}),
    ...(watch.retiredBy ? { retiredBy: watch.retiredBy } : {}) };
}

/** Each line's watches for its card (active, paused, proposed; retired ones are in settings). Empty outside the owner's workspace. */
export function loadLineWatches(ctx: AccessContext): Record<string, WatchRow[]> {
  if (!opportunityOwner(ctx)) return {};
  const t = tFor(localeFor(ctx));
  const out: Record<string, WatchRow[]> = {};
  for (const watch of readWatchList(getStore(), ctx.workspaceId)) {
    if (watch.state === "retired" || (watch.state === "proposed" && (watch.explore || watch.origin === "scout"))) continue;
    (out[watch.lineId] ??= []).push(watchRow(watch, t));
  }
  return out;
}

export type LessRow = { id: string; at: string; title: string; reason?: string; note?: string; changes: string[]; undone: boolean };
const lessRow = (entry: LessEntry, t: ReturnType<typeof tFor>): LessRow => ({ id: entry.id, at: entry.at, title: entry.title,
  ...(entry.reason ? { reason: t(LESS_REASON_LABEL[entry.reason]) } : {}), ...(entry.note ? { note: entry.note } : {}), changes: entry.changes, undone: Boolean(entry.undoneAt) });

export type OpportunitySettings = { watches: WatchRow[]; retired: WatchRow[]; weekCost: number; exploreShare: number; scout: { runs: number; cost: number; lastRunAt?: string };
  less: LessRow[]; badTimes: string[]; knownHosts: string[] };

/** Settings → 机会代理: every watch, this week's cost and exploration share, retired watches to restore, 少来 adjustments to undo. */
export function loadOpportunitySettings(ctx: AccessContext, now = new Date()): OpportunitySettings | undefined {
  if (!opportunityOwner(ctx)) return undefined;
  const store = getStore();
  const t = tFor(localeFor(ctx));
  const list = readWatchList(store, ctx.workspaceId);
  if (!list.length && !store.listOpportunities(ctx.workspaceId).length) return undefined;
  const week = exploreAccount(opportunityCosts(store, ctx.workspaceId, new Date(now.getTime() - 7 * DAY).toISOString()));
  const scout = readScoutStats(store.getSetting(ctx.workspaceId, SCOUT_STATS_SETTING));
  const tuning = readWatchTuning(store, ctx.workspaceId);
  return {
    watches: list.filter((watch) => watch.state !== "retired").map((watch) => watchRow(watch, t)),
    retired: list.filter((watch) => watch.state === "retired").map((watch) => watchRow(watch, t)),
    weekCost: Math.round(week.total), exploreShare: Math.round(week.share * 100) / 100,
    scout: { runs: scout.runs, cost: Math.round(scout.cost), ...(scout.lastRunAt ? { lastRunAt: scout.lastRunAt } : {}) },
    less: lessLog(store, ctx.workspaceId).slice(-30).reverse().map((entry) => lessRow(entry, t)),
    badTimes: tuning.badTimes.map((item) => `${t(WEEKDAY_LABEL[item.weekday] ?? "")}${t(DAY_PART_LABEL[item.part])}`),
    knownHosts: tuning.knownHosts
  };
}

export type OutOfView = { finds: Array<{ id: string; title: string; organizer: string; url: string; lineId: string; deadline?: string }>;
  watches: WatchRow[]; less: LessRow[] };

/**
 * The weekly review's 视野外 (§17.3): what the scout found that did not have to reach the inbox, the places it proposes to watch, and
 * this week's 少来 adjustments, each undoable. Empty outside the owner's workspace.
 */
export function loadOutOfView(ctx: AccessContext, now = new Date()): OutOfView {
  if (!opportunityOwner(ctx)) return { finds: [], watches: [], less: [] };
  const store = getStore();
  const t = tFor(localeFor(ctx));
  const today = planToday(ctx, now);
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  return {
    finds: surfacedOpportunities(store, ctx.workspaceId, today).filter((row) => isScoutFind(row) && !row.inbox).map((row) => {
      const deadline = nextDeadline(row, today);
      return { id: row.id, title: row.title, organizer: row.organizer, url: row.url, lineId: row.lineId, ...(deadline ? { deadline } : {}) };
    }),
    watches: readWatchList(store, ctx.workspaceId).filter((watch) => watch.state === "proposed" && (watch.explore || watch.origin === "scout")).map((watch) => watchRow(watch, t)),
    less: lessLog(store, ctx.workspaceId).filter((entry) => entry.at >= since).reverse().map((entry) => lessRow(entry, t))
  };
}

// ── What the routes do ──────────────────────────────────────────────────────────────────────────────────────────────

type Result = { ok: true } | { ok: false; code: string };
const NOT_OWNER: Result = { ok: false, code: "OPPORTUNITY_NOT_OWNER" };
const NOT_FOUND: Result = { ok: false, code: "OPPORTUNITY_WATCH_NOT_FOUND" };
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : undefined;

export function changeWatch(ctx: AccessContext, id: string, body: Record<string, unknown>, now = new Date()): Result {
  if (!opportunityOwner(ctx)) return NOT_OWNER;
  const store = getStore();
  const action = body.action;
  if (action === "decide") {
    const decision = body.decision === "active" ? "active" : body.decision === "retired" ? "retired" : undefined;
    if (!decision) return { ok: false, code: "OPPORTUNITY_WATCH_ACTION_UNKNOWN" };
    return decideWatch(store, ctx.workspaceId, ctx.principalId, id, decision, now, text(body.note, 200) ?? "") ? { ok: true } : NOT_FOUND;
  }
  if (action === "state") {
    const state = body.state === "active" || body.state === "paused" || body.state === "retired" ? body.state : undefined;
    if (!state) return { ok: false, code: "OPPORTUNITY_WATCH_ACTION_UNKNOWN" };
    return setWatchState(store, ctx.workspaceId, ctx.principalId, id, state, now) ? { ok: true } : NOT_FOUND;
  }
  if (action === "edit") {
    const edit: WatchEdit = {};
    const title = text(body.title, 120), query = text(body.query, 600), judge = text(body.judge, 600);
    if (title) edit.title = title;
    if (query) edit.query = query;
    if (judge !== undefined) edit.judge = judge;
    if (typeof body.everyDays === "number" && Number.isFinite(body.everyDays)) edit.everyDays = body.everyDays;
    if (!Object.keys(edit).length) return { ok: false, code: "OPPORTUNITY_WATCH_EDIT_EMPTY" };
    return editWatch(store, ctx.workspaceId, ctx.principalId, id, edit, now) ? { ok: true } : NOT_FOUND;
  }
  return { ok: false, code: "OPPORTUNITY_WATCH_ACTION_UNKNOWN" };
}

export function addWatch(ctx: AccessContext, body: Record<string, unknown>, now = new Date()): Result & { id?: string } {
  if (!opportunityOwner(ctx)) return NOT_OWNER;
  const lineId = text(body.lineId, 64), title = text(body.title, 120), query = text(body.query, 600);
  if (!lineId || !title || !query) return { ok: false, code: "OPPORTUNITY_WATCH_FIELDS_REQUIRED" };
  if (!identityLines(ctx).some((line) => line.id === lineId)) return { ok: false, code: "OPPORTUNITY_LINE_UNKNOWN" };
  const added = addPersonWatch(getStore(), ctx.workspaceId, ctx.principalId, { lineId, title, query,
    ...(typeof body.everyDays === "number" && Number.isFinite(body.everyDays) ? { everyDays: body.everyDays } : {}) }, now);
  return { ok: true, id: added.id };
}

export function undoLess(ctx: AccessContext, id: string, now = new Date()): Result {
  if (!opportunityOwner(ctx)) return NOT_OWNER;
  return undoLessEntry(getStore(), ctx.workspaceId, ctx.principalId, id, now) ? { ok: true } : { ok: false, code: "OPPORTUNITY_LESS_NOT_FOUND" };
}
