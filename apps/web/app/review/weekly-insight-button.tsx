"use client";

import { useState } from "react";
import { useT } from "../locale-context";

export function WeeklyInsightButton() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await fetch("/api/review/weekly-insight", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => undefined);
    setTimeout(() => location.reload(), 4000);
  };
  return <button type="button" className="plan-sync" disabled={busy} onClick={run}>
    {busy ? t("生成中…") : t("现在生成本周洞察")}
  </button>;
}
