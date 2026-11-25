"use client";
import { useState } from "react";
import { useT } from "../locale-context";

/**
 * The goal the execution gates judge against (`gates.goal`, docs/plans/execution-gates-1124.md §四): the person's own objective and this
 * period's action list, pasted verbatim. P1 marks, today's front task, milestone admission and the attention audit all read it.
 */
export function GateGoalCard({ initial }: { initial: string }) {
  const t = useT();
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const response = await fetch("/api/gates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "goal", text }) }).catch(() => undefined);
    setBusy(false);
    setStatus(response?.ok ? t("已保存。下次判定起按它来。") : t("没有保存，请再试一次。"));
  };
  return <div className="st-module">
    <h3>{t("关口判定依据的目标")}</h3>
    <p className="muted">{t("原样贴上长期目标和这一阶段的行动清单。P1 标注、今日首件、里程碑准入和注意力审计都按它判断。")}</p>
    <textarea value={text} rows={6} maxLength={6000} onChange={(event) => setText(event.target.value)} aria-label={t("关口判定依据的目标")} />
    <button type="button" disabled={busy} onClick={() => void save()}>{t("保存")}</button>
    {status && <em role="status">{status}</em>}
  </div>;
}
