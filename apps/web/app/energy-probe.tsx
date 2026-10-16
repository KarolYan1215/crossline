"use client";

import { useState } from "react";
import { useT } from "./locale-context";

export function EnergyProbe({ context = "general", workOrderId }: {
  context?: "general" | "before_task" | "after_task" | "after_rest" | "correction"; workOrderId?: string
}) {
  const t = useT();
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

  if (status === "sampling") return <span className="energy-probe-state">{t("采样中…")}</span>;
  return <span className="energy-probe">
    {context === "after_task" && <label>{t("这件事累不累")} <select value={actualLoad}
      onChange={(event) => setActualLoad(event.target.value as typeof actualLoad)}>
      <option value="">{t("跳过")}</option><option value="low">{t("低")}</option>
      <option value="medium">{t("中")}</option><option value="high">{t("高")}</option>
    </select></label>}
    {/* 「L M H」 alone read as nothing to an invitee (2026-10-15 walkthrough): the buttons say what they record. */}
    {context === "after_task" && <span>{t("此刻精力")}</span>}
    <button type="button" aria-label={t("记录低精力")} onClick={() => saveSelfReport("low")}>{t("低")}</button>
    <button type="button" aria-label={t("记录中精力")} onClick={() => saveSelfReport("medium")}>{t("中")}</button>
    <button type="button" aria-label={t("记录高精力")} onClick={() => saveSelfReport("high")}>{t("高")}</button>
    {status === "error" && <em>{t("不可用")}</em>}
  </span>;
}
