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
import { decisionHorizon } from "../../lib/horizon";
import { AskList } from "../ask-list";

export const dynamic = "force-dynamic";

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
  const weekAsks = asks.filter((ask) => !ask.entersOn), laterAsks = asks.filter((ask) => ask.entersOn);
  const horizon = decisionHorizon(ctx);
  const anchors = new Map(getStore().listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const executions = getStore().listExecutions(ctx.workspaceId);
  const ordersById = new Map(getStore().listWorkOrders(ctx.workspaceId).map((item) => [item.id, item]));
  const deferredOrder = (workOrderId: string) => { const order = ordersById.get(workOrderId); return order ? horizon.orderEntry(order) : undefined; };
  const taskDetails = loadTaskDetailsBatch(ctx, [...evidenceReviews, ...proposals].map((item) => item.id));
  const autoApproved = recentAutoApprovals(ctx);
  // Soonest milestone deadline first. Proposals whose work need not start within a week wait folded under 「以后再定」, the soonest
  // to come up first, and come into the week's list by themselves (`lib/horizon.ts`).
  const deadlineOf = (milestoneId: string) => anchors.get(milestoneId)?.deadline ?? "9999-12-31";
  const sortedProposals = [...proposals].sort((a, b) => deadlineOf(a.milestoneId).localeCompare(deadlineOf(b.milestoneId)));
  const entersOn = new Map(sortedProposals.map((item) => [item.id, horizon.orderEntry(item)]));
  const weekProposals = sortedProposals.filter((item) => !entersOn.get(item.id));
  const laterProposals = sortedProposals.filter((item) => entersOn.get(item.id)).sort((a, b) => entersOn.get(a.id)!.localeCompare(entersOn.get(b.id)!));
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
    const enters = entersOn.get(item.id);
    return <div key={item.id} className="proposal-item">
      <label className="proposal-check"><input type="checkbox" name="proposal" value={item.id} defaultChecked /><span className="sr-only">选中「{item.intent}」</span></label>
      <TaskCard detail={detail} slot={slot} />
      {enters && <small className="proposal-enters">{enters.slice(5)} 起列入本周</small>}
    </div>;
  };
  // Drafts, plan differences, targets and interview items are decided where they live (主线, 计划, 访谈); here they are counted and
  // linked. What is decided here is listed in full below.
  return <SubpageShell active="待确认" title="待确认"
    description={`${pending.total ? `本周 ${pending.total} 项待决定。` : "本周暂无待决定事项。"}${pending.later.total ? `另有 ${pending.later.total} 项的工作一周后才需开始，列在「以后再定」，到时自动列入本周。` : ""}内部、可撤销的准备步骤自动生效，24 小时内可撤销。`}>
    <section className="pending-list" aria-label="待确认汇总">
      {([
        ["待决事项", weekAsks.length, "#asks"], ["任务提案", pending.workOrders, "#proposals"], ["待验收", evidenceReviews.length, "#evidence"],
        ["助手", pending.assistantKinds + pending.assistantQuestions + pending.assistantReviews, "#assistant"],
        ["里程碑草稿", pending.milestoneDrafts, "/milestones"], ["分数线待审阅", pending.targets, "/milestones"],
        ["调研建议", pending.research, "/onboarding"], ["文件中的日期", pending.dates, "/onboarding"], ["访谈问题", pending.questions, "/onboarding"],
        ["以后再定", pending.later.total, "#later"]
      ] as const).filter(([, count]) => count > 0).map(([label, count, href]) =>
        <a key={label} className="panel" href={href}><b>{count}</b><span>{label}</span></a>)}
    </section>
    <AskList initial={weekAsks} />
    {autoApproved.length > 0 && <section className="pending-block" aria-label="最近自动生效">
      <h2>最近自动生效 · {autoApproved.length}</h2>
      <p className="review-note">内部、可撤销的准备步骤；撤销后回到提案，不再自动生效。</p>
      <ul>{autoApproved.map((item) => <li key={item.id}>
        <a href={`/workbench/${encodeURIComponent(item.id)}`}>{item.intent}</a>
        {item.undoable ? <RevokeAutoApprovalButton workOrderId={item.id} /> : <small> · 已开始做</small>}
      </li>)}</ul>
    </section>}
    {permissionModeEnabled(ctx) && <PermissionModePanel initialCandidates={permissionCandidates(ctx).filter((item) => item.kind !== "insight")} />}
    <AssistantReview ctx={ctx} deferred={deferredOrder} />
    <section className="approval-ledger" id="evidence">
      {evidenceReviews.map((item) => {
        const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
        const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
        return <article key={item.id}>
          <b>待验收</b><a href={`/workbench/${encodeURIComponent(item.id)}`}><strong>{item.intent}</strong></a>
          <p>
            {own.length ? own.map((claim) => `${({ file: "文件", link: "链接", record: "记录", telemetry: "遥测" } as Record<string, string>)[claim.kind] ?? claim.kind} · ${claim.description}${claim.kind === "file" ? "" : ` · ${claim.uri}`}`).join("；") : "本次提交没有证据声明"}
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
    {weekProposals.length > 0 && <ProposalBatchForm count={weekProposals.length}>
      <section className="work-order-list" id="proposals">{weekProposals.map(renderProposal)}</section>
    </ProposalBatchForm>}
    {pending.later.total > 0 && <details className="fold advanced" id="later">
      {/* The same total as the tile and the line on top; the assistant's results it counts are listed in their own section. */}
      <summary>以后再定 · {pending.later.total} 项（工作一周后才需开始，到时自动列入本周）</summary>
      <AskList initial={laterAsks} scope="later" heading="以后再定的待决事项" />
      {pending.later.assistantReviews > 0 && <p><a href="#assistant">{pending.later.assistantReviews} 份助手成果</a>在「助手」一节，对应任务一周后才需开始。</p>}
      {pending.later.milestoneDrafts > 0 && <p><a href="/milestones">{pending.later.milestoneDrafts} 个里程碑草稿</a>在主线页，截止较远。</p>}
      {laterProposals.length > 0 && <ProposalBatchForm count={laterProposals.length}>
        <section className="work-order-list">{laterProposals.map(renderProposal)}</section>
      </ProposalBatchForm>}
    </details>}
  </SubpageShell>;
}
