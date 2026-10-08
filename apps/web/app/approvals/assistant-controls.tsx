"use client";

import { useState } from "react";

const post = (path: string, body: Record<string, unknown>) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Posts, then reloads on success so the page shows what the ledger now says; says what went wrong otherwise. */
function useAct() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: Record<string, unknown>, failure = "未完成，请刷新后重试。") => {
    setBusy(true); setMessage("处理中…");
    const response = await post(path, body).catch(() => undefined);
    const result = await response?.json().catch(() => undefined) as { ok?: boolean; state?: string; blocker?: { message?: string } } | undefined;
    if (response?.ok && result?.ok !== false) { location.reload(); return; }
    setMessage(result?.blocker?.message ?? failure); setBusy(false);
  };
  return { act, message, busy };
}

/** Yes or no to a kind of work. Yes is what lets the assistant start that kind by itself. */
export function CategoryDecision({ category, label }: { category: string; label: string }) {
  const { act, message, busy } = useAct();
  return <span className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "approve" })}>允许「{label}」</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "decline" })}>不需要</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** The person's verdict on a result, with a note when they send it back. */
export function ReviewButtons({ taskId }: { taskId: string }) {
  const { act, busy, message } = useAct();
  const [note, setNote] = useState("");
  return <div className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "accepted", note })}>采纳</button>
    <label><span className="sr-only">退回原因</span><input value={note} maxLength={300} placeholder="备注或退回原因（可选）" onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "rejected", note })}>退回</button>
    {message && <small role="status">{message}</small>}
  </div>;
}

/** An answer to a question the guard put to the person mid-run. */
export function ApprovalButtons({ id }: { id: string }) {
  const { act, busy, message } = useAct();
  return <span className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/approvals/${encodeURIComponent(id)}`, { decision: "accepted" })}>允许本次</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/approvals/${encodeURIComponent(id)}`, { decision: "declined" })}>拒绝</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

