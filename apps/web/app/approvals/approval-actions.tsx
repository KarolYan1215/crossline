"use client";

import { useState } from "react";

const post = async (path: string, body?: Record<string, unknown>) => fetch(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {})
});

export function AcceptEvidenceButton({ workOrderId }: { workOrderId: string }) {
  const [state, setState] = useState("验收证据");
  const [reason, setReason] = useState("");
  const decide = async (body: Record<string, unknown>) => {
    setState("处理中…");
    const response = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/accept`, body);
    if (!response.ok) { setState("状态已变化，请刷新"); return; }
    location.reload();
  };
  return <div className="execution-actions">
    <button className="primary-button" type="button" onClick={() => void decide({ decision: "accept" })}>{state}</button>
    <label><span className="sr-only">退回原因</span>
      <input value={reason} maxLength={200} placeholder="退回原因（必填）" onChange={(event) => setReason(event.target.value)} /></label>
    <button type="button" onClick={() => void decide({ decision: "block", reason })}>退回并阻塞</button>
  </div>;
}

export function ApproveProposalButton({ workOrderId }: { workOrderId: string }) {
  const [state, setState] = useState("批准该提案");
  return <button className="primary-button" type="button" onClick={async () => {
    setState("批准中…");
    const response = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/approve`);
    if (!response.ok) { setState("状态已变化，请刷新"); return; }
    location.reload();
  }}>{state}</button>;
}

/**
 * Runs the milestone gate now rather than at the next tick.
 *
 * Submitting evidence and then reading 「等待里程碑闸门」 for fifteen minutes is indistinguishable from
 * a gate that already failed and gave up, so the wait needed a way to be ended on purpose.
 */
export function JudgeMilestoneButton({ workOrderId }: { workOrderId: string }) {
  const [state, setState] = useState("现在判定");
  return <div className="execution-actions">
    <button type="button" onClick={async () => {
      setState("判定中…约一两分钟");
      const response = await post(`/api/work-orders/${encodeURIComponent(workOrderId)}/milestone-gate`);
      setState(response.ok ? "已开始判定；判完后刷新本页" : "现在无法判定，请刷新");
    }}>{state}</button>
  </div>;
}
