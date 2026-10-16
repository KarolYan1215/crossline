"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";

type Reason = "waiting" | "energy" | "conflict" | "time" | "other";
const REASONS: Array<{ value: Reason; label: string; hint: string }> = [
  { value: "waiting", label: "等待他人提供", hint: "记录为等待项；到达之前不排入日历，到期时确认是否到达。" },
  { value: "energy", label: "精力不足", hint: "记录此刻精力为低，并记住该时段精力偏低；任务移到所选日期。" },
  { value: "conflict", label: "与其他事项冲突", hint: "任务移到所选日期，其余排程随之重排。" },
  { value: "time", label: "时间不够", hint: "任务移到所选日期。" },
  { value: "other", label: "其他", hint: "按填写的原因处理。" }
];

const tomorrow = () => { const day = new Date(); day.setDate(day.getDate() + 1); return day.toLocaleDateString("en-CA"); };

/**
 * 推迟 asks why, because the reason decides what else changes: waiting for someone opens a waiting item, low energy is recorded with
 * the moment it happened, a clash or no time moves the start. A reason in other words goes to the task's assistant on the server.
 */
export function PostponePanel({ workOrderId, onClose }: { workOrderId: string; onClose: () => void }) {
  const [reason, setReason] = useState<Reason>("waiting");
  const [date, setDate] = useState(tomorrow());
  const [who, setWho] = useState("");
  const [what, setWhat] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const t = useT();
  const submit = async () => {
    setBusy(true); setStatus("");
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/postpone`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, date, who, what, text }) }).catch(() => null);
    if (response?.ok) { location.reload(); return; }
    const body = await response?.json().catch(() => null) as { code?: string } | null;
    setBusy(false);
    setStatus(t(body?.code === "POSTPONE_WHAT_REQUIRED" ? "请填写等待的内容" : body?.code === "INVALID_WAITING_INPUT" ? "等待内容或日期不完整" : "未能推迟，请重试"));
  };
  return <section className="postpone" aria-label={t("推迟")}>
    <SegmentedControl label={t("推迟原因")} value={reason} onChange={setReason} options={REASONS.map(({ value, label }) => ({ value, label: t(label) }))} />
    <small className="muted">{t(REASONS.find((item) => item.value === reason)!.hint)}</small>
    <div className="postpone-fields">
      {reason === "waiting" && <>
        <label>{t("提供方")} <input value={who} maxLength={60} placeholder={t("例如：师兄")} onChange={(event) => setWho(event.target.value)} /></label>
        <label>{t("内容")} <input value={what} maxLength={200} placeholder={t("例如：真实测量数据")} onChange={(event) => setWhat(event.target.value)} /></label>
      </>}
      <label>{t(reason === "waiting" ? "预计到达" : "推迟到")} <input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      {reason !== "waiting" && <label className="postpone-text">{t(reason === "other" ? "说明" : "说明（选填）")} <input value={text} maxLength={500}
        placeholder={t(reason === "energy" ? "例如：熬夜后注意力差" : reason === "conflict" ? "例如：临时组会" : "原因")} onChange={(event) => setText(event.target.value)} /></label>}
    </div>
    <div className="postpone-actions">
      <button type="button" className="primary-button" disabled={busy || (reason === "other" && !text.trim())} onClick={() => void submit()}>{t("推迟")}</button>
      <button type="button" onClick={onClose}>{t("取消")}</button>
      {status && <small role="status">{status}</small>}
    </div>
  </section>;
}
