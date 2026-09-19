"use client";

import { useState } from "react";
import type { GoalSettings } from "../../lib/crossline";

export function GoalControls({ id, settings, fallbackImportance, dateCandidates = [] }: {
  id: string; settings: GoalSettings | null; fallbackImportance: "important" | "ordinary";
  dateCandidates?: Array<{ date: string; quote: string }>
}) {
  const [importance, setImportance] = useState(settings?.importance ?? fallbackImportance);
  const [deadline, setDeadline] = useState(settings?.confirmedDeadline ?? "");
  const [quote, setQuote] = useState(settings?.sourceQuote ?? "");
  const [message, setMessage] = useState("");
  const [backplanMessage, setBackplanMessage] = useState("");
  const [candidateDates, setCandidateDates] = useState(dateCandidates);
  return <><form className="goal-controls" onSubmit={async (event) => {
    event.preventDefault();
    setMessage("保存中…");
    const response = await fetch(`/api/goals/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ importance, confirmedDeadline: deadline || null, sourceQuote: quote })
    }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    setMessage("未保存，请核对日期后重试。");
  }}>
    <label>目标重要性<select value={importance} onChange={(event) => setImportance(event.target.value as typeof importance)}>
      <option value="important">重要</option><option value="ordinary">普通</option>
    </select></label>
    <label>确认截止日期<input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} /></label>
    {candidateDates.map((candidate) => <button key={`${candidate.date}:${candidate.quote}`} type="button"
      onClick={() => { setDeadline(candidate.date); setQuote(candidate.quote); }}>
      AI 提取 {candidate.date} · 原文「{candidate.quote}」；点此填入，再确认保存
    </button>)}
    <label>日期原文依据（可选）<input value={quote} maxLength={500} placeholder="粘贴原文；AI 提取的日期须保留引文" onChange={(event) => setQuote(event.target.value)} /></label>
    <button type="submit">确认目标约束</button>
    <small>{deadline ? "这个日期会成为排程硬约束。" : "无确认日期；预测日仍是可编辑的情景。"}</small>
    {message && <span role="status">{message}</span>}
  </form><div className="goal-backplan">
    <button type="button" onClick={async () => {
      setBackplanMessage("AI 正在反推步骤，可能需要几分钟…");
      const response = await fetch(`/api/goals/${encodeURIComponent(id)}/backplan`, { method: "POST" }).catch(() => undefined);
      const result = await response?.json().catch(() => undefined) as { state?: string; workOrderIds?: string[];
        dateCandidates?: Array<{ date: string; quote: string }>;
        message?: string; blocker?: { message?: string } } | undefined;
      if (response?.ok && result?.state === "proposed") {
        setCandidateDates(result.dateCandidates ?? []);
        setBackplanMessage(`已提出 ${result.workOrderIds?.length ?? 0} 个步骤草案，等待作业审批。`);
      } else setBackplanMessage(result?.message ?? result?.blocker?.message ?? "反推未完成。");
    }}>从此目标反推步骤</button>
    {backplanMessage && <span role="status">{backplanMessage}</span>}
  </div></>;
}
