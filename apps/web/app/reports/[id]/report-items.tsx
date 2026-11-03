"use client";
import { useState } from "react";
import type { ReportItemView } from "../../../lib/reports";
import { useT } from "../../locale-context";
import { LineTag, Tag } from "../../ui/tag";

/** The report's 「可落地」: each action added to the tasks (a capture the analysis turns into a task that links back here) or set aside. */
export function ReportItems({ reportId, items, lines }: { reportId: string; items: ReportItemView[]; lines: Record<string, string> }) {
  const t = useT();
  const [current, setCurrent] = useState(items);
  const [busy, setBusy] = useState("");
  const decide = async (key: string, decision: "add" | "dismiss") => {
    setBusy(key);
    const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, decision }) }).catch(() => undefined);
    setBusy("");
    if (!response?.ok) return;
    setCurrent((list) => decision === "dismiss" ? list.filter((item) => item.key !== key) : list.map((item) => item.key === key ? { ...item, state: "added" } : item));
  };
  if (!current.length) return null;
  return <section className="rd-card" aria-labelledby="report-items">
    <header className="rd-card-head"><h2 id="report-items">{t("可落地")}</h2><small>{t("加入后由系统整理成任务")}</small></header>
    <ul className="report-items">{current.map((item) => <li key={item.key}>
      <p className="gen"><b>{item.title}</b></p>
      {item.why && <p className="rd-note gen">{item.why}</p>}
      <p className="rd-actions">
        {item.topic && <Tag>{item.topic}</Tag>}
        {item.lineId && lines[item.lineId] && <LineTag line={item.lineId}>{lines[item.lineId]}</LineTag>}
        {item.state === "added" ? <Tag tone="ok">{t("已加入")}</Tag> : <>
          <button type="button" className="primary-button" disabled={busy === item.key} onClick={() => void decide(item.key, "add")}>{t("加入任务")}</button>
          <button type="button" className="secondary-button" disabled={busy === item.key} onClick={() => void decide(item.key, "dismiss")}>{t("不需要")}</button>
        </>}
      </p>
    </li>)}</ul>
  </section>;
}
