"use client";

import { useState, type ReactNode } from "react";
import { Inbox, Sparkles } from "lucide-react";
import { ICON } from "../ui/icon-button";
import { useT } from "../locale-context";

/**
 * 收集 → 任务, at the top of 任务 (2026-10-28): how many inputs wait to be made into tasks, the first few by name, 立即分析 for all of
 * them at once, and 查看 to open each one (its own analyse, discard and make-by-hand controls, `children`). The analysis runs by itself
 * within seconds of a capture; 立即分析 is for one that stopped or was left. With nothing waiting it says where new work comes from.
 */
export function CollectBar({ count, titles, pending, children }: { count: number; titles: string[]; pending: string[]; children: ReactNode }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  if (!count) return <p className="tk-collect" data-empty="">
    <Inbox {...ICON} /><b>{t("收集")}</b><span className="muted">{t("暂无待整理的输入；在页底输入框写下要做的事，系统整理成任务。")}</span></p>;
  const analyse = async () => {
    setBusy(true); setStatus(t("正在分析；完成后仍需人工审批"));
    const results = await Promise.all(pending.map((id) => fetch(`/api/captures/${encodeURIComponent(id)}/analyze`, { method: "POST" })
      .then((response) => response.ok).catch(() => false)));
    if (results.every(Boolean)) { location.reload(); return; }
    setBusy(false);
    setStatus(t("有 {{count}} 条没有分析成功；点「查看」逐条处理。", { count: results.filter((ok) => !ok).length }));
  };
  return <details className="tk-collect advanced">
    <summary>
      <Inbox {...ICON} /><b>{t("收集 {{count}} 条待分析", { count })}</b>
      <span className="tk-collect-titles">{titles.map((title) => <q key={title}>{title}</q>)}</span>
      {pending.length > 0 && <button type="button" className="secondary-button" disabled={busy}
        onClick={(event) => { event.preventDefault(); void analyse(); }}><Sparkles {...ICON} size={14} />{t("立即分析")}</button>}
      <span className="tk-collect-open">{t("查看")}</span>
    </summary>
    {status && <p role="status" className="tasks-empty">{status}</p>}
    {children}
  </details>;
}
