"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import { dayLabel, formatMinutes } from "../ui/controls";
import { useReturnState } from "../ui/return-state";
import { currentStep, dueDistance, waitReason } from "./card-model";
import { CompletionChoice } from "./completion-choice";
import { Prepared } from "./prepared";
import { StepStrip } from "./step-strip";
import { TaskActions } from "./task-actions";
import { TaskDialog } from "./task-dialog";

export type TaskSlot = { day: string; start: string; end: string };
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const slotLabel = (slot: TaskSlot) => { const date = new Date(`${slot.day}T12:00:00`); return `${date.getMonth() + 1}/${date.getDate()} ${WEEKDAY[date.getDay()]} ${slot.start}–${slot.end}`; };

/**
 * The one task card, used on Today, Tasks, Approvals and the weekly review (redesigned 2026-10-15). It answers, in reading order: which
 * line (the colour and its name, with the course), which task, how far along (the step picture), what to do now (the current step and its
 * first five-minute move), what it waits for if anything, when it next has time and when it is due. Everything else — the description,
 * risk, cross-line support, the due date and duration editors — is in the task dialog the whole card opens. `reason` is Today's own
 * wording for the recommendation; `today` lets the due day say how far off it is (left out where the page has no "today" of its own).
 */
export function TaskCard({ detail, slot, reason, today, variant = "compact" }: {
  detail: TaskDetail; slot?: TaskSlot | undefined; reason?: string; today?: string | undefined; variant?: "hero" | "compact";
}) {
  const [open, setOpen] = useState(false);
  // Coming back from the task's full page reopens the dialog it was opened from.
  useReturnState(`task-dialog:${detail.id}:${variant}`, open, (value) => setOpen(value === true));
  const proposal = detail.state === "awaiting_plan_approval";
  const finished = detail.state === "accepted" || detail.state === "archived";
  const step = currentStep(detail);
  const wait = today || proposal ? waitReason(detail, today ?? "") : undefined;
  const due = detail.window.dueBy;
  const distance = due && today && !finished ? dueDistance(due, today) : undefined;
  const openFrom = (event: MouseEvent | KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, [role=dialog], [popover]")) return;
    setOpen(true);
  };
  return <article className="task-card" data-variant={variant} data-line={detail.identityId} data-state={detail.state}
    tabIndex={0} aria-label={`${detail.title}，打开详情`} onClick={openFrom} onKeyDown={(event) => { if (event.key === "Enter") openFrom(event); }}>
    <header className="task-card-head">
      <span className="task-card-line"><i className="task-card-dot" aria-hidden="true" />{detail.identityLabel}{detail.projectName && <span className="task-card-project">{detail.projectName}</span>}</span>
      {due && <span className="task-card-due" data-overdue={distance?.overdue || undefined}>
        <small>截止</small> <b className="mono">{dayLabel(due)}</b>{distance && <small className="task-card-distance">{distance.text}</small>}
      </span>}
    </header>
    <h3 className="task-card-title">{detail.title}</h3>
    {variant === "hero" && detail.intent !== detail.title && <p className="task-card-description gen">{detail.intent}</p>}
    {variant === "hero" && detail.milestone && <p className="task-card-milestone">→ {detail.milestone.title}</p>}
    {reason && <p className="task-card-reason">{reason}</p>}
    <StepStrip detail={detail} />
    <CardStep detail={detail} step={step} proposal={proposal} finished={finished} waiting={wait?.kind === "input"} />
    {wait && <p className="task-card-wait" data-kind={wait.kind}>{wait.label}</p>}
    {proposal && <CompletionChoice detail={detail} />}
    {slot && <p className="task-card-slot"><small>下一次</small> <a href={`/plan?day=${slot.day}`} className="mono">{slotLabel(slot)}</a></p>}
    <Prepared detail={detail} />
    <TaskActions workOrderId={detail.id} state={detail.state} approvable={!detail.preparing} paused={detail.paused} agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id} onOpen={() => setOpen(true)}
      offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }} />
    <TaskDialog detail={detail} open={open} onOpenChange={setOpen} />
  </article>;
}

/** The step line: what the person does now (or first, on a proposal), how long it usually takes, and the first five-minute move. */
function CardStep({ detail, step, proposal, finished, waiting }: {
  detail: TaskDetail; step: ReturnType<typeof currentStep>; proposal: boolean; finished: boolean; waiting: boolean;
}) {
  if (finished) return null;
  // A proposal is shown with what the person will do first; its tutorial, when it gets one (`preparation`), is written once approved work is three days
  // from its first block (`TUTORIAL_LEAD_DAYS`, 2026-10-21), so the card says when rather than showing nothing. One without steps yet is still being prepared.
  if (!detail.stepPlan) return <p className="task-card-step-note">{proposal ? "准备中：步骤规划生成后再请本人确认。"
    : <>步骤规划中 · 全程约 <span className="mono">{formatMinutes(detail.estimate.p50Minutes)}</span></>}</p>;
  if (!step) return <p className="task-card-step-note">步骤已完成</p>;
  // A waiting step is said once, by the wait line under it.
  if (waiting) return null;
  return <div className="task-card-step">
    <p className="task-card-step-title"><small>{proposal ? "第一步" : "当前"}</small><span>{step.title}</span>
      {step.schedulable && <span className="mono task-card-minutes">约 {formatMinutes(step.estimate.p50Minutes)}</span>}</p>
    {step.firstAction && <p className="task-card-first"><small>先做</small><span className="gen">{step.firstAction}</span></p>}
    {proposal && detail.preparation?.level === "tutorial" && <p className="task-card-step-note">开工前三天会备好教程。</p>}
  </div>;
}
