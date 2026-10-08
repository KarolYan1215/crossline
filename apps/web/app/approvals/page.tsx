import { ensureSeeded, getStore, loadCurrentPlan } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AcceptEvidenceButton, ApproveLineDraftsButton, JudgeMilestoneButton, ProposalBatchForm, RevokeAutoApprovalButton } from "./approval-actions";
import { recentAutoApprovals } from "../../lib/approvals";
import { permissionCandidates, permissionModeEnabled } from "../../lib/permission-mode";
import { PermissionModePanel } from "./permission-mode-panel";
import { requireSessionContext } from "../../lib/access-guard";
import { TaskCard } from "../task/task-card";
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
