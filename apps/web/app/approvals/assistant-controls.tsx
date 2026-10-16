"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";

const post = (path: string, body: Record<string, unknown>) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Posts, then reloads on success so the page shows what the ledger now says; says what went wrong otherwise. */
function useAct() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  /** `failure` is a Chinese key, said in the page's language. */
  const act = async (path: string, body: Record<string, unknown>, failure = "未完成，请刷新后重试。") => {
    setBusy(true); setMessage(t("处理中…"));
    const response = await post(path, body).catch(() => undefined);
    const result = await response?.json().catch(() => undefined) as { ok?: boolean; state?: string; blocker?: { message?: string } } | undefined;
    if (response?.ok && result?.ok !== false) { location.reload(); return; }
    setMessage(result?.blocker?.message ?? t(failure)); setBusy(false);
  };
  return { act, message, busy, t };
}

/** Yes or no to a kind of work. Yes is what lets the assistant start that kind by itself. */
export function CategoryDecision({ category, label }: { category: string; label: string }) {
  const { act, message, busy, t } = useAct();
  return <span className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "approve" })}>{t("允许「{{label}}」", { label })}</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act("/api/agent/categories", { category, decision: "decline" })}>{t("不需要")}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** The person's verdict on a result, with a note when they send it back. */
export function ReviewButtons({ taskId }: { taskId: string }) {
  const { act, busy, message, t } = useAct();
  const [note, setNote] = useState("");
  return <div className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "accepted", note })}>{t("批准")}</button>
    <label><span className="sr-only">{t("退回原因")}</span><input value={note} maxLength={300} placeholder={t("备注或退回原因（可选）")} onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "rejected", note })}>{t("退回")}</button>
    {message && <small role="status">{message}</small>}
  </div>;
}

/** An answer to a question the guard put to the person mid-run. */
export function ApprovalButtons({ id }: { id: string }) {
  const { act, busy, message, t } = useAct();
  return <span className="assistant-actions">
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/approvals/${encodeURIComponent(id)}`, { decision: "accepted" })}>{t("允许本次")}</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/approvals/${encodeURIComponent(id)}`, { decision: "declined" })}>{t("拒绝")}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}


/**
 * Whether the assistant can redo part of a result (`POST /api/agent/tasks/<id>/retry`). Asked once per page: a route that does not exist
 * answers 404 to any method, one that exists answers something else, so the button appears only where the action is real.
 */
let retryRoute: Promise<boolean> | undefined;
function useRetryAvailable(taskId: string) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    retryRoute ??= fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/retry`, { method: "HEAD" })
      .then((response) => response.status !== 404).catch(() => false);
    let live = true;
    void retryRoute.then((value) => { if (live) setAvailable(value); });
    return () => { live = false; };
  }, [taskId]);
  return available;
}

/** 「让助手重做这一项」 for one self-check that did not pass. */
export function RetryCheckButton({ taskId, check }: { taskId: string; check: string }) {
  const available = useRetryAvailable(taskId);
  const { act, busy, message, t } = useAct();
  if (!available) return null;
  return <span className="assistant-actions">
    <button type="button" className="secondary-button" disabled={busy}
      onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/retry`, { only: [check] }, "未能交给助手重做，请刷新后重试。")}>{t("让助手重做这一项")}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** 「退回让助手补上」 beside something the assistant left out or assumed: the existing send-back, with the item and an optional note. */
export function SendBackItem({ taskId, what }: { taskId: string; what: string }) {
  const { act, busy, message, t } = useAct();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) return <button type="button" className="text-button ar-sendback" onClick={() => setOpen(true)}>{t("退回让助手补上")}</button>;
  // The note goes to the assistant's next run and into the record, in the language the person reads.
  const sent = note.trim() ? t("补上：{{what}}。{{note}}", { what, note: note.trim() }) : t("补上：{{what}}", { what });
  return <span className="assistant-actions ar-sendback-form">
    <label><span className="sr-only">{t("补充说明")}</span>
      <input value={note} maxLength={300} placeholder={t("补充说明（可选）")} autoFocus onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`,
      { decision: "rejected", note: sent.slice(0, 300) })}>{t("退回")}</button>
    <button type="button" className="text-button" disabled={busy} onClick={() => setOpen(false)}>{t("取消")}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}
