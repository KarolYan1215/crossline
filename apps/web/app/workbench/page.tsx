import { ensureSeeded, getStore, loadCurrentPlan, planToday, resolvedEstimate } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AnalyzeButton } from "./analyze-button";
import { ExecutionActions } from "./execution-actions";
import { PromoteForm } from "./promote-form";
import { FamilyBackfill } from "./family-backfill";
import { WorkbenchViewSwitch } from "./view-switch";
import { CalendarDetail } from "../plan/calendar-detail";
import type { MilestoneGateResult } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { requireSessionContext } from "../../lib/access-guard";

// The tail, not the head: ids here are sometimes timestamp-prefixed, and two captures made minutes
// apart shared their first eight characters — the page showed them as the same item twice.
const shortId = (id: string) => id.slice(-8);

const stateLabel: Record<string, string> = {
  captured: "已收集", analyzing: "分析中", awaiting_plan_approval: "等待计划批准",
  approved: "已批准", preparing: "材料准备中", ready_for_human: "可开始",
  active: "执行中", evidence_review: "证据审查中", accepted: "已验收", blocked: "已阻塞", archived: "已归档"
};
const riskLabel: Record<string, string> = { routine: "常规", milestone: "里程碑", high_risk: "高风险" };
const confidenceLabel: Record<string, string> = { low: "低置信", medium: "中置信", high: "高置信" };

const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
const blockerOf = (run: { payload: unknown }) => (run.payload as { blocker?: { reason: string } }).blocker;
const gateReviewOf = (run: { payload: unknown }) =>
  (run.payload as { gateReview?: MilestoneGateResult | undefined }).gateReview;
const metLabel: Record<string, string> = { met: "达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };
const gateVerdictLabel: Record<string, string> = { pass: "通过", insufficient: "证据不足", refuted: "被证据否定" };

/**
 * What material preparation is currently doing for one work order, in the order the person needs it:
 * a blocker they can act on, then a retry they asked for, then the plain "running" state.
 *
 * Without this the card said 材料准备中 and nothing else — including for an order whose preparation had
 * already refused with a reason, which left the person watching a spinner for a run that was over.
 */
function materialStatus(events: Array<{ type: string; entityId: string; payload: unknown }>, workOrderId: string):
  { kind: "blocked"; message: string } | { kind: "requested" } | undefined {
  let latest: { kind: "blocked"; message: string } | { kind: "requested" } | undefined;
  for (const event of events) {
    if (event.entityId !== workOrderId) continue;
    if (event.type === "materials.blocked") {
      const payload = event.payload as { code?: string; message?: string };
      latest = { kind: "blocked", message: payload.message ?? payload.code ?? "材料准备被阻塞" };
    } else if (event.type === "materials.retry_requested") latest = { kind: "requested" };
  }
  return latest;
}

export const dynamic = "force-dynamic";

const sortLabel = { default: "默认", identity: "按身份", state: "按状态" } as const;
type SortKey = keyof typeof sortLabel;

export default async function WorkbenchPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const ctx = await requireSessionContext();
  const params = await searchParams;
  const sort: SortKey = params.sort === "identity" || params.sort === "state" ? params.sort : "default";
  ensureSeeded(ctx);
  const all = getStore().listWorkOrders(ctx.workspaceId);
  // Discarded items leave the board but not the ledger: they move to a closed drawer with the reason
  // the person gave, so "丢弃" never means "silently disappeared".
  const active = all.filter((run) => run.state !== "archived");
  const runs = sort === "identity" ? [...active].sort((a, b) => a.identityId.localeCompare(b.identityId) || a.id.localeCompare(b.id))
    : sort === "state" ? [...active].sort((a, b) => a.state.localeCompare(b.state) || a.id.localeCompare(b.id))
    : active;
  const discarded = all.filter((run) => run.state === "archived");
  const captures = getStore().listCaptures(ctx.workspaceId)
    .filter((capture) => capture.state !== "promoted" && capture.state !== "discarded");
  const attachments = getStore().listCaptureAttachments(ctx.workspaceId);
  const discardedCaptures = getStore().listCaptures(ctx.workspaceId).filter((capture) => capture.state === "discarded");
  const executions = getStore().listExecutions(ctx.workspaceId);
  const materials = getStore().listMaterials(ctx.workspaceId);
  const events = getStore().listEvents(ctx.workspaceId).filter((event) => event.type.startsWith("materials."));
  const discardReasons = new Map(getStore().listEvents(ctx.workspaceId, { type: ["work_order.archived", "capture.discarded"] })
    .map((event) => [event.entityId, (event.payload as { reason?: string }).reason ?? ""]));
  const identityOptions = defaultIdentityPacks().filter((pack) => pack.kind === "identity")
    .map((pack) => ({ id: pack.id, label: pack.label }));
  const milestoneOptions = getStore().listMilestones(ctx.workspaceId)
    .filter((milestone) => milestone.status === "approved")
    .map((milestone) => ({ id: milestone.id, title: milestone.title, identityId: milestone.identityId }));
  const milestoneTitleById = new Map(getStore().listMilestones(ctx.workspaceId)
    .map((milestone) => [milestone.id, milestone.title]));
  const workOrderMilestones = Object.fromEntries(all
    .filter((order) => order.milestoneId && milestoneTitleById.has(order.milestoneId))
    .map((order) => [order.id, milestoneTitleById.get(order.milestoneId)!]));
  // The timeline view reuses the Plan page's own scheduling read verbatim (`loadCurrentPlan` /
  // `CalendarDetail`) rather than a second, Workbench-owned notion of "when" — one real schedule, shown
  // from two places, is what keeps this from ever disagreeing with the Plan page.
  const today = planToday(ctx);
  const plan = await loadCurrentPlan(ctx);
  return <SubpageShell eyebrow="04 / AI WORK ORDERS" title="AI 作业台" description="这里呈现 SQLite 中真实的 WorkOrder、估时、材料和阻塞；不让用户编辑内部 DAG。">
    <section className="work-order-list">{captures.map((capture) => <article key={capture.id}>
      <header><span>CAPTURE / {shortId(capture.id)}</span><b>{stateLabel[capture.state]}</b></header>
      <h2>{capture.title}</h2><p>{capture.context}</p>
      <p>未分类 · 未估时 · 原文已保存，可人工处理</p>
      {(() => { const own = attachments.filter((item) => item.captureId === capture.id);
        return own.length > 0 && <p>附件 {own.length} 份：{own.map((item, index) => <span key={item.id}>
          {index > 0 ? "、" : ""}
          <a href={`/api/captures/${encodeURIComponent(capture.id)}/attachments?uri=${encodeURIComponent(item.uri)}`}
            target="_blank" rel="noreferrer">{item.fileName}</a>
        </span>)}</p>; })()}
      {capture.audit.blocker && <p role="status">{capture.audit.blocker.code} · {capture.audit.blocker.message}</p>}
      <AnalyzeButton captureId={capture.id} analyzing={capture.state === "analyzing"} retry={capture.state === "blocked"} />
      <PromoteForm captureId={capture.id} identities={identityOptions} milestones={milestoneOptions} />
    </article>)}</section>
    <WorkbenchViewSwitch
      list={<>
        <div className="plan-tabs" role="tablist" aria-label="作业排序">
          {(Object.keys(sortLabel) as SortKey[]).map((key) => <a key={key} role="tab" aria-selected={sort === key}
            href={key === "default" ? "/workbench" : `/workbench?sort=${key}`}>{sortLabel[key]}</a>)}
        </div>
        <section className="work-order-list">{runs.map((run) => {
      const own = executions.filter((execution) => execution.workOrderId === run.id);
      const open = own.find((execution) => !execution.endedAt);
      const paused = Boolean(open?.interruptions.at(-1) && !open.interruptions.at(-1)!.resumedAt);
      const prepared = materials.filter((material) => material.workOrderId === run.id);
      const material = materialStatus(events, run.id);
      // Personal-history calibration (packages/core/src/estimate.ts) overrides the raw analysis-time
      // guess once this (identityId, family) bucket has real completions — this is the one page where
      // that number actually informs a decision the person is about to make.
      const estimate = resolvedEstimate(ctx, run);
      return <article id={`work-order-${run.id}`} key={run.id}>
        <header><span>{run.identityId.toUpperCase()} / {shortId(run.id)}</span><b><i className="gly" data-s={run.state} aria-hidden="true" />{stateLabel[run.state] ?? "未知状态"}</b></header>
        <h2>{run.intent}</h2>
        {/* The milestone this work order serves, on the card itself — previously only visible by
            cross-referencing Milestones or the PromoteForm's own dropdown. */}
        {run.milestoneId && milestoneTitleById.has(run.milestoneId)
          && <p className="card-milestone">→ {milestoneTitleById.get(run.milestoneId)}</p>}
        {(run.payload as { manualPromotion?: boolean }).manualPromotion
          && <p role="status">人工创建 · 未经 AI 分析</p>}
        <p>{estimate.p25Minutes}–{estimate.p85Minutes} 分钟 · {confidenceLabel[estimate.confidence]} · {riskLabel[run.riskTier]}</p>
        {!(run.payload as { family?: string }).family
          && ["preparing", "ready_for_human", "active", "evidence_review"].includes(run.state)
          && <FamilyBackfill workOrderId={run.id} />}
        {/* The action that advances this work order sits on the card, not inside the disclosure. Behind a
            closed drawer the next step was invisible, and every action reloads the page and closes the
            drawer again — so doing two things in a row meant re-opening it every time. */}
        {run.state === "preparing" && (material?.kind === "blocked"
          ? <p role="status">材料准备已停下 · {material.message}</p>
          : <p role="status">{material?.kind === "requested" ? "已请求重新准备，正在运行。" : "材料准备进行中。"}</p>)}
        {/* A `file:///` URI printed as text is not something a browser can open, so the材料 the app had
            just prepared were effectively unreachable from the app. These open in place. */}
        {prepared.length > 0 && <p>已备材料 {prepared.length} 份：{prepared.map((item, index) => <span key={item.id}>
          {index > 0 ? "、" : ""}
          <a href={`/api/work-orders/${encodeURIComponent(run.id)}/materials?uri=${encodeURIComponent(item.uri)}`}
            target="_blank" rel="noreferrer">{item.uri.split("/").pop()}</a>
        </span>)}</p>}
        <ExecutionActions workOrderId={run.id} intent={run.intent} state={run.state} paused={paused}
          ownerId={ctx.principalId} workspaceId={ctx.workspaceId} />
        {blockerOf(run) && <p role="status">已退回 · {blockerOf(run)!.reason}</p>}
        {/* A held order used to show only the code. The gate's own per-criterion reading is what says
            which standard was not met and what would satisfy it, so it is shown rather than stored. */}
        {gateReviewOf(run) && <details className="work-order-drawer">
          <summary>里程碑闸门判定 · {gateVerdictLabel[gateReviewOf(run)!.verdict] ?? gateReviewOf(run)!.verdict}</summary>
          {gateReviewOf(run)!.criteriaVerdict.map((item) => <p key={item.criterionId}>
            {metLabel[item.met] ?? item.met} · {item.observed}{item.shortfall ? ` · 还差：${item.shortfall}` : ""}
          </p>)}
          {gateReviewOf(run)!.gaps.map((gap) => <p key={gap.code}>缺口 {gap.code} · 需要：{gap.whatWouldSatisfyIt}</p>)}
        </details>}
        {paused && <p role="status">已暂停；暂停期间不计入真实工作时间。</p>}
        <details className="work-order-drawer"><summary>执行记录</summary>{own.map((execution) => <p key={execution.id}>
          {!execution.durationObserved ? "时长未观测（一次性补记完成）"
            : execution.endedAt ? `实际执行 ${minutesBetween(execution.startedAt, execution.endedAt) - execution.pauseMinutes} 分钟 · 被中断 ${execution.pauseMinutes} 分钟`
            : `执行中 · 已记录中断 ${execution.pauseMinutes} 分钟`}
          {execution.interruptions.length ? ` · 中断原因：${execution.interruptions.map((item) => item.reason).join("、")}` : ""}
          {execution.outcome === "completed_without_evidence" ? " · 无证据声明" : ""}
        </p>)}
        <a href="/approvals">查看状态与证据 →</a></details>
      </article>;
    })}</section>
      </>}
      timeline={<CalendarDetail blocks={plan.blocks} today={today} workOrderMilestones={workOrderMilestones} />}
    />
    {(discarded.length + discardedCaptures.length) > 0
      && <details className="work-order-drawer"><summary>已丢弃 {discarded.length + discardedCaptures.length} 条</summary>
        {discarded.map((run) => <p key={run.id}>{run.intent}
          {discardReasons.get(run.id) ? ` · 原因：${discardReasons.get(run.id)}` : ""}</p>)}
        {discardedCaptures.map((capture) => <p key={capture.id}>{capture.title}
          {discardReasons.get(capture.id) ? ` · 原因：${discardReasons.get(capture.id)}` : ""}</p>)}
      </details>}
  </SubpageShell>;
}
