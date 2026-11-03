import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eligibilityAnswer, nextDeadline, prepStartFor, stepLeavesMachine, taskTitleOf, type AccessContext, type Ask, type AskField, type AskOption, type FormRunState, type FormStop } from "@crossline/core";
import { decideNeed, queueFormRun, readFormRuns, recordEligibilityAnswer, scoutNeeds, type StoredOpportunity } from "@crossline/db";
import { getStore, planToday, saveGoalSettings, saveMilestoneEdit } from "./crossline";
import { requestAutoBackplan } from "./approvals";
import { localeFor } from "./locale";
import { tFor } from "./i18n";

/**
 * The web side of the opportunity agent's discovery (docs/opportunity-agent.md §5, §8): the cards for proposed needs (跟踪 / 不要) and
 * for each opportunity the person qualifies for or might (报名 / 申请 / 加入计划 / 不要 / 以后再说), and what each answer writes.
 * The rows exist only in the machine owner's workspace (the worker finds them only there), so no card appears anywhere else.
 */

const DAY = 86_400_000;
const daysUntil = (today: string, day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
const short = (text: string, length = 40) => text.length > length ? `${text.slice(0, length)}…` : text;

export function opportunityNeedAsks(ctx: AccessContext): Ask[] {
  const t = tFor(localeFor(ctx));
  const sep = localeFor(ctx) === "en" ? " " : "";
  return scoutNeeds(getStore(), ctx.workspaceId).filter((need) => need.state === "proposed").map((need): Ask => {
    const where = need.sources.map((source) => source.kind === "ats" ? `${source.provider}/${source.board}` : source.kind === "deadline_list" ? `${source.list}:${source.query}`
      : source.kind === "events" ? `${source.site}:${source.query}` : source.kind === "site_read" ? source.host : source.query).slice(0, 4).join(", ");
    return {
      id: `oppneed:${need.id}`, kind: "opportunity_need", entityId: need.id, line: need.lineId, urgency: "soon",
      raisedAt: need.derivedAt ?? new Date(0).toISOString(), fingerprint: `${need.title}|${need.sources.length}|${need.window?.opens ?? ""}`,
      important: need.milestoneIds.length > 0,
      title: t("要不要跟踪「{{title}}」？", { title: need.title }),
      why: need.why + sep + (need.window?.basis ? t("往年：{{basis}}。", { basis: need.window.basis.replace(/[。.\s]+$/u, "") }) + sep : "")
        + t("会看：{{where}}。跟踪后每天看一次，找到符合资格的会出现在早报和这里。", { where }),
      options: [
        { id: "track", label: t("跟踪"), recommended: true, detail: need.kind === "cycle" && need.window?.opens ? t("写一条「预计 {{month}} 开放」的等待项", { month: need.window.opens }) : t("每天看一次来源") },
        { id: "decline", label: t("不要"), detail: t("记成偏好，不再推同类"), fields: [{ id: "note", label: t("原因（可选）"), kind: "text", required: false }] }
      ]
    };
  });
}

export function answerOpportunityNeed(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>): { ok: true } | { ok: false; code: string } {
  if (optionId !== "track" && optionId !== "decline") return { ok: false, code: "ASK_OPTION_UNKNOWN" };
  const decided = decideNeed(getStore(), ctx.workspaceId, ctx.principalId, ask.entityId, optionId === "track" ? "tracking" : "declined", new Date(), values.note ?? "");
  return decided ? { ok: true } : { ok: false, code: "OPPORTUNITY_NEED_NOT_FOUND" };
}

/** Undecided, not ruled out, not past its deadline, and not put off to a later day. */
export function openOpportunities(ctx: AccessContext, today: string): StoredOpportunity[] {
  return getStore().listOpportunities(ctx.workspaceId).filter((row) => row.verdict.state !== "ineligible"
    && (!row.decision || (row.decision === "later" && (row.laterUntil ?? "") <= today))
    && (!row.deadlines.length || Boolean(nextDeadline(row, today))));
}

export function opportunityOfferAsks(ctx: AccessContext, now = new Date()): Ask[] {
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const sep = locale === "en" ? " " : "";
  const today = planToday(ctx, now);
  const needs = new Map(scoutNeeds(getStore(), ctx.workspaceId).map((need) => [need.id, need]));
  return openOpportunities(ctx, today).map((row): Ask => {
    const deadline = nextDeadline(row, today);
    const need = row.needId ? needs.get(row.needId) : undefined;
    const left = deadline ? daysUntil(today, deadline) : undefined;
    const start = prepStartFor(deadline, need?.leadDays ?? 0);
    const quote = row.deadlines.find((item) => item.day === deadline)?.quote;
    const facts = row.verdict.state === "eligible" && row.terms.length ? t("资格：按记录全部符合。") : "";
    const questions = row.verdict.state === "unknown" ? row.verdict.questions : [];
    const parts = [
      need ? t("对应需求「{{title}}」。", { title: need.title }) : "",
      deadline ? t("截止 {{day}}（原文：{{quote}}）。", { day: deadline, quote: short(quote ?? "", 80) }) : t("页面没写截止。"),
      start && start > today ? t("最晚 {{day}} 开始准备。", { day: start }) : "",
      row.cost ? t("费用：{{amount}} {{currency}}。", { amount: row.cost.amount, currency: row.cost.currency }) : "",
      row.location ? t("地点：{{place}}。", { place: row.location }) : "",
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
      { id: "decline", label: t("不要"), detail: t("记成偏好，同类降权"), fields: [{ id: "note", label: t("原因（可选）"), kind: "text", required: false }] },
      { id: "later", label: t("以后再说"), detail: start ? t("最晚开始日前一周再问") : t("一周后再问") }
    ];
    return {
      id: `opp:${row.id}`, kind: "opportunity_offer", entityId: row.id, line: row.lineId,
      urgency: left !== undefined && left <= 2 ? "now" : left !== undefined && left <= 7 ? "soon" : "later",
      ...(deadline ? { dueDay: deadline } : {}), raisedAt: row.foundAt, fingerprint: `${row.updatedAt}|${row.verdict.state}`,
      important: Boolean(need?.milestoneIds.length),
      preview: { kind: "file", href: row.url, label: row.organizer || new URL(row.url).hostname },
      title: row.organizer ? t("{{title}}（{{organizer}}）", { title: row.title, organizer: short(row.organizer, 30) }) : row.title,
      why: parts.join(sep), options
    };
  });
}

/** A milestone 「提交 X 申请」 on the line, approved by the person's click (§9): deadline the opportunity's own, then the backplan. */
function writeApplicationMilestone(ctx: AccessContext, row: StoredOpportunity, today: string): { ok: true } | { ok: false; code: string } {
  const t = tFor(localeFor(ctx));
  const store = getStore();
  const deadline = nextDeadline(row, today);
  const need = row.needId ? scoutNeeds(store, ctx.workspaceId).find((item) => item.id === row.needId) : undefined;
  // Rolling admission: the latest start plus about two weeks of preparation, marked as such.
  const due = deadline ?? new Date(Date.parse(`${today}T00:00:00Z`) + Math.max(14, need?.leadDays ?? 14) * DAY).toISOString().slice(0, 10);
  const title = row.kind === "event" ? t("报名 {{title}}", { title: short(row.title, 80) }) : t("提交 {{title}} 申请", { title: short(row.title, 80) });
  const saved = saveMilestoneEdit(ctx, { identityId: row.lineId, projectId: "", title, status: "approved", successCriteria: [{
    id: "submitted", statement: row.kind === "event" ? t("报名成功并收到确认") : t("提交成功并收到回执"), required: true, evidenceOf: "outcome",
    measure: { kind: "judgement", rubric: t("有提交确认页或确认邮件"), failsWhen: t("截止前没有提交") } }] });
  if (!saved.ok) return saved;
  store.saveMilestoneAnchor({ workspaceId: ctx.workspaceId, milestoneId: saved.id, stage: 1, deadline: due, baseline: "",
    target: deadline ? row.url : t("滚动录取，越早越好：{{url}}", { url: row.url }), stakeholders: row.organizer ? [row.organizer] : [],
    sourceFactIds: need?.factIds ?? [], dependsOn: [], updatedAt: new Date().toISOString() });
  saveGoalSettings(ctx, saved.id, { confirmedDeadline: due, sourceQuote: row.deadlines.find((item) => item.day === deadline)?.quote ?? "" });
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `opportunity.milestone:${row.id}`, type: "opportunity.milestone_written",
    entityId: row.id, payload: { milestoneId: saved.id, deadline: due, rolling: !deadline } });
  requestAutoBackplan(ctx);
  return { ok: true };
}

export function answerOpportunityOffer(ctx: AccessContext, ask: Ask, optionId: string, values: Record<string, string>, now = new Date()): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const row = store.listOpportunities(ctx.workspaceId, { id: ask.entityId })[0];
  if (!row) return { ok: false, code: "OPPORTUNITY_NOT_FOUND" };
  const today = planToday(ctx, now);
  const t = tFor(localeFor(ctx));
  const record = (decision: string) => store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `opportunity.decided:${row.id}:${now.toISOString()}`,
    type: "opportunity.decided", entityId: row.id, payload: { decision, title: row.title, lineId: row.lineId } });
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
      if (!store.decideOpportunity(ctx.workspaceId, row.id, "register", now.toISOString())) return { ok: false, code: "OPPORTUNITY_NOT_FOUND" };
      // The form-filling track's queue: one run for this opportunity's registration host, started by the worker's form pass.
      const { terms: _terms, verdict: _verdict, decision: _decision, decidedAt: _decidedAt, laterUntil: _laterUntil, confirmedBy: _confirmedBy, updatedAt: _updatedAt, ...opportunity } = row;
      queueFormRun(store, ctx.workspaceId, { opportunity, choice: "register", at: now.toISOString() });
      record("register");
      return { ok: true };
    }
    case "apply":
    case "plan": {
      const written = writeApplicationMilestone(ctx, row, today);
      if (!written.ok) return written;
      store.decideOpportunity(ctx.workspaceId, row.id, optionId, now.toISOString());
      record(optionId);
      return { ok: true };
    }
    case "decline": {
      store.decideOpportunity(ctx.workspaceId, row.id, "decline", now.toISOString());
      store.addPreference({ workspaceId: ctx.workspaceId, source: "opportunity_declined", scope: row.lineId, weight: 0.5, refId: row.id,
        text: values.note?.trim() ? t("不要「{{title}}」（{{organizer}}）：{{note}}", { title: short(row.title, 60), organizer: row.organizer, note: values.note.trim() })
          : t("不要「{{title}}」（{{organizer}}）", { title: short(row.title, 60), organizer: row.organizer }) });
      record("decline");
      return { ok: true };
    }
    case "later": {
      const need = row.needId ? scoutNeeds(store, ctx.workspaceId).find((item) => item.id === row.needId) : undefined;
      const start = prepStartFor(nextDeadline(row, today), need?.leadDays ?? 0);
      const weekBefore = start ? new Date(Date.parse(`${start}T00:00:00Z`) - 7 * DAY).toISOString().slice(0, 10) : undefined;
      const until = weekBefore && weekBefore > today ? weekBefore : new Date(Date.parse(`${today}T00:00:00Z`) + 7 * DAY).toISOString().slice(0, 10);
      store.decideOpportunity(ctx.workspaceId, row.id, "later", now.toISOString(), until);
      record("later");
      return { ok: true };
    }
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
