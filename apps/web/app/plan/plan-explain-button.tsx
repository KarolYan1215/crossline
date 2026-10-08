"use client";

import { useState } from "react";

/**
 * Asks for a written account of the current ordering and reloads once the run has started; the text lands as a `plan.explained`
 * event the page reads back. The ordering itself is shown above it from the scheduler's own result, so this is optional.
 */
export function PlanExplainButton({ hasExplanation }: { hasExplanation: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await fetch("/api/plan/explain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => undefined);
    setTimeout(() => location.reload(), 4000);
  };
  return <button type="button" className="plan-sync" disabled={busy} onClick={run}>
    {busy ? "生成中…" : hasExplanation ? "更新文字说明" : "生成文字说明"}
  </button>;
}
