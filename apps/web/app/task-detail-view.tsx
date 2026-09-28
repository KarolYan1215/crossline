import type { TaskDetail, MilestoneDetail } from "../lib/task-detail";
import { ExecutionActions } from "./workbench/execution-actions";

const stateLabel: Record<string, string> = {
  captured: "已收集", analyzing: "分析中", awaiting_plan_approval: "等待计划批准",
  approved: "已批准", preparing: "材料准备中", ready_for_human: "可开始",
  active: "执行中", evidence_review: "证据审查中", accepted: "已验收", blocked: "已阻塞", archived: "已归档"
};
const riskLabel: Record<string, string> = { routine: "常规", milestone: "里程碑", high_risk: "高风险" };
const confidenceLabel: Record<string, string> = { low: "低置信", medium: "中置信", high: "高置信" };
const metLabel: Record<string, string> = { met: "达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };
const gateVerdictLabel: Record<string, string> = { pass: "通过", insufficient: "证据不足", refuted: "被证据否定" };
const contractKindLabel: Record<string, string> = { file: "文件", link: "链接", record: "记录", telemetry: "遥测" };
const milestoneStatusLabel: Record<string, string> = { draft: "草稿", approved: "已批准", archived: "已归档" };
const criterionKindLabel: Record<string, string> = { count: "计数", artifact: "产出物", threshold: "阈值", judgement: "判断" };

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

/** A placeholder, not an empty section — the project-context pipeline (onboarding + per-capture
 * compaction) is a separately-planned phase; this keeps the layout stable for when it lands. */
function BackgroundPlaceholder() {
  return <p className="task-detail-background-empty">未设置背景资料 · 在 onboarding 对话中补充后会显示在这里</p>;
}

function FlywheelList({ items }: { items: TaskDetail["relatedFlywheel"] }) {
  if (!items.length) return null;
  return <div className="task-detail-flywheel">
    <h3>相关飞轮关系</h3>
    {items.map((item) => <p key={item.id}>
      <span>{item.kindLabel}</span> {item.fromTitle} → {item.toTitle}
      {item.pending ? " · 待周复盘确认" : ""}
      {item.explanation && <small> · {item.explanation}</small>}
    </p>)}
  </div>;
}

/** The shared display for one task — used verbatim by both the quick-preview drawer and the standalone
 * `/workbench/[id]` page (`task-detail-view` decides what's on screen; the two entry points only differ
 * in the chrome wrapped around it). No client hooks here on purpose, so a Server Component page can
 * render this directly, and a client Dialog can still receive it pre-rendered as `children`. */
export function TaskDetailView({ detail }: { detail: TaskDetail }) {
  return <div className="task-detail-view">
    <header className="task-detail-header">
      <span className="mono-label">{detail.identityLabel.toUpperCase()} · {detail.id.slice(-8)}</span>
      <b>{stateLabel[detail.state] ?? detail.state}</b>
    </header>
    <h2>{detail.intent}</h2>
    {detail.milestone && <p className="card-milestone">→ {detail.milestone.title}</p>}
    {detail.manualPromotion && <p role="status">人工创建 · 未经 AI 分析</p>}
    <dl className="task-detail-facts">
      <div><dt>估时</dt><dd>{detail.estimate.p25Minutes}–{detail.estimate.p85Minutes} 分钟 · {confidenceLabel[detail.estimate.confidence]}</dd></div>
      <div><dt>风险等级</dt><dd>{riskLabel[detail.riskTier]}</dd></div>
    </dl>

    {/* The same live start/pause/resume/complete controls Workbench's own card has — the detail page is
        where "下一行动" now actually sends you to act, not only to read. */}
    <ExecutionActions workOrderId={detail.id} intent={detail.intent} state={detail.state} paused={detail.paused}
      ownerId={detail.ownerId} workspaceId={detail.workspaceId} />

    <section className="task-detail-background">
      <h3>背景资料</h3>
      <BackgroundPlaceholder />
    </section>

    {detail.materialContract.length > 0 && <section>
      <h3>材料清单</h3>
      <ul className="task-detail-contract">{detail.materialContract.map((item, index) => <li key={index}>
        <span className="criterion-tag">{contractKindLabel[item.kind] ?? item.kind}</span>
        <span>{item.description}{item.required ? "" : "（可选）"}</span>
        <small>{item.why}</small>
      </li>)}</ul>
    </section>}

    {detail.evidenceContract.length > 0 && <section>
      <h3>验收证据要求</h3>
      <ul className="task-detail-contract">{detail.evidenceContract.map((item, index) => <li key={index}>
        <span className="criterion-tag">{contractKindLabel[item.kind] ?? item.kind}</span>
        <span>{item.description}{item.required ? "" : "（可选）"}</span>
        <small>{item.why}</small>
      </li>)}</ul>
    </section>}

    {detail.preparedMaterials.length > 0 && <section>
      <h3>已备材料 · 本地链接</h3>
      <ul className="task-detail-materials">{detail.preparedMaterials.map((item) => <li key={item.id}>
        <a href={`/api/work-orders/${encodeURIComponent(detail.id)}/materials?uri=${encodeURIComponent(item.uri)}`} target="_blank" rel="noreferrer">{item.fileName}</a>
      </li>)}</ul>
    </section>}

    {(detail.blocker || detail.materialBlocker) && <section>
      {detail.blocker && <p role="status">已退回 · {detail.blocker.reason}</p>}
      {detail.materialBlocker && <p role="status">材料准备已停下 · {detail.materialBlocker.message}</p>}
    </section>}

    {detail.gateReview && <details className="work-order-drawer" open>
      <summary>里程碑闸门判定 · {gateVerdictLabel[detail.gateReview.verdict] ?? detail.gateReview.verdict}</summary>
      {detail.gateReview.criteriaVerdict.map((item) => <p key={item.criterionId}>
        {metLabel[item.met] ?? item.met} · {item.observed}{item.shortfall ? ` · 还差：${item.shortfall}` : ""}
      </p>)}
      {detail.gateReview.gaps.map((gap) => <p key={gap.code}>缺口 {gap.code} · 需要：{gap.whatWouldSatisfyIt}</p>)}
    </details>}

    {detail.executions.length > 0 && <details className="work-order-drawer">
      <summary>执行记录</summary>
      {detail.executions.map((execution) => <p key={execution.id}>
        {!execution.durationObserved ? "时长未观测（一次性补记完成）"
          : execution.endedAt ? `实际执行 ${minutesBetween(execution.startedAt, execution.endedAt) - execution.pauseMinutes} 分钟 · 被中断 ${execution.pauseMinutes} 分钟`
          : `执行中 · 已记录中断 ${execution.pauseMinutes} 分钟`}
        {execution.interruptions.length ? ` · 中断原因：${execution.interruptions.map((item) => item.reason).join("、")}` : ""}
        {execution.outcome === "completed_without_evidence" ? " · 无证据声明" : ""}
      </p>)}
    </details>}

    {detail.discardReason && <p role="status">已丢弃 · 原因：{detail.discardReason}</p>}

    <FlywheelList items={detail.relatedFlywheel} />
  </div>;
}

/** The shared display for one milestone — same "drawer or standalone page" split as `TaskDetailView`. */
export function MilestoneDetailView({ detail }: { detail: MilestoneDetail }) {
  return <div className="task-detail-view">
    <header className="task-detail-header">
      <span className="mono-label">{detail.identityLabel.toUpperCase()}</span>
      <b>{milestoneStatusLabel[detail.status] ?? detail.status}</b>
    </header>
    <h2>{detail.title}</h2>
    {detail.rationale && <p className="milestone-rationale">提议理由：{detail.rationale}</p>}

    <section className="task-detail-background">
      <h3>背景资料</h3>
      <BackgroundPlaceholder />
    </section>

    {detail.successCriteria.length > 0 && <section>
      <h3>达成标准</h3>
      <ul className="criterion-view">{detail.successCriteria.map((criterion) => <li key={criterion.id}>
        <span className="criterion-tag" data-evidence={criterion.evidenceOf ?? "unlabelled"}>
          {criterion.evidenceOf === "outcome" ? "结果" : criterion.evidenceOf === "output" ? "产出物" : "未标注"}
        </span>
        <span>[{criterionKindLabel[criterion.measure.kind]}] {criterion.statement}</span>
        {criterion.measure.kind === "judgement" && <small>判不过的条件：{criterion.measure.failsWhen}</small>}
      </li>)}</ul>
    </section>}

    {detail.relatedWorkOrders.length > 0 && <section>
      <h3>相关任务</h3>
      <ul className="task-detail-related-orders">{detail.relatedWorkOrders.map((order) => <li key={order.id}>
        <a href={`/workbench/${encodeURIComponent(order.id)}`}>{order.intent}</a>
        <small>{stateLabel[order.state] ?? order.state}</small>
      </li>)}</ul>
    </section>}

    <FlywheelList items={detail.relatedFlywheel} />
  </div>;
}
