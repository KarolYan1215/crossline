"use client";

import { useState } from "react";
import type { ImportancePreset } from "@crossline/core";
import type { RankedTask } from "../../lib/crossline";
import { DateChip, Slider } from "../ui/controls";
import { Tip } from "../ui/overlay";
import { Tag } from "../ui/tag";
import { ImpactCard } from "../task/impact";
import { usePlanImpact } from "./preview-context";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
const TIER: Record<number, string> = { 1: "重要·有期限", 2: "有期限", 3: "重要·无期限", 4: "常规" };

/**
 * 「排程依据」 as one compact table read off the scheduler's own input and result: each task's urgency tier, its milestone's
 * importance (a slider, shared by every task of that milestone) and its due day (a date chip), then its first block or why it has none.
 * A slider or a date change is previewed across the schedule before it is applied, like every other change on this page. Tasks waiting in
 * the task library are listed apart, with the day each enters the schedule. This table is the one place the importance slider lives
 * (decided 2026-10-10); the reasons for the system's preset are on hover beside it.
 */
export function RankingTable({ ranking, today, importance }: { ranking: RankedTask[]; today: string;
  /** Approved milestones with the system's preset (the slider's tick and its reasons); a milestone not in here has no slider. */
  importance: Array<{ id: string; preset: ImportancePreset; custom: boolean }> }) {
  const impact = usePlanImpact();
  const [active, setActive] = useState<string | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>(() => Object.fromEntries(ranking.map((task) => [task.milestoneId, task.weight])));
  const scheduled = ranking.filter((task) => !task.libraryUntil);
  const library = ranking.filter((task) => task.libraryUntil);
  const preset = new Map(importance.map((row) => [row.id, row]));
  const cancel = () => { impact.cancel(); setActive(null); setWeights(Object.fromEntries(ranking.map((task) => [task.milestoneId, task.weight]))); };

  if (!ranking.length) return <p className="muted">暂无可排程的任务。</p>;
  return <>
    <div className="pl-rank-table" role="table" aria-label="排程顺序">
      <div className="pl-rank-row pl-rank-head" role="row">
        <span role="columnheader">任务</span><span role="columnheader">优先档</span><span role="columnheader">重要性</span>
        <span role="columnheader">截止</span><span role="columnheader">首个时段</span>
      </div>
      {scheduled.map((task) => <div key={task.id} className="pl-rank-group">
        <div className="pl-rank-row" role="row" data-line={task.line} data-unplaced={task.firstDay ? undefined : ""}>
          <a role="cell" href={`/workbench/${encodeURIComponent(task.id)}`} className="pl-rank-title" title={task.title}>{task.title}</a>
          <span role="cell"><Tag tone={task.tier <= 2 ? "info" : "neutral"}>{TIER[task.tier]}</Tag></span>
          <span role="cell" className="pl-rank-weight">{preset.has(task.milestoneId) ? <>
            <Slider label={`${task.title} 所属里程碑的重要性`} value={weights[task.milestoneId] ?? task.weight} preset={preset.get(task.milestoneId)!.preset.weight}
              onChange={(value) => setWeights({ ...weights, [task.milestoneId]: value })}
              onCommit={(value) => { if (value === task.weight) return; setActive(task.id); void impact.propose({ kind: "weight", milestoneId: task.milestoneId, weight: value }); }} />
            <Tip content={<span className="pl-basis">{preset.get(task.milestoneId)!.preset.basis.map((item) => <span key={item.key}>
              <b>{item.label} {item.points >= 0 ? "+" : ""}{item.points}</b>{item.detail}</span>)}<span><b>系统预设 {preset.get(task.milestoneId)!.preset.weight}</b></span></span>}>
              <button type="button" className="pl-imp-basis" aria-label={`${task.title} 重要性预设依据`}>{preset.get(task.milestoneId)!.custom ? "已调整" : "预设"}</button>
            </Tip></>
            : <small className="mono">{task.weight}</small>}</span>
          <span role="cell"><DateChip label="截止" value={task.deadline ?? undefined}
            onChange={(value) => { if (!value || value === task.deadline) return; setActive(task.id); void impact.propose({ kind: "due", workOrderId: task.id, date: value }); }} /></span>
          <span role="cell" className="pl-rank-slot mono">{task.firstDay
            ? `${md(task.firstDay)} ${task.firstStart}${task.weekMinutes ? ` · 本周 ${h(task.weekMinutes)} h` : ""}`
            : <small>{task.blocker ?? (task.notBefore && task.notBefore > today ? `${md(task.notBefore)} 前不可开始` : "可用时段内没有空位")}</small>}</span>
        </div>
        {active === task.id && impact.busy && !impact.pending && <small role="status">计算影响…</small>}
        {active === task.id && impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={cancel} />}
        {active === task.id && impact.error && <small role="status">{impact.error}</small>}
      </div>)}
    </div>
    {library.length > 0 && <details className="fold advanced pl-library"><summary>任务库 · {library.length}（里程碑三周内到期时排入）</summary>
      <ul>{library.map((task) => <li key={task.id} data-line={task.line}>
        <a href={`/workbench/${encodeURIComponent(task.id)}`}>{task.title}</a>
        <small className="mono">{md(task.libraryUntil!)} 起排入{task.deadline ? ` · 截止 ${md(task.deadline)}` : ""}</small>
      </li>)}</ul>
    </details>}
  </>;
}
