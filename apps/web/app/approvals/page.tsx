import { ensureSeeded, getStore, loadCurrentPlan } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AcceptEvidenceButton, JudgeMilestoneButton, ProposalBatchForm, RevokeAutoApprovalButton } from "./approval-actions";
import { AssistantReview } from "./assistant-review";
import { recentAutoApprovals } from "../../lib/approvals";
import { permissionCandidates, permissionModeEnabled } from "../../lib/permission-mode";
import { PermissionModePanel } from "./permission-mode-panel";
import { requireSessionContext } from "../../lib/access-guard";
import { TaskCard } from "../task/task-card";
import { loadTaskDetailsBatch } from "../../lib/task-detail";
import { countPending } from "../../lib/pending";
import { loadAsks } from "../../lib/asks";
import { AskList } from "../ask-list";

export const dynamic = "force-dynamic";

const FIRST_PROPOSALS = 5;

export default async function ApprovalsPage() {
  const ctx = await requireSessionContext();
  ensureSeeded(ctx);
  const plan = await loadCurrentPlan(ctx);
  const evidenceReviews = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "evidence_review");
  const proposals = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "awaiting_plan_approval");
  const claims = getStore().listEvidenceClaims(ctx.workspaceId);
  // A revoked acceptance puts the order back here with the same evidence, and the gate deliberately
  // will not re-judge it on its own — so without the reason on screen the order looks stuck for no
  // stated cause, and the button that would move it looks like it does nothing.
  const revocations = new Map(getStore().listEvents(ctx.workspaceId, { type: "milestone_gate.auto_acceptance_revoked" })
    .map((event) => [event.entityId, String((event.payload as { reason?: string }).reason ?? "")]));
  // The gate's own refusal, last word wins against a later 「现在判定」 retry request. It used to be written
  // to the ledger and the worker log only, so the page said 「等待里程碑闸门」 indefinitely for a verdict
  // that had already come back — with the one thing the person could do about it (write criteria) nowhere.
  const gateBlocks = new Map<string, { code: string; message: string }>();
  for (const event of getStore().listEvents(ctx.workspaceId, { type: ["milestone_gate.blocked", "milestone_gate.retry_requested"] })) {
    if (event.type === "milestone_gate.blocked") gateBlocks.set(event.entityId, event.payload as { code: string; message: string });
    else gateBlocks.delete(event.entityId);
  }
  const pending = countPending(ctx);
  const asks = await loadAsks(ctx);
  const anchors = new Map(getStore().listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const executions = getStore().listExecutions(ctx.workspaceId);
  const taskDetails = loadTaskDetailsBatch(ctx, [...evidenceReviews, ...proposals].map((item) => item.id));
  const autoApproved = recentAutoApprovals(ctx);
  // Soonest milestone deadline first: the queue is read top-down, and five is about what a person decides
  // well in one sitting — the rest wait folded instead of lengthening the page.
  const deadlineOf = (milestoneId: string) => anchors.get(milestoneId)?.deadline ?? "9999-12-31";
  const sortedProposals = [...proposals].sort((a, b) => deadlineOf(a.milestoneId).localeCompare(deadlineOf(b.milestoneId)));
  // The earliest suggested block per proposal (a split task has several; the first is when it would start).
  const slotOf = new Map<string, { day: string; start: string; end: string }>();
  for (const block of [...plan.blocks].filter((item) => item.id.startsWith("proposed:") && item.day)
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))) {
    const id = block.id.split(":")[1]!;
    if (!slotOf.has(id)) slotOf.set(id, { day: block.day!, start: block.start, end: block.end });
  }
  const renderProposal = (item: (typeof proposals)[number]) => {
    const detail = taskDetails.get(item.id);
    if (!detail) return null;
    const slot = slotOf.get(item.id);
    return <div key={item.id} className="proposal-item">
      <label className="proposal-check"><input type="checkbox" name="proposal" value={item.id} defaultChecked /><span className="sr-only">选中「{item.intent}」</span></label>
      <TaskCard detail={detail} slot={slot} />
    </div>;
  };
  // Drafts, plan differences, targets and interview items are decided where they live (主线, 计划, 访谈); here they are counted and
  // linked. What is decided here is listed in full below.
  return <SubpageShell active="待确认" title="待确认"
    description={pending.total ? `${pending.total} 项待决定。内部、可撤销的准备步骤自动生效，24 小时内可撤销；其余需要批准。` : "暂无待决定事项。"}>
    <section className="pending-list" aria-label="待确认汇总">
      {([
        ["待决事项", asks.length, "#asks"], ["任务提案", pending.workOrders, "#proposals"], ["待验收", evidenceReviews.length, "#evidence"],
        ["助手", pending.assistantKinds + pending.assistantQuestions + pending.assistantReviews, "#assistant"],
        ["里程碑草稿", pending.milestoneDrafts, "/milestones"], ["计划差异", pending.planChanges, "/plan#plan-changes"], ["分数线待审阅", pending.targets, "/milestones"],
        ["调研建议", pending.research, "/onboarding"], ["文件中的日期", pending.dates, "/onboarding"], ["访谈问题", pending.questions, "/onboarding"]
      ] as const).filter(([, count]) => count > 0).map(([label, count, href]) =>
        <a key={label} className="panel" href={href}><b>{count}</b><span>{label}</span></a>)}
    </section>
    <AskList initial={asks} visible={50} />
    {autoApproved.length > 0 && <section className="pending-block" aria-label="最近自动生效">
      <h2>最近自动生效 · {autoApproved.length}</h2>
      <p className="review-note">内部、可撤销的准备步骤；撤销后回到提案，不再自动生效。</p>
      <ul>{autoApproved.map((item) => <li key={item.id}>
        <a href={`/workbench/${encodeURIComponent(item.id)}`}>{item.intent}</a>
        {item.undoable ? <RevokeAutoApprovalButton workOrderId={item.id} /> : <small> · 已开始做</small>}
      </li>)}</ul>
    </section>}
    {permissionModeEnabled(ctx) && <PermissionModePanel initialCandidates={permissionCandidates(ctx).filter((item) => item.kind !== "insight")} />}
    <AssistantReview ctx={ctx} />
    <section className="approval-ledger" id="evidence">
      {evidenceReviews.map((item) => {
        const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
        const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
        return <article key={item.id}>
          <b>待验收</b><a href={`/workbench/${encodeURIComponent(item.id)}`}><strong>{item.intent}</strong></a>
          <p>
            {own.length ? own.map((claim) => `${({ file: "文件", link: "链接", record: "记录", telemetry: "遥测" } as Record<string, string>)[claim.kind] ?? claim.kind} · ${claim.description} · ${claim.uri}`).join("；") : "本次提交没有证据声明"}
            {execution?.durationObserved
              ? ` · 实际执行记录：被中断 ${execution.pauseMinutes} 分钟`
              : " · 时长未观测"}
          </p>
          {item.milestoneId
            ? <>
                {gateBlocks.has(item.id)
                  ? <p role="alert"><strong>闸门没有判定这份证据</strong> · {gateBlocks.get(item.id)!.message}
                  </p>
                  : <p><strong>等待里程碑闸门</strong> · 闸门判这份证据是否兑现了本作业的交付承诺；里程碑整体是否达成另行记录。</p>}
                {revocations.has(item.id) && <p role="status">
                  验收已撤销，原因：{revocations.get(item.id)}。同一份证据不会自动重判；补充后点「现在判定」。
                </p>}
                <JudgeMilestoneButton workOrderId={item.id} />
              </>
            : <AcceptEvidenceButton workOrderId={item.id} />}</article>;
      })}
    </section>
    {proposals.length > 0 && <ProposalBatchForm count={proposals.length}>
      <section className="work-order-list" id="proposals">{sortedProposals.slice(0, FIRST_PROPOSALS).map(renderProposal)}</section>
      {sortedProposals.length > FIRST_PROPOSALS && <details className="fold">
        <summary>以后再说 · 还有 {sortedProposals.length - FIRST_PROPOSALS} 个（截止更远或没有截止）</summary>
        <section className="work-order-list">{sortedProposals.slice(FIRST_PROPOSALS).map(renderProposal)}</section>
      </details>}
    </ProposalBatchForm>}
  </SubpageShell>;
}
