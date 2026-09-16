"use client";

import { useState } from "react";

export function EnergyProbe() {
  const [status, setStatus] = useState<"idle" | "sampling" | "saved" | "error">("idle");
  const [shownAt] = useState(() => Date.now());

  const saveSelfReport = async (level: "low" | "medium" | "high") => {
    // Measured, not nominal: how long this answer actually took.
    const responseSeconds = Math.round((Date.now() - shownAt) / 1000);
    setStatus("sampling");
    const response = await fetch("/api/energy-observations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "self_report", level, confidence: "high", aggregate: { responseSeconds } })
    });
    setStatus(response.ok ? "saved" : "error");
  };

  if (status === "sampling") return <span className="energy-probe-state">采样中…</span>;
  if (status === "saved") return <span className="energy-probe-state">已记录</span>;
  return <span className="energy-probe">
    <button type="button" aria-label="记录低精力" onClick={() => saveSelfReport("low")}>L</button>
    <button type="button" aria-label="记录中精力" onClick={() => saveSelfReport("medium")}>M</button>
    <button type="button" aria-label="记录高精力" onClick={() => saveSelfReport("high")}>H</button>
    {status === "error" && <em>不可用</em>}
  </span>;
}
