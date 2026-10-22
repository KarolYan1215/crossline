import { onPersonsBoard } from "@crossline/core";
import { ensureSeeded, getStore, loadCurrentPlan, planToday } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { FirstHint } from "../ui/first-hint";
import { AcceptEvidenceButton, JudgeMilestoneButton, ProposalBatchForm, RevokeAutoApprovalButton } from "./approval-actions";
import { AssistantReview } from "./assistant-review";
import { recentAutoApprovals } from "../../lib/approvals";
import { permissionCandidates, permissionModeEnabled } from "../../lib/permission-mode";
import { PermissionModePanel } from "./permission-mode-panel";
import { requireSessionContext } from "../../lib/access-guard";
import { gateUntilReady } from "../../lib/start-gate";
import { TaskCard } from "../task/task-card";
import { loadTaskDetailsBatch } from "../../lib/task-detail";
import { countPending } from "../../lib/pending";
import { LivePendingCount } from "../pending-badge";
import { loadAsks } from "../../lib/asks";
import { loadAssistant } from "../../lib/agent";
import { preparingProposalIds } from "../../lib/proposal-ready";
import { decisionHorizon } from "../../lib/horizon";
import { AskList } from "../ask-list";
import { AskBoard } from "../asks/ask-board";
import { loadAskPreviews } from "../asks/previews";
import { uniqueAsks } from "../asks/model";
import { PendingSummary } from "./summary";
import "./approvals.css";
import { timed, timedSync } from "../../lib/sections";

export const dynamic = "force-dynamic";

/** How many of the last day's automatic approvals are listed before the rest fold. */
const AUTO_SHOWN = 5;

export default async function ApprovalsPage() {
  const ctx = await requireSessionContext();
  gateUntilReady(ctx);
  ensureSeeded(ctx);
  const plan = await timed("plan.current", () => loadCurrentPlan(ctx));
  const evidenceReviews = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "evidence_review");
  // A proposal whose steps are still being planned is not a decision yet (`preparingProposalIds`): it is neither listed nor approvable here.
  const preparing = preparingProposalIds(ctx);
  // Questions to the person waiting as orders (docs/work-split.md) are asked, not approved.
  const waiting = getStore().listWorkOrders(ctx.workspaceId).filter((item) => item.state === "awaiting_plan_approval" && onPersonsBoard(item));
  const proposals = waiting.filter((item) => !preparing.has(item.id));
  const preparingCount = waiting.length - proposals.length;
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
  const pending = timedSync("pending", () => countPending(ctx));
  const asks = uniqueAsks(await timed("asks", () => loadAsks(ctx)));
  const weekAsks = asks.filter((ask) => !ask.entersOn), laterAsks = asks.filter((ask) => ask.entersOn);
  const previews = timedSync("approvals.previews", () => loadAskPreviews(ctx, asks));
  const horizon = decisionHorizon(ctx);
  const anchors = new Map(getStore().listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const executions = getStore().listExecutions(ctx.workspaceId);
  const ordersById = new Map(getStore().listWorkOrders(ctx.workspaceId).map((item) => [item.id, item]));
  const deferredOrder = (workOrderId: string) => { const order = ordersById.get(workOrderId); return order ? horizon.orderEntry(order) : undefined; };
  const taskDetails = timedSync("approvals.details", () => loadTaskDetailsBatch(ctx, [...evidenceReviews, ...proposals].map((item) => item.id)));
  const autoApproved = recentAutoApprovals(ctx);
  // Soonest milestone deadline first. Proposals whose work need not start within a week wait folded under 「以后再定」, the soonest
  // to come up first, and come into the week's list by themselves (`lib/horizon.ts`).
  const deadlineOf = (milestoneId: string) => anchors.get(milestoneId)?.deadline ?? "9999-12-31";
  const sortedProposals = [...proposals].sort((a, b) => deadlineOf(a.milestoneId).localeCompare(deadlineOf(b.milestoneId)));
  const entersOn = new Map(sortedProposals.map((item) => [item.id, horizon.orderEntry(item)]));
  const weekProposals = sortedProposals.filter((item) => !entersOn.get(item.id));
  const laterProposals = sortedProposals.filter((item) => entersOn.get(item.id)).sort((a, b) => entersOn.get(a.id)!.localeCompare(entersOn.get(b.id)!));
  // When each decision that can wait comes into the week: asks, proposals, milestone drafts and assistant results — the same four
  // `pending.later` counts.
  const laterDays = [
    ...laterAsks.map((ask) => ask.entersOn!),
    ...laterProposals.map((item) => entersOn.get(item.id)!),
    ...getStore().listMilestones(ctx.workspaceId).filter((item) => item.status === "draft").flatMap((item) => horizon.milestoneEntry(item.id) ?? []),
    ...loadAssistant(ctx).reviews.flatMap((task) => deferredOrder(task.workOrderId) ?? [])
  ];
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
  const autoItem = (item: (typeof autoApproved)[number]) => <li key={item.id}>
    <a href={`/workbench/${encodeURIComponent(item.id)}`} title={item.intent}>{item.title}</a>
    {item.undoable ? <RevokeAutoApprovalButton workOrderId={item.id} /> : <small> · 已开始做</small>}
  </li>;
  const assistantCount = pending.assistantKinds + pending.assistantQuestions + pending.assistantReviews;
  // Drafts, targets and interview items are decided where they live (主线, 访谈); here they are counted and linked. What is decided here
  // is laid out below: the week's questions in four quadrants, then the assistant's results, evidence and task proposals.
  return <SubpageShell active="待确认" title="待确认"
    description={<>本周 <LivePendingCount initial={pending.total} /> 项待确认，其中待决事项 <LivePendingCount initial={pending.asks} field="asks" /> 项{pending.later.total ? `；另有 ${pending.later.total} 项以后再定，不计入` : ""}。只有需本人选择、授权登录或涉及对外动作的才需确认，其余自动生效，24 小时内可撤销。</>}>
    <PendingSummary later={laterDays} today={planToday(ctx)}
      here={[{ label: "助手", count: assistantCount, href: "#assistant" }, { label: "待验收", count: evidenceReviews.length, href: "#evidence" },
        { label: "任务提案", count: pending.workOrders, href: "#proposals" }, { label: "最近自动生效", count: autoApproved.length, href: "#auto" }]}
      elsewhere={[{ label: "里程碑草稿", count: pending.milestoneDrafts, href: "/milestones" }, { label: "分数线待审阅", count: pending.targets, href: "/milestones" },
        { label: "调研建议", count: pending.research, href: "/review" }, { label: "文件中的日期", count: pending.dates, href: "/onboarding" },
        { label: "访谈问题", count: pending.questions, href: "/onboarding" }]} />
    <FirstHint id="approvals" title="四个格子怎么排">
      <ul className="ui-first-hint-list">
        <li>按「紧急」和「重要」分进四格，先处理「紧急重要」</li>
        <li>紧急：两天内不定就会误事；重要：关系到权重高的里程碑或开始使用的基本信息</li>
        <li>每格一次摊开一张，答完下一张自动顶上来，也可以「明天再问」</li>
      </ul>
    </FirstHint>
    <AskBoard initial={weekAsks} previews={previews} />
    <AssistantReview ctx={ctx} deferred={deferredOrder} />
    {evidenceReviews.length > 0 && <section className="approval-ledger" id="evidence" aria-label="待验收">
      <h2>待验收 · {evidenceReviews.length}</h2>
      {evidenceReviews.map((item) => {
        const own = claims.filter((claim) => claim.workOrderId === item.id && claim.reviewStatus === "submitted");
        const execution = executions.filter((entry) => entry.workOrderId === item.id).at(-1);
        return <article key={item.id}>
          <a href={`/workbench/${encodeURIComponent(item.id)}`}><strong>{item.intent}</strong></a>
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
                  : <p><strong>等待里程碑闸门</strong> · 闸门判这份证据是否兑现了本任务的交付承诺；里程碑整体是否达成另行记录。</p>}
                {revocations.has(item.id) && <p role="status">
                  验收已撤销，原因：{revocations.get(item.id)}。同一份证据不会自动重判；补充后点「现在判定」。
                </p>}
                <JudgeMilestoneButton workOrderId={item.id} />
              </>
            : <AcceptEvidenceButton workOrderId={item.id} />}</article>;
      })}
    </section>}
    {preparingCount > 0 && <p className="ap-preparing" role="status">{preparingCount} 项提案正在规划步骤，规划完成后列在这里。</p>}
    {weekProposals.length > 0 && <ProposalBatchForm count={weekProposals.length}>
      <section className="work-order-list" id="proposals">{weekProposals.map(renderProposal)}</section>
    </ProposalBatchForm>}
    {permissionModeEnabled(ctx) && <PermissionModePanel initialCandidates={permissionCandidates(ctx).filter((item) => item.kind !== "insight")} />}
    {autoApproved.length > 0 && <section className="pending-block ap-auto" id="auto" aria-label="最近自动生效">
      <h2>最近自动生效 · {autoApproved.length}</h2>
      <p className="review-note">无需本人决定、不对外的任务已自动生效；24 小时内可撤销，撤销后回到提案。</p>
      {/* The newest few in view; the rest folded, so a busy day does not turn the section into a page-long list. */}
      <ul>{autoApproved.slice(0, AUTO_SHOWN).map(autoItem)}</ul>
      {autoApproved.length > AUTO_SHOWN && <details className="fold advanced"><summary>其余 {autoApproved.length - AUTO_SHOWN} 项</summary>
        <ul>{autoApproved.slice(AUTO_SHOWN).map(autoItem)}</ul></details>}
    </section>}
    {pending.later.total > 0 && <details className="fold advanced" id="later">
      {/* The same total as the line on top; the assistant's results it counts are listed in their own section. */}
      <summary>以后再定 · {pending.later.total} 项（工作一周后才需开始，到时自动列入本周）</summary>
      <AskList initial={laterAsks} scope="later" heading="以后再定的待决事项" previews={previews} />
      {pending.later.assistantReviews > 0 && <p><a href="#assistant">{pending.later.assistantReviews} 份助手成果</a>在「助手」一节，对应任务一周后才需开始。</p>}
      {pending.later.milestoneDrafts > 0 && <p><a href="/milestones">{pending.later.milestoneDrafts} 个里程碑草稿</a>在主线页，截止较远。</p>}
      {laterProposals.length > 0 && <ProposalBatchForm count={laterProposals.length}>
        <section className="work-order-list">{laterProposals.map(renderProposal)}</section>
      </ProposalBatchForm>}
    </details>}
  </SubpageShell>;
}
