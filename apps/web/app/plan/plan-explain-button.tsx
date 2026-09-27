"use client";

import { useState } from "react";

/** Kicks off the plan explainer and reloads once the run has started — the explanation itself lands as
 * a `plan.explained` event the server component reads back on the next render, same as prepare-materials
 * and the milestone gate's own retry buttons. */
export function PlanExplainButton() {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await fetch("/api/plan/explain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => undefined);
    setTimeout(() => location.reload(), 4000);
  };
  return <button type="button" className="plan-sync" disabled={busy} onClick={run}>
    {busy ? "解释生成中…" : "让 AI 解释这个排序"}
  </button>;
}
