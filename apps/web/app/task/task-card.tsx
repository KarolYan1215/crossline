"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { CalendarClock, CalendarDays, Check, Flag, Pencil, Sparkles } from "lucide-react";
import type { TaskDetail } from "../../lib/task-detail";
import { useReturnState } from "../ui/return-state";
import { ICON, IconButton } from "../ui/icon-button";
import { useLocale, useT } from "../locale-context";
import type { Locale } from "../../lib/i18n";
import { dayText, minutesText } from "./format";
import { currentStep, dueDistance, hoursShort, remainingMinutes, waitReason } from "./card-model";
import { CompletionChoice } from "./completion-choice";
import { preparedFiles } from "./prepared";
import { PostponePanel } from "./postpone";
import { RunningChip } from "./running-chip";
import { TaskQuickEdit } from "./quick-edit";
import { StepStrip } from "./step-strip";
import { TaskActions } from "./task-actions";
import { COMPLETABLE, TaskCompletionSheet } from "./task-completion";
import { TaskDialog } from "./task-dialog";

export type TaskSlot = { day: string; start: string; end: string };
const slotLabel = (locale: Locale, slot: TaskSlot) => `${dayText(locale, slot.day)} ${slot.start}–${slot.end}`;
const SMALL = { ...ICON, size: 14 } as const;

/**
 * The one task card, used on Today, Tasks, Approvals and the weekly review (redesigned 2026-10-15, then 2026-10-28 after the page drafts).
 * It answers, in reading order: which line and which milestone it serves, when it is due, which task, how far along (the step picture),
 * what to do now (the current step and its first five-minute move), what it waits for if anything, then one row of chips — the next
 * block or the running timer, what is left, what is ready — and one row of actions: the primary press with its words, then icons for
 * 完成, 交给助手, 推迟, 改截止或时长, 打开 and more. The description, risk, cross-line support and the rest are in the task dialog the
 * whole card opens. `reason` is Today's own wording for the recommendation; `today` lets the due day say how far off it is.
 */
export function TaskCard({ detail, slot, reason, today, variant = "compact" }: {
  detail: TaskDetail; slot?: TaskSlot | undefined; reason?: string; today?: string | undefined; variant?: "hero" | "compact";
}) {
  const [open, setOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [tool, setTool] = useState<"postpone" | "edit" | null>(null);
  const t = useT(), locale = useLocale();
  // Coming back from the task's full page reopens the dialog it was opened from.
  useReturnState(`task-dialog:${detail.id}:${variant}`, open, (value) => setOpen(value === true));
  const proposal = detail.state === "awaiting_plan_approval";
  const finished = detail.state === "accepted" || detail.state === "archived";
  const live = !finished && detail.state !== "evidence_review";
  const step = currentStep(detail);
  const wait = today || proposal ? waitReason(detail, today ?? "", locale) : undefined;
  const due = detail.window.dueBy;
  const distance = due && today && !finished ? dueDistance(due, today, locale) : undefined;
  const left = remainingMinutes(detail);
  const ready = preparedFiles(detail);
  const tutorial = detail.preparedMaterials.some((item) => /manual\.md$/.test(item.uri));
  const readyCount = ready.length + (tutorial ? 1 : 0);
  const openFrom = (event: MouseEvent | KeyboardEvent) => {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, label, [role=dialog], [popover], .task-card-tools")) return;
    setOpen(true);
  };
  const toggle = (next: "postpone" | "edit") => setTool((current) => current === next ? null : next);
  return <article className="task-card" data-variant={variant} data-line={detail.identityId} data-state={detail.state}
    tabIndex={0} aria-label={t("{{title}}，打开详情", { title: detail.title })} onClick={openFrom} onKeyDown={(event) => { if (event.key === "Enter") openFrom(event); }}>
    <header className="task-card-head">
      <span className="task-card-line"><span className="task-card-chipline"><i className="task-card-dot" aria-hidden="true" />{detail.identityLabel}</span>
        {detail.projectName && <span className="task-card-project">{detail.projectName}</span>}
        {detail.milestone && variant !== "hero" && <span className="task-card-serves" title={detail.milestone.title}>→ {detail.milestone.title}</span>}</span>
      {due && <span className="task-card-due" data-overdue={distance?.overdue || undefined} title={t("截止")}>
        <Flag {...SMALL} /><small className="sr-only">{t("截止")}</small> <b className="mono">{dayText(locale, due)}</b>{distance && <small className="task-card-distance">{distance.text}</small>}
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
    {!finished && <p className="task-card-chips">
      {detail.state === "active" ? <RunningChip detail={detail} />
        : slot && <a className="task-chip" href={`/plan?day=${slot.day}`} title={t("下一次")}><CalendarDays {...SMALL} /><span className="sr-only">{t("下一次")}</span><span className="mono">{slotLabel(locale, slot)}</span></a>}
      {left.p50 > 0 && <span className="task-chip" title={t("剩余约 {{duration}}，保守 {{cautious}}", { duration: minutesText(locale, left.p50), cautious: minutesText(locale, left.p85) })}>
        {t("剩 {{hours}}", { hours: hoursShort(left.p50, locale) })}</span>}
      {readyCount > 0 && <a className="task-chip" data-tone="ready" href={`/workbench/${encodeURIComponent(detail.id)}#materials`}
        title={[...(tutorial ? [t("教程")] : []), ...ready.map((file) => file.name)].join("\n")}><Sparkles {...SMALL} />{t("已备好 {{count}}", { count: readyCount })}</a>}
    </p>}
    <div className="task-card-tools">
      <TaskActions iconic labelPrimary workOrderId={detail.id} state={detail.state} approvable={!detail.preparing} paused={detail.paused}
        agentReady={detail.agentSteps.length > 0} agentStepId={detail.agentSteps[0]?.id} onOpen={() => setOpen(true)}
        offline={{ ownerId: detail.viewerId, workspaceId: detail.workspaceId, intent: detail.intent }}>
        {COMPLETABLE.includes(detail.state) && (detail.state === "active"
          ? <button type="button" className="primary-button task-actions-main" onClick={() => setCompleting(true)}><Check {...ICON} /><span>{t("完成")}</span></button>
          : <IconButton label={t("完成并提交材料")} icon={<Check {...ICON} />} onClick={() => setCompleting(true)} />)}
        {live && !proposal && <IconButton label={t("推迟")} icon={<CalendarClock {...ICON} />} aria-expanded={tool === "postpone"} onClick={() => toggle("postpone")} />}
        {live && <IconButton label={t("改截止或时长")} icon={<Pencil {...ICON} />} aria-expanded={tool === "edit"} onClick={() => toggle("edit")} />}
      </TaskActions>
      {tool === "postpone" && <PostponePanel workOrderId={detail.id} onClose={() => setTool(null)} />}
      {tool === "edit" && <TaskQuickEdit workOrderId={detail.id} dueBy={detail.window.dueBy} samples={detail.estimate.observationCount} line={detail.identityId}
        estimate={step?.estimate ?? detail.estimate} stepId={step?.id} durationLabel={step ? t("本步时长") : t("时长")} />}
    </div>
    <TaskDialog detail={detail} slot={slot} today={today} open={open} onOpenChange={setOpen} />
    {completing && <TaskCompletionSheet task={detail} stepId={step?.id} open={completing} onOpenChange={setCompleting} />}
  </article>;
}

/** The step line: what the person does now (or first, on a proposal), how long it usually takes, and the first five-minute move. */
function CardStep({ detail, step, proposal, finished, waiting }: {
  detail: TaskDetail; step: ReturnType<typeof currentStep>; proposal: boolean; finished: boolean; waiting: boolean;
}) {
  const t = useT(), locale = useLocale();
  if (finished) return null;
  // A proposal is shown with what the person will do first; its tutorial, when it gets one (`preparation`), is written once approved work is three days
  // from its first block (`TUTORIAL_LEAD_DAYS`, 2026-10-21), so the card says when rather than showing nothing. One without steps yet is still being prepared.
  if (!detail.stepPlan) return <p className="task-card-step-note">{proposal ? t("准备中：步骤规划生成后再请本人确认。")
    : <>{t("步骤规划中 · 全程约")} <span className="mono">{minutesText(locale, detail.estimate.p50Minutes)}</span></>}</p>;
  if (!step) return <p className="task-card-step-note">{t("步骤已完成")}</p>;
  // A waiting step is said once, by the wait line under it.
  if (waiting) return null;
  return <div className="task-card-step">
    <p className="task-card-step-title"><small>{t(proposal ? "第一步" : "当前")}</small><span>{step.title}</span>
      {step.schedulable && <span className="mono task-card-minutes">{t("约 {{duration}}", { duration: minutesText(locale, step.estimate.p50Minutes) })}</span>}</p>
    {step.firstAction && <p className="task-card-first"><small>{t("先做")}</small><span className="gen">{step.firstAction}</span></p>}
    {proposal && detail.preparation?.level === "tutorial" && <p className="task-card-step-note">{t("开工前三天会备好教程。")}</p>}
  </div>;
}
