"use client";

import { DateChip, DurationBar, STEP_MINUTES, TASK_MINUTES } from "../ui/controls";
import { ImpactCard, useImpact } from "./impact";

/**
 * The two numbers a person changes most, edited where they are shown: the due date and the usual duration. Either change is previewed
 * across the lines before it is applied. `durationLabel` says whose duration it is (本步 on a card, 剩余合计 in the dialog, where the
 * total is the sum of the open steps and each step is edited on its own row).
 */
export function TaskQuickEdit({ workOrderId, dueBy, estimate, samples, stepId, line, editable = true, durationEditable = editable, durationLabel = "时长" }: {
  workOrderId: string; dueBy?: string | undefined; estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  samples: number; stepId?: string | undefined; line: string; editable?: boolean; durationEditable?: boolean; durationLabel?: string;
}) {
  const impact = useImpact();
  return <div className="task-quick-edit" data-line={line}>
    <span className="task-quick-due"><small>截止</small>
      {editable ? <DateChip label="截止日期" value={dueBy} onChange={(date) => void impact.propose({ kind: "due", workOrderId, date })} />
        : <span className="mono">{dueBy ?? "未定"}</span>}</span>
    <span className="task-quick-duration"><small>{durationLabel}</small>
      <DurationBar p25={estimate.p25Minutes} p50={estimate.p50Minutes} p85={estimate.p85Minutes} samples={samples} label={durationLabel}
        bounds={stepId ? STEP_MINUTES : TASK_MINUTES}
        {...(durationEditable ? { onCommit: (p50Minutes: number) => void impact.propose({ kind: "estimate", workOrderId, p50Minutes, ...(stepId ? { stepId } : {}) }) } : {})} /></span>
    {impact.busy && !impact.pending && <small role="status">计算影响…</small>}
    {impact.error && <small role="status">{impact.error}</small>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
  </div>;
}

/** One step's own duration, dragged on its row in the dialog. */
export function StepDuration({ workOrderId, stepId, estimate }: { workOrderId: string; stepId: string; estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number } }) {
  const impact = useImpact();
  return <span className="step-duration">
    <DurationBar p25={estimate.p25Minutes} p50={estimate.p50Minutes} p85={estimate.p85Minutes} label="步骤时长" bounds={STEP_MINUTES}
      onCommit={(p50Minutes) => void impact.propose({ kind: "estimate", workOrderId, stepId, p50Minutes })} />
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
  </span>;
}
