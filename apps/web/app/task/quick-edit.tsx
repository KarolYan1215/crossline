"use client";

import { DateChip, DurationBar } from "../ui/controls";
import { useLocale, useT } from "../locale-context";
import { dayText } from "./format";
import { ImpactCard, useImpact } from "./impact";

/**
 * The two numbers a person changes most, edited where they are shown: the due date and the usual duration. Either change is previewed
 * across the lines before it is applied. `durationLabel` says whose duration it is (本步 on a card, 剩余合计 in the dialog, where the
 * total is the sum of the open steps and each step is edited on its own row).
 */
export function TaskQuickEdit({ workOrderId, dueBy, estimate, samples, stepId, line, editable = true, durationEditable = editable, durationLabel }: {
  workOrderId: string; dueBy?: string | undefined; estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  samples: number; stepId?: string | undefined; line: string; editable?: boolean; durationEditable?: boolean; durationLabel?: string;
}) {
  const impact = useImpact();
  const t = useT(), locale = useLocale();
  const label = durationLabel ?? t("时长");
  return <div className="task-quick-edit" data-line={line}>
    <span className="task-quick-due"><small>{t("截止")}</small>
      {editable ? <DateChip label={t("截止日期")} value={dueBy} onChange={(date) => void impact.propose({ kind: "due", workOrderId, date })} />
        : <span className="mono">{dueBy ? dayText(locale, dueBy) : t("未定")}</span>}</span>
    <span className="task-quick-duration"><small>{label}</small>
      <DurationBar p25={estimate.p25Minutes} p50={estimate.p50Minutes} p85={estimate.p85Minutes} samples={samples} label={label}
        {...(durationEditable ? { onCommit: (p50Minutes: number) => void impact.propose({ kind: "estimate", workOrderId, p50Minutes, ...(stepId ? { stepId } : {}) }) } : {})} /></span>
    {impact.busy && !impact.pending && <small role="status">{t("计算影响…")}</small>}
    {impact.error && <small role="status">{impact.error}</small>}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
  </div>;
}

/** One step's own duration, dragged on its row in the dialog. */
export function StepDuration({ workOrderId, stepId, estimate }: { workOrderId: string; stepId: string; estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number } }) {
  const impact = useImpact();
  const t = useT();
  return <span className="step-duration">
    <DurationBar p25={estimate.p25Minutes} p50={estimate.p50Minutes} p85={estimate.p85Minutes} label={t("步骤时长")}
      onCommit={(p50Minutes) => void impact.propose({ kind: "estimate", workOrderId, stepId, p50Minutes })} />
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
  </span>;
}
