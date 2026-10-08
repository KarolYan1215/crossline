"use client";

import { useState } from "react";
import type { Change, Impact } from "../../lib/impact";

const signed = (days: number) => days > 0 ? `晚 ${days} 天` : `早 ${-days} 天`;
const hours = (minutes: number) => `${(minutes / 60).toFixed(1)} h`;

/** What a change would do, laid out as figures: the task's next block, each milestone that moves, each line's hours this week. */
export function ImpactCard({ impact, busy, onApply, onCancel }: { impact: Impact; busy: boolean; onApply: () => void; onCancel: () => void }) {
  const task = impact.task;
  const week = impact.week;
  const weekMoved = week.availableBefore !== week.availableAfter || week.unplacedBefore !== week.unplacedAfter || week.blocksChanged > 0;
  const nothing = !impact.milestones.length && !impact.lines.length && task?.firstBefore === task?.firstAfter && !weekMoved;
  return <div className="impact-card" role="dialog" aria-label="改动影响">
    <header><b>改动影响</b><small>应用前预览</small></header>
    {task && task.firstBefore !== task.firstAfter && <p className="impact-row">
      <span>下一次时段</span><span className="mono">{task.firstBefore ?? "未排入"} → {task.firstAfter ?? "未排入"}</span></p>}
    {week.availableBefore !== week.availableAfter && <p className="impact-row"><span>未来 7 天可用</span>
      <span className="mono" data-tone={week.availableAfter < week.availableBefore ? "worse" : "better"}>{hours(week.availableBefore)} → {hours(week.availableAfter)}</span></p>}
    {week.plannedBefore !== week.plannedAfter && <p className="impact-row"><span>未来 7 天排入</span>
      <span className="mono">{hours(week.plannedBefore)} → {hours(week.plannedAfter)}</span></p>}
    {week.blocksChanged > 0 && <p className="impact-row"><span>未来 7 天时段调整</span><span className="mono">{week.blocksChanged} 处</span></p>}
    {week.unplacedBefore !== week.unplacedAfter && <p className="impact-row"><span>未排入的任务</span>
      <span className="mono" data-tone={week.unplacedAfter > week.unplacedBefore ? "worse" : "better"}>{week.unplacedBefore} → {week.unplacedAfter}</span></p>}
    {impact.milestones.map((item) => <p key={item.id} className="impact-row" data-line={item.line}>
      <span className="hl-line">{item.title}</span>
      <span className="mono" data-tone={item.shiftDays > 0 || item.atRiskAfter ? "worse" : "better"}>
        {item.shiftDays ? signed(item.shiftDays) : "日期不变"}{item.atRiskAfter && !item.atRiskBefore ? " · 新增截止风险" : !item.atRiskAfter && item.atRiskBefore ? " · 风险解除" : ""}</span>
    </p>)}
    {impact.lines.map((line) => <p key={line.line} className="impact-row" data-line={line.line}>
      <span className="hl-line">{line.label} · 本周</span><span className="mono">{hours(line.beforeMinutes)} → {hours(line.afterMinutes)}</span></p>)}
    {nothing && <p className="muted">对其他任务和里程碑没有影响。</p>}
    <footer><button type="button" className="primary-button" disabled={busy} onClick={onApply}>应用</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button></footer>
  </div>;
}

/**
 * Preview, then apply (decided 2026-10-07): `propose` asks the server what the change does; `apply` makes it and reloads so every view
 * shows the new schedule.
 */
export function useImpact() {
  const [pending, setPending] = useState<{ change: Change; impact: Impact } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const post = (body: unknown) => fetch("/api/plan/impact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((response) => response.json() as Promise<{ ok: boolean; impact?: Impact; code?: string }>);
  const propose = async (change: Change) => {
    setBusy(true); setError("");
    const result = await post({ change }).catch(() => null);
    setBusy(false);
    if (result?.ok && result.impact) setPending({ change, impact: result.impact });
    else setError("影响计算失败，请重试");
  };
  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    const result = await post({ change: pending.change, apply: true }).catch(() => null);
    if (result?.ok) { location.reload(); return; }
    setBusy(false); setError("未能应用，请重试");
  };
  return { pending, busy, error, propose, apply, cancel: () => setPending(null) };
}
