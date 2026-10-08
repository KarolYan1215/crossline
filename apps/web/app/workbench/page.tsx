import { stateLabel } from "../../lib/labels";
import { archivedBySystem, ensureSeeded, getStore, loadCurrentPlan, planToday } from "../../lib/crossline";
import { SubpageShell } from "../subpage-shell";
import { AnalyzeButton } from "./analyze-button";
import { PromoteForm } from "./promote-form";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { requireSessionContext } from "../../lib/access-guard";
import { loadTaskDetailsBatch } from "../../lib/task-detail";
import { nextSlots } from "../../lib/steps";
import { TaskCard } from "../task/task-card";

const blockerOf = (run: { payload: unknown }) => (run.payload as { blocker?: { reason: string } }).blocker;

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

const sortLabel = { default: "默认", identity: "按主线", state: "按状态" } as const;
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
  // What the system withdrew on its own (its replaced drafts, demo orders) is not shown: only what the person discarded.
  const systemArchived = new Set(getStore().listEvents(ctx.workspaceId, { type: "work_order.archived" })
    .filter((event) => archivedBySystem(event.payload)).map((event) => event.entityId));
  const discarded = all.filter((run) => run.state === "archived" && !systemArchived.has(run.id));
  const captures = getStore().listCaptures(ctx.workspaceId)
    .filter((capture) => capture.state !== "promoted" && capture.state !== "discarded");
  const attachments = getStore().listCaptureAttachments(ctx.workspaceId);
  const discardedCaptures = getStore().listCaptures(ctx.workspaceId).filter((capture) => capture.state === "discarded");
  const events = getStore().listEvents(ctx.workspaceId, { type: ["materials.blocked", "materials.retry_requested"] });
  const discardReasons = new Map(getStore().listEvents(ctx.workspaceId, { type: ["work_order.archived", "capture.discarded"] })
    .map((event) => [event.entityId, (event.payload as { reason?: string }).reason ?? ""]));
  const identityOptions = defaultIdentityPacks().filter((pack) => pack.kind === "identity")
    .map((pack) => ({ id: pack.id, label: pack.label }));
  const milestoneOptions = getStore().listMilestones(ctx.workspaceId)
    .filter((milestone) => milestone.status === "approved")
    .map((milestone) => ({ id: milestone.id, title: milestone.title, identityId: milestone.identityId }));
  // One batched read for every card instead of one per card — see `loadTaskDetailsBatch`'s own doc comment.
  const taskDetails = loadTaskDetailsBatch(ctx, runs.map((run) => run.id));
  const slots = nextSlots((await loadCurrentPlan(ctx)).blocks, planToday(ctx));
  return <SubpageShell active="任务" title="任务">
    <section className="work-order-list">{captures.map((capture) => <article key={capture.id}>
      <header><span>收集</span><b>{stateLabel[capture.state]}</b></header>
      <h2>{capture.title}</h2><p>{capture.context}</p>
      <p>未分类 · 未估时 · 原文已保存，可人工处理</p>
      {(() => { const own = attachments.filter((item) => item.captureId === capture.id);
        return own.length > 0 && <p>附件 {own.length} 份：{own.map((item, index) => <span key={item.id}>
          {index > 0 ? "、" : ""}
          <a href={`/api/captures/${encodeURIComponent(capture.id)}/attachments?uri=${encodeURIComponent(item.uri)}`}
            target="_blank" rel="noreferrer">{item.fileName}</a>
        </span>)}</p>; })()}
      {capture.audit.blocker && <p role="status" title={capture.audit.blocker.code}>{capture.audit.blocker.message}</p>}
      <AnalyzeButton captureId={capture.id} analyzing={capture.state === "analyzing"} retry={capture.state === "blocked"} />
      <PromoteForm captureId={capture.id} identities={identityOptions} milestones={milestoneOptions} />
    </article>)}</section>
    <>
        <div className="plan-tabs" role="tablist" aria-label="任务排序">
          {(Object.keys(sortLabel) as SortKey[]).map((key) => <a key={key} role="tab" aria-selected={sort === key}
            href={key === "default" ? "/workbench" : `/workbench?sort=${key}`}>{sortLabel[key]}</a>)}
        </div>
        <section className="task-grid">{runs.map((run) => {
      const detail = taskDetails.get(run.id);
      if (!detail) return null;
      const material = run.state === "preparing" ? materialStatus(events, run.id) : undefined;
      return <div key={run.id} id={`work-order-${run.id}`} className="task-grid-item">
        <TaskCard detail={detail} slot={slots.get(run.id)} />
        {material?.kind === "blocked" && <p role="status" className="task-card-note">材料准备已停止 · {material.message}</p>}
        {blockerOf(run) && <p role="status" className="task-card-note">已退回 · {blockerOf(run)!.reason}</p>}
      </div>;
    })}</section>
    </>
    {(discarded.length + discardedCaptures.length) > 0
      && <details className="work-order-drawer advanced"><summary>已归档 {discarded.length + discardedCaptures.length} 项</summary>
        {discarded.map((run) => <p key={run.id}>{run.intent}
          {discardReasons.get(run.id) ? ` · 原因：${discardReasons.get(run.id)}` : ""}</p>)}
        {discardedCaptures.map((capture) => <p key={capture.id}>{capture.title}
          {discardReasons.get(capture.id) ? ` · 原因：${discardReasons.get(capture.id)}` : ""}</p>)}
      </details>}
  </SubpageShell>;
}
