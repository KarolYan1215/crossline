import { ensureSeeded, getStore, loadCurrentPlan, resolvedEstimate } from "../../lib/crossline";
import { estimateBasis } from "../../lib/estimate-label";
import { riskLabel } from "../../lib/labels";
import { SubpageShell } from "../subpage-shell";
import { AcceptEvidenceButton, ApproveLineDraftsButton, ApproveProposalButton, JudgeMilestoneButton, ProposalBatchForm, RevokeAutoApprovalButton } from "./approval-actions";
import { recentAutoApprovals } from "../../lib/approvals";
import type { AnalysisProposal } from "@crossline/core";
import { permissionCandidates, permissionModeEnabled } from "../../lib/permission-mode";
import { PermissionModePanel } from "./permission-mode-panel";
import { requireSessionContext } from "../../lib/access-guard";
import { TaskPreview } from "../task-preview";
import { loadTaskDetailsBatch } from "../../lib/task-detail";
import { countPending } from "../../lib/pending";
import { defaultIdentityPacks } from "@crossline/identity-packs";
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
  const milestoneById = new Map(getStore().listMilestones(ctx.workspaceId).map((milestone) => [milestone.id, milestone]));
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
  const lineOrder = defaultIdentityPacks().map((pack) => pack.id);
  // By line, then by when it is due, so a line's drafts read as the sequence they are.
  const draftMilestones = getStore().listMilestones(ctx.workspaceId).filter((milestone) => milestone.status === "draft")
    .sort((a, b) => lineOrder.indexOf(a.identityId) - lineOrder.indexOf(b.identityId)
      || (anchors.get(a.id)?.deadline ?? "9999").localeCompare(anchors.get(b.id)?.deadline ?? "9999"));
  const lineLabels: Record<string, string> = Object.fromEntries(defaultIdentityPacks().map((pack) => [pack.id, pack.label]));
  const executions = getStore().listExecutions(ctx.workspaceId);
  const taskDetails = loadTaskDetailsBatch(ctx, [...evidenceReviews, ...proposals].map((item) => item.id));
  const autoApproved = recentAutoApprovals(ctx);
  // Soonest milestone deadline first: the queue is read top-down, and five is about what a person decides
  // well in one sitting — the rest wait folded instead of lengthening the page.
  const deadlineOf = (milestoneId: string) => anchors.get(milestoneId)?.deadline ?? "9999-12-31";
  const sortedProposals = [...proposals].sort((a, b) => deadlineOf(a.milestoneId).localeCompare(deadlineOf(b.milestoneId)));
  // The earliest suggested block per proposal (a split task has several; the first is when it would start).
  const slotOf = new Map<string, string>();
  for (const block of [...plan.blocks].filter((item) => item.id.startsWith("proposed:"))
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`))) {
    const id = block.id.split(":")[1]!;
    if (!slotOf.has(id)) slotOf.set(id, `${block.day?.slice(5) ?? ""} ${block.start}`);
  }
  const renderProposal = (item: (typeof proposals)[number]) => {
    const proposal = item.payload as AnalysisProposal & { audit: { threadId: string; turnId: string }; contextVersion: string };
    const estimate = resolvedEstimate(ctx, item);
    const steps = proposal.estimateBreakdown ?? [];
    const milestone = milestoneById.get(item.milestoneId);
    const deadline = anchors.get(item.milestoneId)?.deadline;
    return <article key={item.id} className="proposal-card">
      <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.intent} />
      <TaskPreview detail={taskDetails.get(item.id)} />
      <header><label className="proposal-check"><input type="checkbox" name="proposal" value={item.id} defaultChecked /> 勾选</label>
        <b>{riskLabel[item.riskTier] ?? item.riskTier}</b></header>
      <h2>{item.intent}</h2>
      <p>{lineLabels[item.identityId] ?? item.identityId}{milestone ? ` · 为「${milestone.title}」` : ""} · 通常 {estimate.p50Minutes} 分，宽一点 {estimate.p85Minutes} 分{deadline ? ` · 最晚 ${deadline}` : ""}{slotOf.get(item.id) ? ` · 建议 ${slotOf.get(item.id)}` : ""}</p>
      {(proposal.byproducts ?? []).map((byproduct) => <p key={byproduct.lineId} className="byproduct-line">
        顺带 → {lineLabels[byproduct.lineId] ?? byproduct.lineId} · {byproduct.artifact}
        <small>（过程中多记 {byproduct.captureSteps.reduce((sum, step) => sum + step.minutes, 0)} 分，做完后落地 {byproduct.landing.minutes} 分；批准后自动排上，不要可在「最近自动生效」撤销）</small>
      </p>)}
      {milestone?.verifiability === "unstated"
        && <p role="note" className="seed-notice">绑定的里程碑还没有达成标准：验收只按下面的「必需」证据判定。<a href="/milestones"> 去补充 →</a></p>}
      <details className="fold"><summary>你要做的、分步与依据</summary>
        <p><small>{estimateBasis(estimate)}</small></p>
        {steps.length > 0 && <p><small>分步：{steps.map((step) => `${step.step} ${step.minutes} 分钟`).join("；")}</small></p>}
        <h3>你要做的</h3>{proposal.humanCore.map((part) => <p key={part.id}>{part.intent} — 依据「{part.quote}」：{part.rationale}</p>)}
        {proposal.automationParts.length > 0 && <><h3>AI 准备的</h3>{proposal.automationParts.map((part) => <p key={part.id}>{part.intent} — 依据「{part.quote}」：{part.rationale}</p>)}</>}
        <h3>材料与证据要求</h3>{[...proposal.materialContract, ...proposal.evidenceContract].map((contract, index) => <p key={index}>
          {({ file: "文件", link: "链接", record: "记录", telemetry: "遥测" } as Record<string, string>)[contract.kind] ?? contract.kind} · {contract.description}{"required" in contract && contract.required ? " · 必需" : ""}
          {contract.why ? <><br /><small>为什么需要：{contract.why}</small></> : ""}
        </p>)}
        <p><small>AI 草拟，等你确认 · {proposal.contextVersion} · thread {proposal.audit.threadId}</small></p>
      </details>
      <ApproveProposalButton workOrderId={item.id} />
    </article>;
  };
  return <SubpageShell active="待确认" title="待确认"
    description={pending.total ? `${pending.total} 件事在等你决定。内部、可撤销的准备工作会自己生效（一天内可撤销），其余都等你点头。` : "没有等你决定的事。"}>
    <section className="pending-list" aria-label="待确认汇总">
      {([
        ["要你回答的", asks.length, "#asks"], ["作业方案", pending.workOrders, "#proposals"], ["计划差异", pending.planChanges, "/plan#plan-changes"],
        ["里程碑草稿", pending.milestoneDrafts, "/milestones"],
        ["调研建议", pending.research, "/onboarding"], ["文件里的日期", pending.dates, "/onboarding"], ["待你回答的问题", pending.questions, "/onboarding"], ["暂定目标待你过目", pending.targets, "/milestones"],
        ["助手想做的新类别", pending.assistantKinds, "/assistant"], ["助手中途的提问", pending.assistantQuestions, "/assistant"], ["助手的产出待审", pending.assistantReviews, "/assistant"]
      ] as const).filter(([, count]) => count > 0).map(([label, count, href]) =>
        <a key={label} className="panel" href={href}><b>{count}</b><span>{label}</span></a>)}
    </section>
    <AskList initial={asks} visible={50} />
    {autoApproved.length > 0 && <section className="pending-block" aria-label="最近自动生效">
      <h2>最近自动生效 · {autoApproved.length}</h2>
      <p className="review-note">这些是内部、可撤销的准备工作，系统替你批准了；一天内不想要就撤销，它会回到这里等你决定，且不会再自动生效。</p>
      <ul>{autoApproved.map((item) => <li key={item.id}>
        <a href={`/workbench/${encodeURIComponent(item.id)}`}>{item.intent}</a>
        {item.undoable ? <RevokeAutoApprovalButton workOrderId={item.id} /> : <small> · 已开始做</small>}
      </li>)}</ul>
    </section>}
    <details className="fold" open={permissionModeEnabled(ctx)}>
      <summary>默认批准（可选）：低风险的变化在前台停留 5 分钟后自动采纳</summary>
      <PermissionModePanel initialEnabled={permissionModeEnabled(ctx)} initialCandidates={permissionCandidates(ctx)} />
    </details>
    {/* What is waiting, spelled out here instead of only counted: three of these used to be a number linking elsewhere, so the
        page that says 「29 件事在等你」 listed two of them. */}
    {draftMilestones.length > 0 && <section className="pending-block" aria-label="里程碑草稿">
      <h2>里程碑草稿 · {draftMilestones.length}</h2>
      <p className="review-note">里程碑是对你自己的承诺，所以要你点头。整条线一次接受后，系统会自动倒推三周内到期的那几个的前几步，排进本周；想改标题、日期或标准，去「主线」逐个改。</p>
      {[...new Set(draftMilestones.map((milestone) => milestone.identityId))].map((line) => {
        const own = draftMilestones.filter((milestone) => milestone.identityId === line);
        return <div key={line} className="line-drafts" data-line={line}>
          <ul>{own.map((milestone) => <li key={milestone.id}>
            <b>{lineLabels[milestone.identityId] ?? milestone.identityId}</b> · {milestone.title}
            <small> · {anchors.get(milestone.id)?.deadline ? `最晚 ${anchors.get(milestone.id)!.deadline}` : "无截止"}</small>
          </li>)}</ul>
          <ApproveLineDraftsButton ids={own.map((milestone) => milestone.id)}
            label={`接受${lineLabels[line] ?? line}的 ${own.length} 个草稿`} />
        </div>;
      })}
      <a className="secondary-button" href="/milestones">去「主线」批准或修改 →</a>
    </section>}
    {pending.planChanges > 0 && <section className="pending-block" aria-label="计划差异">
      <h2>计划差异 · {pending.planChanges}</h2>
      <ul>{plan.changes.filter((change) => change.status === "pending").slice(0, 5).map((change) =>
        <li key={change.id}>{change.explanation}</li>)}</ul>
      <a className="secondary-button" href="/plan#plan-changes">去「计划」逐条采纳或整批批准 →</a>
    </section>}
    {(pending.assistantKinds + pending.assistantQuestions + pending.assistantReviews) > 0 && <section className="pending-block" aria-label="助手">
      <h2>助手 · {pending.assistantKinds + pending.assistantQuestions + pending.assistantReviews}</h2>
      <p>{[pending.assistantKinds ? `${pending.assistantKinds} 类新的工作等你同意它去做` : "", pending.assistantQuestions ? `${pending.assistantQuestions} 个它在做事中途问你的问题（没人答就当作不同意）` : "", pending.assistantReviews ? `${pending.assistantReviews} 份做完的产出等你过目` : ""].filter(Boolean).join("；")}。</p>
      <a className="secondary-button" href="/assistant">去助手页处理 →</a>
    </section>}
    {pending.targets > 0 && <section className="pending-block" aria-label="暂定目标">
      <h2>暂定目标待你过目 · {pending.targets}</h2>
      <p>分数线都是从目标倒推的。目标是系统按你的长期目标先提的（比如一门课的总评），带着理由；合适就点“就按这个”，不合适一键改，所在主线的草稿会按新目标重算。</p>
      <a className="secondary-button" href="/milestones">去看目标 →</a>
    </section>}
    {pending.questions > 0 && <section className="pending-block" aria-label="待你回答的问题">
      <h2>待你回答的问题 · {pending.questions}</h2>
      <p>有的主线目前只有系统的猜测，没有你确认过的事实：说说你实际在做什么，或者这条线先不规划。</p>
      <a className="secondary-button" href="/onboarding">去回答 →</a>
    </section>}
    {(pending.research > 0 || pending.dates > 0) && <section className="pending-block" aria-label="来自采访的待决定">
      <h2>采访带来的 · {pending.research + pending.dates}</h2>
      <p>{pending.research > 0 ? `${pending.research} 条调研建议（每条带已核对的来源）` : ""}{pending.research > 0 && pending.dates > 0 ? "，" : ""}{pending.dates > 0 ? "一批从文件里读出的日期" : ""}。逐条采纳或不要都在「先了解你」那一页。</p>
      <a className="secondary-button" href="/onboarding">去处理 →</a>
    </section>}
    <section className="approval-ledger">
      {evidenceReviews.map((item) => {
        const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
        const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
        return <article key={item.id}>
          <a className="card-cover-link" href={`/workbench/${encodeURIComponent(item.id)}`} aria-label={item.intent} />
          <TaskPreview detail={taskDetails.get(item.id)} />
          <b>待验收</b><strong>{item.intent}</strong>
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
                  你撤销过这条的验收，原因：{revocations.get(item.id)}。闸门不会自动重判同一份证据；补完后点「现在判定」。
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
