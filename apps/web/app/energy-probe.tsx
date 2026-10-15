"use client";

import { useState } from "react";

export function EnergyProbe({ context = "general", workOrderId }: {
  context?: "general" | "before_task" | "after_task" | "after_rest" | "correction"; workOrderId?: string
}) {
  const [status, setStatus] = useState<"idle" | "sampling" | "error">("idle");
  const [actualLoad, setActualLoad] = useState<"" | "low" | "medium" | "high">("");
  const [shownAt] = useState(() => Date.now());

  const saveSelfReport = async (level: "low" | "medium" | "high") => {
    // Measured, not nominal: how long this answer actually took.
    const responseSeconds = Math.round((Date.now() - shownAt) / 1000);
    setStatus("sampling");
    const response = await fetch("/api/energy-observations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "self_report", level, confidence: "high", aggregate: { responseSeconds },
        context, ...(workOrderId ? { workOrderId } : {}),
        ...(context === "after_task" && actualLoad ? { actualLoad } : {}) })
    });
    if (response.ok) { location.reload(); return; }
    setStatus("error");
  };

  if (status === "sampling") return <span className="energy-probe-state">采样中…</span>;
  return <span className="energy-probe">
    {context === "after_task" && <label>这件事累不累 <select value={actualLoad}
      onChange={(event) => setActualLoad(event.target.value as typeof actualLoad)}>
      <option value="">跳过</option><option value="low">低</option>
      <option value="medium">中</option><option value="high">高</option>
    </select></label>}
    {/* 「L M H」 alone read as nothing to an invitee (2026-10-15 walkthrough): the buttons say what they record. */}
    {context === "after_task" && <span>此刻精力</span>}
    <button type="button" aria-label="记录低精力" onClick={() => saveSelfReport("low")}>低</button>
    <button type="button" aria-label="记录中精力" onClick={() => saveSelfReport("medium")}>中</button>
    <button type="button" aria-label="记录高精力" onClick={() => saveSelfReport("high")}>高</button>
    {status === "error" && <em>不可用</em>}
  </span>;
}
