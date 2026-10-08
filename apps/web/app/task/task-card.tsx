"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import { riskLabel, riskTone, stateLabelFor } from "../../lib/labels";
import { LineTag, SupportsTag, Tag } from "../ui/tag";
import { TaskActions } from "./task-actions";
import { TaskDialog } from "./task-dialog";
import { TaskQuickEdit } from "./quick-edit";

export type TaskSlot = { day: string; start: string; end: string };
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const slotLabel = (slot: TaskSlot) => { const date = new Date(`${slot.day}T12:00:00`); return `${date.getMonth() + 1}/${date.getDate()} ${WEEKDAY[date.getDay()]} ${slot.start}–${slot.end}`; };

/**
 * The one task card, used on Today, Tasks and Approvals. What matters first: which line and course, the task, its progress and current
 * step, then the figures that are edited in place (deadline, duration) and the next block on the calendar, then what other lines it
 * feeds. Clicking anywhere that is not a control opens the task dialog; `reason` is the recommendation's own wording on Today.
 */
export function TaskCard({ detail, slot, reason, variant = "compact" }: { detail: TaskDetail; slot?: TaskSlot | undefined; reason?: string; variant?: "hero" | "compact" }) {
  const [open, setOpen] = useState(false);
  const current = detail.stepPlan?.steps.find((step) => step.status === "planned");
  const progress = detail.stepPlan ? Math.round(detail.stepPlan.progress * 100) : undefined;
  const openFrom = (event: MouseEvent | KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, [role=dialog], [popover]")) return;
    setOpen(true);
  };
  return <article className="task-card" data-variant={variant} data-line={detail.identityId} data-state={detail.state}
    tabIndex={0} aria-label={`${detail.intent}，打开详情`} onClick={openFrom} onKeyDown={(event) => { if (event.key === "Enter") openFrom(event); }}>
    <header className="task-card-tags">
      <LineTag line={detail.identityId}>{detail.identityLabel}</LineTag>
      {detail.projectName && <Tag tone="info">{detail.projectName}</Tag>}
      <Tag>{stateLabelFor(detail.state, detail.paused)}</Tag>
      {detail.riskTier !== "routine" && <Tag tone={riskTone[detail.riskTier] ?? "neutral"}>{riskLabel[detail.riskTier]}</Tag>}
    </header>
    <h3 className="task-card-title">{detail.intent}</h3>
    {detail.milestone && <p className="task-card-milestone">→ {detail.milestone.title}</p>}
    {reason && <p className="task-card-reason">{reason}</p>}
    {progress !== undefined && <div className="task-card-progress">
      <span className="task-progress-bar" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
      <small><b className="mono">{progress}%</b>{current ? ` · 当前：${current.title}` : " · 步骤已完成"}</small>
    </div>}
    <TaskQuickEdit workOrderId={detail.id} dueBy={detail.window.dueBy} samples={detail.estimate.observationCount} line={detail.identityId}
      estimate={current?.estimate ?? detail.estimate} stepId={current?.id} editable={!["accepted", "archived"].includes(detail.state)}
      durationLabel={current ? "本步时长" : "时长"} />
    {slot && <p className="task-card-slot"><small>下一次</small> <a href={`/plan?day=${slot.day}`} className="mono">{slotLabel(slot)}</a></p>}
    {detail.supports.length > 0 && <p className="task-card-supports">{detail.supports.map((item) =>
      <SupportsTag key={`${item.line}:${item.target}`} line={item.line} lineLabel={item.lineLabel} target={item.target} {...(item.artifact ? { artifact: item.artifact } : {})} />)}</p>}
    <TaskActions workOrderId={detail.id} state={detail.state} paused={detail.paused} agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id} onOpen={() => setOpen(true)}
      offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }} />
    <TaskDialog detail={detail} open={open} onOpenChange={setOpen} />
  </article>;
}
