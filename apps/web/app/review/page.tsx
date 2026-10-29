import { CheckCheck, Clock, GitPullRequestArrow, ShieldCheck } from "lucide-react";
import { effectiveSchedulePreferences, firstAcceptedAt, getStore, lastNight } from "../../lib/crossline";
import { localStamp } from "@crossline/core";
import { loadWeekInvestment, loadWeeklyReview } from "../../lib/review";
import { loadLedger } from "../../lib/ledger";
import { BarChart } from "../ui/charts";
import "../rituals.css";
import "./review.css";
import { AppShell } from "../app-shell";
import { Figure, RitualHead } from "../ritual-head";
import { RevokeAcceptance } from "./revoke-acceptance";
import { DecideRelations } from "./decide-relations";
import { InsightActions } from "./insight-actions";
import { permissionCandidates } from "../../lib/permission-mode";
import { WeeklyInsightButton } from "./weekly-insight-button";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { MilestonePreview } from "../task-preview";
import { TaskCard } from "../task/task-card";
import { Tag } from "../ui/tag";
import { ICON } from "../ui/icon-button";
import { cardView, loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../../lib/task-detail";
import { linePacks } from "../../lib/lines";

import { loadDiligence } from "../../lib/diligence";
import type { DiligenceReport } from "../onboarding/onboarding-types";
import { DiligenceReview } from "./diligence-review";
import { localeFor, tOf } from "../../lib/locale";
import { monthDay } from "../../lib/i18n";

export const dynamic = "force-dynamic";


const criterionKind: Record<string, string> = {
  count: "计数", artifact: "产物", threshold: "阈值", judgement: "判断"
};
const LOAD = { low: "低", medium: "中", high: "高" } as const;
const LOAD_RANK = { low: 0, medium: 1, high: 2 } as const;
const metLabel: Record<string, string> = { met: "已达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };

/**
 * The weekly review (2026-10-28 redesign; docs/plans/page-drafts-1028/scenarios.md). Scene: the weekend or Monday morning — what the past
 * week finished, where its time went, and which long-range judgements wait for the person; they leave having approved or set aside the
 * candidate relations, research conclusions and insight proposals, which are decided here and nowhere else (the 主线 drawer only shows a
 * relation and links here). Four figures, then 「要拍板的」, then 「回看」. This month's money is one line: the records' home is the
 * wealth line's card on 主线 (and 总账).
 */
export default async function ReviewPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const t = tOf(ctx);
  const locale = localeFor(ctx);
  const workOrders = getStore().listWorkOrders(ctx.workspaceId);
  const accepted = workOrders.filter((workOrder) => workOrder.state === "accepted").length;
  const review = loadWeeklyReview(ctx);
  // The same numbers as the monthly report and the ledger page (docs/mail-bookkeeping.md §5.3); only their summary is here.
  const money = loadLedger(ctx);
  const taskDetails = loadTaskDetailsBatch(ctx, review.autoAccepted.map((item) => item.workOrderId));
  const milestoneDetails = loadMilestoneDetailsBatch(ctx, review.milestoneProgress.map((item) => item.id));
  const insightKeys = new Map(permissionCandidates(ctx).filter((item) => item.kind === "insight" && item.eligible).map((item) => [item.id, item.key]));
  const night = lastNight(ctx.workspaceId, new Date(), locale);
  const packs = linePacks(ctx, { includeArchived: true });
  const lineLabel = new Map(packs.map((pack) => [pack.id, pack.label]));
  const wealthLine = linePacks(ctx).find((pack) => pack.domain === "wealth");
  const diligence: DiligenceReport[] = loadDiligence(ctx);
  const identities = linePacks(ctx).filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label }));
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;

  const week = loadWeekInvestment(ctx);
  const hoursOf = (minutes: number) => Math.round(minutes / 6) / 10;
  const weekMax = Math.max(...week.lines.flatMap((line) => [hoursOf(line.planned), hoursOf(line.actual)]), 1);
  const since = Date.now() - 7 * 86_400_000;
  const finished = [...firstAcceptedAt(ctx.workspaceId).values()].filter((iso) => Date.parse(iso) >= since).length;
  const timedHours = hoursOf(week.lines.reduce((sum, line) => sum + line.actual, 0));
  const pendingProposals = diligence.reduce((sum, report) => sum + report.proposals.filter((proposal) => proposal.status === "pending").length, 0);
  const candidateFindings = review.findings.filter((finding) => finding.status === "candidate").length;
  const toDecide = review.candidates.kept.length + pendingProposals + candidateFindings;
  const range = t("{{start}}–{{end}}", { start: monthDay(locale, week.start), end: monthDay(locale, week.end) });

  return <AppShell active={"周复盘"} className="subpage rd-page"><div className="rd-inner">
    <RitualHead title={t("周复盘")} sub={t("{{range}} · 回看上周做成了什么、时间投到了哪，再拍板长期判断；没有记录的指标标为「未标定」。", { range })} />

    <ul className="rd-kpis" aria-label={t("这一周的数")}>
      <li className="rd-card"><span className="rd-label"><CheckCheck {...ICON} />{t("完成的任务")}</span><Figure value={finished} unit={t("件")} /></li>
      <li className="rd-card"><span className="rd-label"><Clock {...ICON} />{t("计时")}</span><Figure value={week.hasData ? timedHours : "—"} {...(week.hasData ? { unit: "h" } : {})} /></li>
      <li className="rd-card"><span className="rd-label"><ShieldCheck {...ICON} />{t("自动验收")}</span><Figure value={review.autoAccepted.length} unit={t("件")} /></li>
      <li className="rd-card"><a className="rv-kpi-link" href="#decide"><span className="rd-label"><GitPullRequestArrow {...ICON} />{t("待拍板")}</span>
        <Figure value={toDecide} unit={t("项")} {...(toDecide ? { tone: "alarm" as const } : {})} /></a></li>
    </ul>

    <h2 className="rv-part" id="decide">{t("要拍板的")}</h2>
    <div className="review-grid">
    <section className="rd-card review-block review-wide" aria-labelledby="rv-relations">
      <header className="rd-card-head"><h2 id="rv-relations">{t("候选关系")}</h2><small>{t("{{count}} 条待定", { count: review.candidates.kept.length })}</small></header>
      <p className="review-note">
        {t("排序依据全部是可数事实：目标是否停滞、是否复用已有产物、有无反例、历史成本。没有综合评分。")}
      </p>
      <DecideRelations candidates={review.candidates.kept.map((candidate) => {
        const detail = review.candidates.detail[candidate.id];
        return {
          id: candidate.id,
          highlighted: review.candidates.highlighted.some((item) => item.id === candidate.id),
          fromTitle: detail?.fromTitle ?? candidate.id,
          toTitle: detail?.toTitle ?? candidate.targetMilestoneId,
          fromIdentityId: lineLabel.get(detail?.fromIdentityId ?? "") ?? detail?.fromIdentityId ?? "",
          toIdentityId: lineLabel.get(detail?.toIdentityId ?? "") ?? detail?.toIdentityId ?? "",
          kind: detail?.kind ?? "",
          explanation: detail?.explanation ?? null,
          refutedWhen: detail?.refutedWhen ?? null,
          evidence: detail?.evidence ?? [],
          targetStalledDays: candidate.targetStalledDays,
          reusesExistingArtifact: candidate.reusesExistingArtifact,
          counterexampleCount: candidate.counterexampleCount,
          costMinutes: candidate.costMinutes
        };
      })} />
    </section>

    {diligence.length > 0 && <section className="rd-card review-block review-wide review-diligence" aria-labelledby="rv-diligence">
      <header className="rd-card-head"><h2 id="rv-diligence">{t("本周调研结论")}</h2><small>{t("{{count}} 条待定", { count: pendingProposals })}</small></header>
      <p className="review-note">{t("网上调研得出的提议在这里一周批一次；采纳「任务」类提议会收进待分析、变成任务；其余类型采纳后作为下次设计里程碑的参考。")}</p>
      <DiligenceReview reports={diligence} identities={identities} />
    </section>}

    <section className="rd-card review-block" aria-labelledby="rv-findings">
      <header className="rd-card-head"><h2 id="rv-findings">{t("本周信息域扩展")}</h2></header>
      {night.state !== "none" && <p className="review-note">{night.state === "ran" ? t("最近一次夜间扩展：{{count}} 条候选", { count: night.proposals }) : t("最近一次夜间扩展未运行：{{reason}}", { reason: t(night.reason) })}</p>}
      {review.findings.length === 0
        ? <p className="review-empty">{t("本周无扩展记录。夜间扩展仅在配额刷新且电脑空闲时运行。")}</p>
        : <ul className="review-list">{review.findings.map((finding) => <li key={finding.sourceUrl}>
          <b>{finding.summary}</b>
          <small>{t("{{source}} · {{day}} · 里程碑 {{milestone}}", { source: finding.sourceTitle, day: finding.retrievedAt.slice(0, 10), milestone: finding.milestoneId })}</small>
          <small>{t("失效条件：{{when}}", { when: finding.staleWhen })}</small>
          <small>{t("洞察状态：{{status}}", { status: finding.status === "approved" ? t("已批准可用于反推") : finding.status === "candidate" ? t("候选，尚不用于决策") : finding.status === "revoked" ? t("已撤销") : t("已拒绝") })}</small>
          <a href={finding.sourceUrl} rel="noreferrer noopener" target="_blank">{t("来源 ↗")}</a>
          <InsightActions eventId={finding.eventId} status={finding.status} candidateKey={insightKeys.get(finding.eventId)} />
        </li>)}</ul>}
    </section>

    <section className="rd-card review-block" aria-labelledby="rv-insights">
      <header className="rd-card-head"><h2 id="rv-insights">{t("本周洞察提案")}</h2></header>
      <p className="review-note">
        {t("只读提案，不会自动改写任何设置；少于 3 次可比较的观测不会生成洞察。")}
      </p>
      <WeeklyInsightButton />
      {review.insightProposals.length === 0
        ? <p className="review-empty">{t("还没有洞察记录，点击上面的按钮生成一次。")}</p>
        : <ul className="review-list">{review.insightProposals.map((item) => <li key={item.id}>
          <b>{item.claim}</b>
          <small>{t("{{period}} · {{count}} 次观测", { period: item.period, count: item.observationCount })}</small>
          <small>{t("建议：{{patch}}", { patch: item.proposedOverlayPatch })}</small>
        </li>)}</ul>}
    </section>
    </div>

    <h2 className="rv-part">{t("回看")}</h2>
    {/* Sections fill the width: the wide ones run across it, the rest pair up in two columns on a large screen (2026-10-21). */}
    <div className="review-grid">
    {week.hasData && <section className="rd-card review-block review-wide" aria-labelledby="rv-week">
      <header className="rd-card-head"><h2 id="rv-week">{t("本周各线投入")}</h2>
        <small>{t("{{start}}–{{end}}，单位小时。计划按日程记下的 {{count}} 天累计，实际为计时。", { start: week.start.slice(5).replace("-", "/"), end: week.end.slice(5).replace("-", "/"), count: week.recordedDays })}</small></header>
      <div className="review-week">
        <div><h3 className="review-week-head">{t("计划")}</h3>
          <BarChart label={t("本周各线计划小时")} unit=" h" max={weekMax} data={week.lines.map((line) => ({ label: line.label, line: line.line, value: hoursOf(line.planned),
            title: t("{{line}} · 计划 {{hours}} 小时", { line: line.label, hours: hoursOf(line.planned) }) }))} /></div>
        <div><h3 className="review-week-head">{t("实际计时")}</h3>
          <BarChart label={t("本周各线实际计时小时")} unit=" h" max={weekMax} data={week.lines.map((line) => ({ label: line.label, line: line.line, value: hoursOf(line.actual),
            title: t("{{line}} · 实际计时 {{hours}} 小时", { line: line.label, hours: hoursOf(line.actual) }) }))} /></div>
      </div>
    </section>}

    <section className="rd-card review-block review-wide" aria-labelledby="rv-auto">
      <header className="rd-card-head"><h2 id="rv-auto">{t("本周自动验收")}</h2></header>
      <p className="review-note">
        {t("关联里程碑的任务由系统按证据自动验收，每一条都列在这里。任一条都可撤销：撤销后回到证据复核，已交的证据保留。")}
      </p>
      {review.autoAccepted.length === 0
        ? <p className="review-empty">{t("本周没有自动验收记录。")}</p>
        : <div className="review-cards">{review.autoAccepted.map((item) => {
          const detail = taskDetails.get(item.workOrderId);
          return <div key={item.workOrderId} className="review-card">
            {detail ? <TaskCard detail={cardView(detail)} /> : <b>{item.intent}</b>}
            <p className="review-card-meta"><small>{t("自动验收 · {{at}}", { at: localStamp(item.acceptedAt, zone) })}</small>
              {item.questioned && <Tag tone="warn">{t("关系已被反证，需复核")}</Tag>}
              <RevokeAcceptance workOrderId={item.workOrderId} /></p>
          </div>;
        })}</div>}
    </section>

    {review.taskLoad.length > 0 && <section className="rd-card review-block" aria-labelledby="rv-load">
      <header className="rd-card-head"><h2 id="rv-load">{t("本周做完后的累不累")}</h2></header>
      <p className="review-note">{t("做完任务时本人选的「这件事累不累」，与排程时按任务估计的精力需求并列；只在这里列出，不改排程。")}</p>
      <ul className="review-list">{review.taskLoad.map((item) => <li key={item.workOrderId}>
        <b><a href={`/workbench/${encodeURIComponent(item.workOrderId)}`}>{item.title}</a></b>
        <small>{lineLabel.get(item.identityId) ?? item.identityId} · {t("本人说：{{load}}", { load: t(LOAD[item.actual]) })}{item.expected ? ` · ${t("原估精力需求：{{load}}", { load: t(LOAD[item.expected]) })}` : ""}</small>
        {item.expected && item.expected !== item.actual && <Tag tone={LOAD_RANK[item.actual] > LOAD_RANK[item.expected] ? "warn" : "neutral"}>
          {LOAD_RANK[item.actual] > LOAD_RANK[item.expected] ? t("比预想累") : t("比预想轻松")}</Tag>}
      </li>)}</ul>
    </section>}

    {money.hasRecords && <section className="rd-card review-block rv-money" aria-label={t("本月花钱")}>
      <p>{t("本月花钱：{{month}} 已花 {{spent}} {{currency}}，收入 {{income}}", { month: money.month, spent: money.summary.spent, currency: money.summary.currency, income: money.summary.income })}
        {money.summary.savingsRate !== null ? t("，储蓄率 {{rate}}%", { rate: Math.round(money.summary.savingsRate) }) : ""}{t("。")}</p>
      <p className="review-note">{t("明细和趋势在主线页的线卡上。")} <a href={wealthLine ? `/milestones?line=${encodeURIComponent(wealthLine.id)}` : "/milestones"}>{t("看线卡")}</a>
        {" · "}<a href="/ledger">{t("看总账")}</a></p>
    </section>}

    <section className="rd-card review-block review-wide" aria-labelledby="rv-criteria">
      <header className="rd-card-head"><h2 id="rv-criteria">{t("里程碑达成标准")}</h2></header>
      <div className="review-milestones">
      {review.milestoneProgress.map((milestone) => <article key={milestone.id} className="review-milestone">
        <a className="card-cover-link" href={`/milestones/${encodeURIComponent(milestone.id)}`} aria-label={milestone.title} />
        <MilestonePreview detail={milestoneDetails.get(milestone.id)} />
        <b>{milestone.title}</b>
        {milestone.criteria.length === 0
          ? <em className="review-flag">{t("未声明达成标准：关联任务仍按各自证据验收，但里程碑进度无法记录。")}
              <a href={`/milestones?open=${encodeURIComponent(milestone.id)}`}>{t("立即补充 →")}</a>
            </em>
          : <ul>{milestone.criteria.map((criterion, index) =>
            <li key={index}>[{criterionKind[criterion.kind] ? t(criterionKind[criterion.kind]!, { context: "criterion" }) : criterion.kind}] {criterion.statement}
              {criterion.met
                ? <small>{t(" · 闸门已判：{{verdict}}", { verdict: metLabel[criterion.met] ? t(metLabel[criterion.met]!) : criterion.met })}</small>
                : <small>{t(" · 闸门尚未判过")}</small>}
            </li>)}</ul>}
        {milestone.verifiability === "judgement_only"
          && <em className="review-flag">{t("全部为判断型标准 —— 无法客观判负，值得额外复核。")}</em>}
      </article>)}
      </div>
    </section>

    {review.stalled.length > 0 && <section className="rd-card review-block" aria-labelledby="rv-stalled">
      <header className="rd-card-head"><h2 id="rv-stalled">{t("停转提示")}</h2></header>
      <p className="review-note">{t("只是提示，不会自动运行、不会自动花配额。")}</p>
      <ul className="review-list">{review.stalled.map((item) => <li key={item.identityId}>
        <b>{t("{{line}} 线已有 {{days}} 天没有里程碑通过", { line: item.identityId, days: item.daysSinceLastPass })}</b>
      </li>)}</ul>
    </section>}

    <section className="rd-card review-block" aria-labelledby="rv-questions">
      <header className="rd-card-head"><h2 id="rv-questions">{t("待判断的问题")}</h2></header>
      {review.questions.length === 0
        ? <p className="review-empty">{t("暂无待判断的问题；周复盘运行后在此列出。")}</p>
        : <ul className="review-list">{review.questions.map((item) => <li key={item.id}><b>{item.question}</b></li>)}</ul>}
    </section>
    </div>

    <p className="muted rv-foot">{t("已验收作业 {{accepted}} / {{total}}（只来自账本里的真实状态）。", { accepted, total: workOrders.length })}</p>
  </div></AppShell>;
}
