import { ensureSeeded, getStore, loadCurrentPlan } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AcceptEvidenceButton, ApproveProposalButton, JudgeMilestoneButton } from "./approval-actions";
import type { AnalysisProposal } from "@crossline/core";
import { permissionCandidates, permissionModeEnabled } from "../../lib/permission-mode";
import { PermissionModePanel } from "./permission-mode-panel";
import { requireSessionContext } from "../../lib/access-guard";
import { TaskPreview } from "../task-preview";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const ctx = await requireSessionContext();
  ensureSeeded(ctx);
  const plan = await loadCurrentPlan(ctx);
  const pendingPlanChanges = plan.changes.filter((change) => change.status === "pending").length;
  const evidenceReviews = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "evidence_review");
  const proposals = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "awaiting_plan_approval");
  const claims = getStore().listEvidenceClaims(ctx.workspaceId);
  // A revoked acceptance puts the order back here with the same evidence, and the gate deliberately
  // will not re-judge it on its own — so without the reason on screen the order looks stuck for no
  // stated cause, and the button that would move it looks like it does nothing.
  const revocations = new Map(getStore().listEvents(ctx.workspaceId, { type: "milestone_gate.auto_acceptance_revoked" })
    .map((event) => [event.entityId, String((event.payload as { reason?: string }).reason ?? "")]));
  const executions = getStore().listExecutions(ctx.workspaceId);
  return <SubpageShell eyebrow="05 / APPROVAL CONTROL" title="审批与验收" description="计划差异批量批准；外部动作逐项批准；里程碑证据由 AI 闸门判定并保留人工撤销权。">
    <PermissionModePanel initialEnabled={permissionModeEnabled(ctx)} initialCandidates={permissionCandidates(ctx)} />
    <section className="approval-ledger">
      <header><span>TYPE</span><span>ITEM</span><span>WHY NOW</span><span>ACTION</span></header>
      <article><b>PLAN DIFF</b><strong>Personal Plan v{plan.version} · {pendingPlanChanges} pending</strong><p>{plan.status === "approved" ? "该计划版本已经落入批准账本" : "新增 AI Ahead 准备与人工核心行动块"}</p><a href="/plan">打开 C 视图 →</a></article>
      {evidenceReviews.map((item) => {
        const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
        const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
        return <article key={item.id}>
          <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.intent} />
          <TaskPreview ctx={ctx} workOrderId={item.id} />
          <b>EVIDENCE</b><strong>{item.intent}</strong>
          <p>
            {own.length ? own.map((claim) => `${claim.kind} · ${claim.description} · ${claim.uri}`).join("；") : "本次提交没有证据声明"}
            {execution?.durationObserved
              ? ` · 实际执行记录：被中断 ${execution.pauseMinutes} 分钟`
              : " · 时长未观测"}
          </p>
          {item.milestoneId
            ? <>
                <p><strong>等待里程碑闸门</strong> · 闸门判这份证据是否兑现了本作业的交付承诺；里程碑整体是否达成另行记录。</p>
                {revocations.has(item.id) && <p role="status">
                  你撤销过这条的验收，原因：{revocations.get(item.id)}。闸门不会自动重判同一份证据；补完后点「现在判定」。
                </p>}
                <JudgeMilestoneButton workOrderId={item.id} />
              </>
            : <AcceptEvidenceButton workOrderId={item.id} />}</article>;
      })}
      {!evidenceReviews.length && <article><b>EVIDENCE</b><strong>当前没有待验收结果</strong><p>人工提交完成证据后会出现在这里</p><span>—</span></article>}
    </section>
    <section className="work-order-list">{proposals.map((item) => {
      const proposal = item.payload as AnalysisProposal & { audit: { threadId: string; turnId: string }; contextVersion: string };
      return <article key={item.id}>
        <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.intent} />
        <TaskPreview ctx={ctx} workOrderId={item.id} />
        <header><span>AI PROPOSAL · 待计划审批</span><b>{item.riskTier}</b></header>
        <h2>{item.intent}</h2>
        <p>结构和输入引用已校验；语义仍需人工判断。尚未批准、排程或执行。</p>
        <p>{item.identityId} / {item.projectId} / {item.milestoneId}</p>
        <p>估时 p25 / p50 / p85：{item.estimate.p25Minutes} / {item.estimate.p50Minutes} / {item.estimate.p85Minutes} 分钟 · {item.estimate.source} · {item.estimate.observationCount} 次观测 · {item.estimate.confidence}</p>
        <h3>AI 准备提案</h3>{proposal.automationParts.map((part) => <p key={part.id}>{part.intent} — 依据「{part.quote}」：{part.rationale}</p>)}
        <h3>人工核心</h3>{proposal.humanCore.map((part) => <p key={part.id}>{part.intent} — 依据「{part.quote}」：{part.rationale}</p>)}
        {/* The reason travels with the item. Approving 「数据增强的具体参数记录」 without knowing why this
            work order needs it is the same guess as approving a relation with no stated claim. */}
        <h3>材料与证据要求</h3>{[...proposal.materialContract, ...proposal.evidenceContract].map((contract, index) => <p key={index}>
          {contract.kind} · {contract.description}{"required" in contract && contract.required ? " · 必需" : ""}
          {contract.why ? <><br /><small>为什么需要：{contract.why}</small></> : ""}
        </p>)}
        <details><summary>分析审计</summary><p>{proposal.contextVersion} · thread {proposal.audit.threadId} · turn {proposal.audit.turnId}</p></details>
        <ApproveProposalButton workOrderId={item.id} />
      </article>;
    })}</section>
    <section className="status-grid approval-policies">
      <article className="status-card"><span className="status-badge">PER ITEM</span><h2>外部动作</h2><p>邮件、发布、科研提交和高风险外部使用。</p></article>
      <article className="status-card"><span className="status-badge">BATCH</span><h2>计划变化</h2><p>Added / Moved / Removed / Conflict 可整批批准或逐项排除。</p></article>
      <article className="status-card"><span className="status-badge">AUTOMATIC</span><h2>本地准备</h2><p>只读研究、本地草稿和可撤销材料准备。</p></article>
      <article className="status-card"><span className="status-badge">NEVER</span><h2>硬禁区</h2><p>券商订单与静默修改源日历。</p></article>
    </section>
  </SubpageShell>;
}
