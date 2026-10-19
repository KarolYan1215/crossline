"use client";

import { useEffect, useState } from "react";

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
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "accepted", note })}>批准</button>
    <label><span className="sr-only">退回原因</span><input value={note} maxLength={300} placeholder="备注或退回原因（可选）" onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`, { decision: "rejected", note })}>退回</button>
    {message && <small role="status">{message}</small>}
  </div>;
}

/**
 * The person's answer to a question a run asked mid-way: one of its options, or their own words. The run waits up to ten minutes, then
 * goes on the safest way, so the card says so.
 */
export function QuestionAnswer({ id, questions }: { id: string; questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string }> }> }) {
  const { act, busy, message } = useAct();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [own, setOwn] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(questions.map((question) => [question.id, [own[question.id]?.trim() || chosen[question.id] || ""].filter(Boolean)]));
  const ready = questions.every((question) => answers[question.id]!.length);
  return <div className="assistant-question">
    {questions.map((question) => <fieldset key={question.id}>
      <legend>{question.header ? `${question.header}：` : ""}{question.question}</legend>
      {question.options.length > 0 && <span className="assistant-actions">{question.options.map((option) =>
        <button key={option.label} type="button" className="secondary-button" aria-pressed={chosen[question.id] === option.label} title={option.description || undefined}
          onClick={() => setChosen((all) => ({ ...all, [question.id]: option.label }))}>{option.label}</button>)}</span>}
      <label><span className="sr-only">自己的回答</span><input value={own[question.id] ?? ""} maxLength={1000} placeholder={question.options.length ? "或者自己写" : "回答"}
        onChange={(event) => setOwn((all) => ({ ...all, [question.id]: event.target.value }))} /></label>
    </fieldset>)}
    <span className="assistant-actions">
      <button type="button" className="primary-button" disabled={busy || !ready} onClick={() => void act(`/api/agent/questions/${encodeURIComponent(id)}`, { answers })}>回答</button>
      {message && <small role="status">{message}</small>}
    </span>
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
  const { act, busy, message } = useAct();
  if (!available) return null;
  return <span className="assistant-actions">
    <button type="button" className="secondary-button" disabled={busy}
      onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/retry`, { only: [check] }, "未能交给助手重做，请刷新后重试。")}>让助手重做这一项</button>
    {message && <small role="status">{message}</small>}
  </span>;
}

/** 「退回让助手补上」 beside something the assistant left out or assumed: the existing send-back, with the item and an optional note. */
export function SendBackItem({ taskId, what }: { taskId: string; what: string }) {
  const { act, busy, message } = useAct();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) return <button type="button" className="text-button ar-sendback" onClick={() => setOpen(true)}>退回让助手补上</button>;
  return <span className="assistant-actions ar-sendback-form">
    <label><span className="sr-only">补充说明</span>
      <input value={note} maxLength={300} placeholder="补充说明（可选）" autoFocus onChange={(event) => setNote(event.target.value)} /></label>
    <button type="button" className="primary-button" disabled={busy} onClick={() => void act(`/api/agent/tasks/${encodeURIComponent(taskId)}/review`,
      { decision: "rejected", note: `补上：${what}${note.trim() ? `。${note.trim()}` : ""}`.slice(0, 300) })}>退回</button>
    <button type="button" className="text-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    {message && <small role="status">{message}</small>}
  </span>;
}
