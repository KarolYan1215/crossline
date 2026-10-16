import { effectiveSchedulePreferences, getStore, lastNight } from "../../lib/crossline";
import { localStamp } from "@crossline/core";
import { loadWeeklyReview } from "../../lib/review";
import { SubpageShell } from "../subpage-shell";
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
import { loadTaskDetailsBatch, loadMilestoneDetailsBatch } from "../../lib/task-detail";
import { linePacks } from "../../lib/lines";

import { loadDiligence } from "../../lib/diligence";
import type { DiligenceReport } from "../onboarding/onboarding-types";
import { DiligenceReview } from "./diligence-review";
import { tOf } from "../../lib/locale";

export const dynamic = "force-dynamic";


const criterionKind: Record<string, string> = {
  count: "计数", artifact: "产物", threshold: "阈值", judgement: "判断"
};
const metLabel: Record<string, string> = { met: "已达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };

export default async function ReviewPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  const workOrders = getStore().listWorkOrders(ctx.workspaceId);
  const accepted = workOrders.filter((workOrder) => workOrder.state === "accepted").length;
  const review = loadWeeklyReview(ctx);
  const taskDetails = loadTaskDetailsBatch(ctx, review.autoAccepted.map((item) => item.workOrderId));
  const milestoneDetails = loadMilestoneDetailsBatch(ctx, review.milestoneProgress.map((item) => item.id));
  const insightKeys = new Map(permissionCandidates(ctx).filter((item) => item.kind === "insight" && item.eligible).map((item) => [item.id, item.key]));
  const night = lastNight(ctx.workspaceId, new Date());
  const lineLabel = new Map(linePacks(ctx, { includeArchived: true }).map((pack) => [pack.id, pack.label]));
  const diligence: DiligenceReport[] = loadDiligence(ctx);
  const identities = linePacks(ctx).filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label }));
  const t = tOf(ctx);

  return <SubpageShell active={"主线"} eyebrow={t("证据驱动")} title={t("周复盘")} description={t("本周的验收、里程碑进展与待定的跨主线关系；没有记录的指标标为「未标定」。")}>
    <section className="review-block">
      <h2>{t("本周自动验收")}</h2>
      <p className="review-note">
        {t("关联里程碑的任务由系统按证据自动验收，每一条都列在这里。任一条都可撤销：撤销后回到证据复核，已交的证据保留。")}
      </p>
      {review.autoAccepted.length === 0
        ? <p className="review-empty">{t("本周没有自动验收记录。")}</p>
        : <div className="review-cards">{review.autoAccepted.map((item) => {
          const detail = taskDetails.get(item.workOrderId);
          return <div key={item.workOrderId} className="review-card">
            {detail ? <TaskCard detail={detail} /> : <b>{item.intent}</b>}
            <p className="review-card-meta"><small>{t("自动验收 · {{at}}", { at: localStamp(item.acceptedAt, effectiveSchedulePreferences(ctx).preferences.timeZone) })}</small>
              {item.questioned && <Tag tone="warn">{t("关系已被反证，需复核")}</Tag>}
              <RevokeAcceptance workOrderId={item.workOrderId} /></p>
          </div>;
        })}</div>}
    </section>

    {diligence.length > 0 && <section className="review-block">
      <h2>{t("本周调研结论")}</h2>
      <p className="review-note">{t("网上调研得出的提议在这里一周批一次；采纳后只作为里程碑设计的参考，不会直接变成任务。")}</p>
      <DiligenceReview reports={diligence} identities={identities} />
    </section>}

    <section className="review-block">
      <h2>{t("里程碑达成标准")}</h2>
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
    </section>

    <section className="review-block">
      <h2>{t("本周信息域扩展")}</h2>
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

    <section className="review-block">
      <h2>{t("候选关系")}</h2>
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

    {review.stalled.length > 0 && <section className="review-block">
      <h2>{t("停转提示")}</h2>
      <p className="review-note">{t("只是提示，不会自动运行、不会自动花配额。")}</p>
      <ul className="review-list">{review.stalled.map((item) => <li key={item.identityId}>
        <b>{t("{{line}} 线已有 {{days}} 天没有里程碑通过", { line: item.identityId, days: item.daysSinceLastPass })}</b>
      </li>)}</ul>
    </section>}

    <section className="review-block">
      <h2>{t("本周洞察提案")}</h2>
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

    <section className="review-block">
      <h2>{t("待判断的问题")}</h2>
      {review.questions.length === 0
        ? <p className="review-empty">{t("暂无待判断的问题；周复盘运行后在此列出。")}</p>
        : <ul className="review-list">{review.questions.map((item) => <li key={item.id}><b>{item.question}</b></li>)}</ul>}
    </section>

    <p className="muted">{t("已验收作业 {{accepted}} / {{total}}（只来自账本里的真实状态）。", { accepted, total: workOrders.length })}</p>
  </SubpageShell>;
}
