"use client";

import { useState } from "react";
import { SegmentedControl } from "./ui/controls";

/** A waiting item recorded by hand for this task, so it is not scheduled before what it needs can have arrived. */
export function WaitingForm({ workOrderId }: { workOrderId: string }) {
  const [who, setWho] = useState("");
  const [what, setWhat] = useState("");
  const [date, setDate] = useState("");
  const [approximate, setApproximate] = useState<"approximate" | "exact">("approximate");
  const [status, setStatus] = useState("");
  return <section className="waiting-form" aria-label="等待他人提供">
    <h4>等待他人提供</h4>
    <div className="execution-actions">
      <label>提供方 <input value={who} maxLength={60} placeholder="例如：师兄" onChange={(event) => setWho(event.target.value)} /></label>
      <label>内容 <input value={what} maxLength={200} placeholder="例如：真实测量数据" onChange={(event) => setWhat(event.target.value)} /></label>
      <label>预计日期 <input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <SegmentedControl label="日期精度" value={approximate} onChange={setApproximate}
        options={[{ value: "approximate", label: "大约" }, { value: "exact", label: "确定" }]} />
      <button type="button" disabled={!what.trim() || !date} onClick={async () => {
        const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/waiting`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ who, what, expectedAt: date, approximate: approximate === "approximate" }) }).catch(() => null);
        if (response?.ok) { location.reload(); return; }
        setStatus("未保存，请检查日期");
      }}>记录</button>
    </div>
    <small className="muted">记录后，该任务在此日期前不排入日历；到期时确认是否到达。</small>
    {status && <small role="status">{status}</small>}
  </section>;
}
