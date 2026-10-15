import type { RankedTask } from "../../lib/crossline";
import { Tag } from "../ui/tag";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
const TIER: Record<number, string> = { 1: "重要·有期限", 2: "有期限", 3: "重要·无期限", 4: "常规" };

/**
 * The scheduler's own ordering, read-only (decided 2026-10-15, replacing the editable 「排程依据」 table): each task's urgency tier, its
 * due day and its first block or why it has none. Importance is the agent's call, changed on each milestone's card; a due day on the
 * task's card. Tasks waiting in the task library are listed apart, with the day each enters the schedule.
 */
export function RankingTable({ ranking, today }: { ranking: RankedTask[]; today: string }) {
  const scheduled = ranking.filter((task) => !task.libraryUntil);
  const library = ranking.filter((task) => task.libraryUntil);
  if (!ranking.length) return <p className="muted">暂无可排程的任务。</p>;
  return <>
    <div className="pl-rank-table" role="table" aria-label="排程顺序">
      <div className="pl-rank-row pl-rank-head" role="row">
        <span role="columnheader">任务</span><span role="columnheader">优先档</span><span role="columnheader">截止</span><span role="columnheader">首个时段</span>
      </div>
      {scheduled.map((task) => <div key={task.id} className="pl-rank-row" role="row" data-line={task.line} data-unplaced={task.firstDay ? undefined : ""}>
        <a role="cell" href={`/workbench/${encodeURIComponent(task.id)}`} className="pl-rank-title" title={task.title}>{task.title}</a>
        <span role="cell"><Tag tone={task.tier <= 2 ? "info" : "neutral"}>{TIER[task.tier]}</Tag></span>
        <span role="cell" className="pl-rank-slot mono">{task.deadline ? md(task.deadline) : "—"}</span>
        <span role="cell" className="pl-rank-slot mono">{task.firstDay
          ? `${md(task.firstDay)} ${task.firstStart}${task.weekMinutes ? ` · 本周 ${h(task.weekMinutes)} h` : ""}`
          : <small>{task.blocker ?? (task.notBefore && task.notBefore > today ? `${md(task.notBefore)} 前不可开始` : "可用时段内没有空位")}</small>}</span>
      </div>)}
    </div>
    {library.length > 0 && <div className="pl-library"><h3>任务库 · {library.length}（里程碑三周内到期时排入）</h3>
      <ul>{library.map((task) => <li key={task.id} data-line={task.line}>
        <a href={`/workbench/${encodeURIComponent(task.id)}`}>{task.title}</a>
        <small className="mono">{md(task.libraryUntil!)} 起排入{task.deadline ? ` · 截止 ${md(task.deadline)}` : ""}</small>
      </li>)}</ul>
    </div>}
  </>;
}
