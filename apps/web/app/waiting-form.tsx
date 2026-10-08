"use client";

import { useState } from "react";

/** 「在等别人？」: makes a waiting item for this task, so it is not scheduled before what it needs can have arrived. */
export function WaitingForm({ workOrderId }: { workOrderId: string }) {
  const [who, setWho] = useState("");
  const [what, setWhat] = useState("");
  const [date, setDate] = useState("");
  const [approximate, setApproximate] = useState(true);
  const [status, setStatus] = useState("");
  return <details className="fold"><summary>在等别人给东西？</summary>
    <div className="execution-actions">
      <label>谁 <input value={who} maxLength={60} placeholder="例如：师兄" onChange={(event) => setWho(event.target.value)} /></label>
      <label>等什么 <input value={what} maxLength={200} placeholder="例如：真实测量数据" onChange={(event) => setWhat(event.target.value)} /></label>
      <label>预计哪天 <input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label><input type="checkbox" checked={approximate} onChange={(event) => setApproximate(event.target.checked)} /> 大约</label>
      <button type="button" disabled={!what.trim() || !date} onClick={async () => {
        const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/waiting`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ who, what, expectedAt: date, approximate }) }).catch(() => null);
        if (response?.ok) { location.reload(); return; }
        setStatus("没保存上，请检查日期");
      }}>记下来</button>
    </div>
    <small className="muted">记录后，该任务在此日期前不排入日历；到期时确认是否到达。</small>
    {status && <small role="status">{status}</small>}
  </details>;
}
