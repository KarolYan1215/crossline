"use client";

import { useState } from "react";
import { AGENT_CATEGORIES } from "@crossline/core";

const post = (path: string, body: Record<string, unknown>) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Posts, then reloads on success so the page shows what the ledger now says; says what went wrong otherwise. */
function useAct() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (path: string, body: Record<string, unknown>, failure = "没有成功，请刷新后重试。") => {
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
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "approve" })}>同意助手做「{label}」</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "decline" })}>不用，这类我自己做</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** Takes a kind back: the assistant stops starting it, and a task of that kind is asked about again. */
export function CategoryRevoke({ category, label }: { category: string; label: string }) {
  const { act, busy } = useAct();
  return <button type="button" className="secondary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "decline" })}>不再让助手做「{label}」</button>;
}

export function PauseSwitch({ paused }: { paused: boolean }) {
  const { act, busy, message } = useAct();
  return <span className="assistant-actions">
    <button type="button" className={paused ? "primary-button" : "secondary-button"} disabled={busy} onClick={() => void act("/api/agent/pause", { paused: !paused })}>
      {paused ? "恢复助手自动开工" : "暂停助手自动开工"}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** The person's verdict on a result, with a note when they send it back. */
export function ReviewButtons({ taskId }: { taskId: string }) {
  const { act, busy, message } = useAct();
  const [note, setNote] = useState("");
  return <div className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "accepted", note })}>采纳这份产出</button>
    <label><span className="sr-only">退回原因</span><input value={note} maxLength={300} placeholder="备注或退回原因（可不填）" onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "rejected", note })}>退回</button>
    {message && <small role="status">{message}</small>}
  </div>;
}

/** An answer to a question the guard put to the person mid-run. */
export function ApprovalButtons({ id }: { id: string }) {
  const { act, busy, message } = useAct();
  return <span className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/approvals/${encodeURIComponent(id)}`, { decision: "accepted" })}>同意这一次</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/approvals/${encodeURIComponent(id)}`, { decision: "declined" })}>不同意</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** 交给助手, on a work order. A kind of work that is not yet allowed is asked about on the Assistant page; nothing starts until it is. */
export function HandOver({ workOrderId, category, categoryLabel }: { workOrderId: string; category: string; categoryLabel: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState(category);
  const go = async () => {
    setBusy(true); setMessage("正在交给助手…");
    const response = await post("/api/agent/dispatch", { workOrderId, ...(choice ? { category: choice } : {}) }).catch(() => undefined);
    const result = await response?.json().catch(() => undefined) as { state?: string; label?: string; blocker?: { message?: string }; message?: string; taskId?: string } | undefined;
    if (result?.state === "started") { setMessage("助手开始做了。进度和产出在「助手」页。"); setBusy(false); return; }
    if (result?.state === "needs_category_approval") { setMessage(`助手还没获准做「${result.label}」这类工作；已在「助手」页向你请求同意。`); setBusy(false); return; }
    setMessage(result?.message ?? result?.blocker?.message ?? "没能交给助手。"); setBusy(false);
  };
  return <span className="assistant-actions">
    {!category && <label>这件事属于<select value={choice} onChange={(event) => setChoice(event.target.value)}>
      <option value="">选一类…</option>
      {Object.entries(AGENT_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>}
    <button type="button" className="primary-button" disabled={busy || !choice} onClick={() => void go()}>交给助手{category ? `（${categoryLabel}）` : ""}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}
