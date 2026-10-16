"use client";

import { useState, type ReactNode } from "react";
import { useT } from "../locale-context";

/** A button's words kept as the Chinese key (and its values), translated when drawn, so a language switch never strands a stored label. */
type Label = { key: string; values?: Record<string, unknown> };
const label = (key: string, values?: Record<string, unknown>): Label => values ? { key, values } : { key };

const post = async (path: string, body?: Record<string, unknown>) => fetch(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {})
});

export function AcceptEvidenceButton({ workOrderId }: { workOrderId: string }) {
  const t = useT();
  const [state, setState] = useState("验收证据");
  const [reason, setReason] = useState("");
  const decide = async (body: Record<string, unknown>) => {
    setState("处理中…");
    const response = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/accept`, body);
    if (!response.ok) { setState("状态已变化，请刷新"); return; }
    location.reload();
  };
  return <div className="execution-actions">
    <button className="primary-button" type="button" onClick={() => void decide({ decision: "accept" })}>{t(state)}</button>
    <label><span className="sr-only">{t("退回原因")}</span>
      <input value={reason} maxLength={200} placeholder={t("退回原因（必填）")} onChange={(event) => setReason(event.target.value)} /></label>
    <button type="button" onClick={() => void decide({ decision: "block", reason })}>{t("退回并阻塞")}</button>
  </div>;
}

/**
 * Runs the milestone gate now rather than at the next tick.
 *
 * Submitting evidence and then reading 「等待里程碑闸门」 for fifteen minutes is indistinguishable from
 * a gate that already failed and gave up, so the wait needed a way to be ended on purpose.
 */
export function JudgeMilestoneButton({ workOrderId }: { workOrderId: string }) {
  const t = useT();
  const [state, setState] = useState("现在判定");
  return <div className="execution-actions">
    <button type="button" onClick={async () => {
      setState("判定中…约一两分钟");
      const response = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/milestone-gate`);
      setState(response.ok ? "已开始判定；判完后刷新本页" : "现在无法判定，请刷新");
    }}>{t(state)}</button>
  </div>;
}

/**
 * 「全部批准」 over the proposal cards below it. Each card carries a checkbox (ticked by default); the
 * button approves the ticked ones in one request and reports any that changed underneath instead of
 * failing all of them.
 */
export function ProposalBatchForm({ children, count }: { children: ReactNode; count: number }) {
  const t = useT();
  const [state, setState] = useState<Label>(label("批准勾选的方案"));
  return <form className="proposal-batch" onSubmit={async (event) => {
    event.preventDefault();
    const ids = new FormData(event.currentTarget).getAll("proposal").map(String);
    if (!ids.length) { setState(label("先勾选要批准的方案")); return; }
    setState(label("批准中…"));
    const response = await post("/api/work-orders/approve-batch", { ids });
    const result = await response.json().catch(() => null) as { approved?: string[]; skipped?: unknown[] } | null;
    if (!response.ok || !result) { setState(label("没有批准成功，请刷新")); return; }
    if (result.skipped?.length) { setState(label("已批准 {{approved}} 个；{{skipped}} 个已变化，刷新后再看", { approved: result.approved?.length ?? 0, skipped: result.skipped.length })); return; }
    location.reload();
  }}>
    <div className="proposal-batch-bar">
      <span>{t("{{count}} 个任务提案待批准", { count })}</span>
      <button className="primary-button" type="submit">{t(state.key, state.values)}</button>
    </div>
    {children}
  </form>;
}

/** One-click undo for something that took effect without a click. */
export function RevokeAutoApprovalButton({ workOrderId }: { workOrderId: string }) {
  const t = useT();
  const [state, setState] = useState("撤销");
  return <button type="button" onClick={async () => {
    setState("撤销中…");
    const response = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/revoke-auto-approval`);
    if (!response.ok) { setState("已开始做，不能撤销"); return; }
    location.reload();
  }}>{t(state)}</button>;
}
