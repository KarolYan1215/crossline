import { getStore } from "../../lib/crossline";
import { loadWeeklyReview } from "../../lib/review";
import { SubpageShell } from "../subpage-shell";
import { RevokeAcceptance } from "./revoke-acceptance";
import { DecideRelations } from "./decide-relations";
import { RevokeInsight } from "./revoke-insight";
import { WeeklyInsightButton } from "./weekly-insight-button";
import { requireSessionContext } from "../../lib/access-guard";
import { TaskPreview, MilestonePreview } from "../task-preview";

export const dynamic = "force-dynamic";

const uncalibrated = [
  ["净节省时间", "需要真实执行区间与审批/纠错成本观测后才能计算。"],
  ["模型使用成本", "需要真实 Codex 调用的用量与费用记录后才能计算。"],
  ["越权次数", "需要真实外部动作与审批事件后才能统计。"]
] as const;

const criterionKind: Record<string, string> = {
  count: "计数", artifact: "产物", threshold: "阈值", judgement: "判断"
};
const metLabel: Record<string, string> = { met: "已达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };

export default async function ReviewPage() {
  const ctx = await requireSessionContext();
  const workOrders = getStore().listWorkOrders(ctx.workspaceId);
  const accepted = workOrders.filter((workOrder) => workOrder.state === "accepted").length;
  const review = loadWeeklyReview(ctx);

  return <SubpageShell eyebrow="证据驱动" title="周复盘" description="只显示数据库事实；尚无观测的指标一律标记为未标定，不给出编造数字。">
    <section className="review-block">
      <h2>本周自动验收</h2>
      <p className="review-note">
        里程碑绑定的条目由闸门自动验收，不再逐条人工确认。因此每一条都在这里逐项列出而不是折叠成一个数字 ——
        看不见的自动化等于没有审计。每条都可撤销，撤销后退回证据复核且不丢证据。
      </p>
      {review.autoAccepted.length === 0
        ? <p className="review-empty">本周没有自动验收记录。</p>
        : <ul className="review-list">{review.autoAccepted.map((item) => <li key={item.workOrderId}>
          <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.workOrderId)}`} aria-label={item.intent} />
          <TaskPreview ctx={ctx} workOrderId={item.workOrderId} />
          <b>{item.intent}</b>
          <small>里程碑 {item.milestoneId} · {item.acceptedAt.slice(0, 16).replace("T", " ")}</small>
          {item.questioned && <em className="review-flag">关系已被反证，需复核</em>}
          <RevokeAcceptance workOrderId={item.workOrderId} />
        </li>)}</ul>}
    </section>

    <section className="review-block">
      <h2>里程碑达成标准</h2>
      {review.milestoneProgress.map((milestone) => <article key={milestone.id} className="review-milestone">
        <a className="card-cover-link" href={`/milestones/${encodeURIComponent(milestone.id)}`} aria-label={milestone.title} />
        <MilestonePreview ctx={ctx} milestoneId={milestone.id} />
        <b>{milestone.title}</b>
        {milestone.criteria.length === 0
          ? <em className="review-flag">未声明达成标准 —— 闸门会拒绝它，直到你写下什么算达成。
              <a href={`/milestones?edit=${encodeURIComponent(milestone.id)}`}>立即补充 →</a>
            </em>
          : <ul>{milestone.criteria.map((criterion, index) =>
            <li key={index}>[{criterionKind[criterion.kind] ?? criterion.kind}] {criterion.statement}
              {criterion.met
                ? <small> · 闸门已判：{metLabel[criterion.met]}</small>
                : <small> · 闸门尚未判过</small>}
            </li>)}</ul>}
        {milestone.verifiability === "judgement_only"
          && <em className="review-flag">全部为判断型标准 —— 无法客观判负，值得额外复核。</em>}
      </article>)}
    </section>

    <section className="review-block">
      <h2>本周信息域扩展</h2>
      {review.findings.length === 0
        ? <p className="review-empty">本周没有扩展记录。夜间扩展只在配额刷新且你不在用电脑时运行。</p>
        : <ul className="review-list">{review.findings.map((finding) => <li key={finding.sourceUrl}>
          <b>{finding.summary}</b>
          <small>{finding.sourceTitle} · {finding.retrievedAt.slice(0, 10)} · 里程碑 {finding.milestoneId}</small>
          <small>失效条件：{finding.staleWhen}</small>
          <small>洞察状态：{finding.status === "approved" ? "已批准可用于反推" : finding.status === "candidate" ? "候选，尚不用于决策" : finding.status === "revoked" ? "已撤销" : "已拒绝"}</small>
          <a href={finding.sourceUrl} rel="noreferrer noopener" target="_blank">来源 ↗</a>
          {finding.status === "approved" && <RevokeInsight eventId={finding.eventId} />}
        </li>)}</ul>}
    </section>

    <section className="review-block">
      <h2>候选关系</h2>
      <p className="review-note">
        排序依据全部是可数事实：目标是否停滞、是否复用已有产物、有无反例、历史成本。没有综合评分。
      </p>
      <DecideRelations candidates={review.candidates.kept.map((candidate) => {
        const detail = review.candidates.detail[candidate.id];
        return {
          id: candidate.id,
          highlighted: review.candidates.highlighted.some((item) => item.id === candidate.id),
          fromTitle: detail?.fromTitle ?? candidate.id,
          toTitle: detail?.toTitle ?? candidate.targetMilestoneId,
          fromIdentityId: detail?.fromIdentityId ?? "",
          toIdentityId: detail?.toIdentityId ?? "",
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
      <h2>停转提示</h2>
      <p className="review-note">只是提示，不会自动运行、不会自动花配额。</p>
      <ul className="review-list">{review.stalled.map((item) => <li key={item.identityId}>
        <b>{item.identityId} 线已有 {item.daysSinceLastPass} 天没有里程碑通过</b>
      </li>)}</ul>
    </section>}

    <section className="review-block">
      <h2>本周洞察提案</h2>
      <p className="review-note">
        只读提案，不会自动改写任何设置；少于 3 次可比较的观测不会生成洞察。
      </p>
      <WeeklyInsightButton />
      {review.insightProposals.length === 0
        ? <p className="review-empty">还没有洞察记录，点击上面的按钮生成一次。</p>
        : <ul className="review-list">{review.insightProposals.map((item) => <li key={item.id}>
          <b>{item.claim}</b>
          <small>{item.period} · {item.observationCount} 次观测</small>
          <small>建议：{item.proposedOverlayPatch}</small>
        </li>)}</ul>}
    </section>

    <section className="review-block">
      <h2>需要你判断的问题</h2>
      {review.questions.length === 0
        ? <p className="review-empty">目前没有待回答的问题。周复盘 Skill 运行后，需要你判断的点会出现在这里。</p>
        : <ul className="review-list">{review.questions.map((item) => <li key={item.id}><b>{item.question}</b></li>)}</ul>}
    </section>

    <section className="status-grid">
      <article className="status-card"><h2>{accepted} / {workOrders.length}</h2><p>当前已验收作业。验收率只来自 SQLite 真实状态。</p></article>
      {uncalibrated.map(([name, reason]) => <article className="status-card" key={name}>
        <span className="status-badge">未标定 · 需要执行观测</span><h2>{name}</h2><p>{reason}</p>
      </article>)}
    </section>
  </SubpageShell>;
}
