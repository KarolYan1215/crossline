"use client";

import { useState } from "react";
import type { AgentHistorySummary } from "@crossline/core";
import { SegmentedControl } from "../ui/controls";
import { BarChart } from "../ui/charts";

/**
 * Codex and Claude Code history, time only: whether it may be read, and what was read — hours per folder and when in the day. It informs
 * the interview and the portrait about habits and progress; the schedule never uses it.
 */
export function AgentHistoryCard({ on, summary }: { on: boolean; summary: AgentHistorySummary | null }) {
  const [value, setValue] = useState(on);
  const [note, setNote] = useState("");
  const change = async (next: boolean) => {
    setValue(next);
    const response = await fetch("/api/settings/agent-history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) }).catch(() => undefined);
    if (!response?.ok) { setValue(!next); setNote("未保存，请重试"); } else setNote(next ? "已开启：几分钟内读取完毕，刷新后可见" : "已关闭，已删除统计");
  };
  const top = Math.max(1, ...(summary?.byHour ?? [0]));
  return <section className="st-card" aria-label="编程助手使用记录">
    <header><h3>Codex 与 Claude Code 使用记录</h3><small>只读每条记录的时间和所在文件夹，不读对话内容；用于了解习惯与进度，不用于排程</small></header>
    <div className="st-row"><span className="st-row-label">读取<small>{value ? "开启" : "关闭"}</small></span>
      <SegmentedControl label="编程助手使用记录" value={value ? "on" : "off"} onChange={(next) => void change(next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {note && <p role="status" className="st-note">{note}</p>}
    {value && summary && summary.totalMinutes > 0 && <>
      <BarChart label={`过去 ${summary.days} 天按文件夹`} unit=" 时" data={summary.folders.slice(0, 8).map((folder) => ({ label: folder.folder, value: Math.round(folder.minutes / 6) / 10,
        title: `${folder.folder}：${(folder.minutes / 60).toFixed(1)} 小时，${folder.activeDays} 天，最近 ${folder.lastActive}` }))} />
      <div className="st-hours" role="img" aria-label="一天中各小时的工作分钟">{summary.byHour.map((minutes, hour) =>
        <span key={hour} title={`${hour}:00–${hour + 1}:00 · ${Math.round(minutes / 60)} 小时`}><i style={{ height: `${(minutes / top) * 100}%` }} /></span>)}</div>
      <div className="st-hours-axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
    </>}
  </section>;
}
