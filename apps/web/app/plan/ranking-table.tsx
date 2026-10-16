import type { RankedTask } from "../../lib/crossline";
import { Tag } from "../ui/tag";
import { tFor, type Locale } from "../../lib/i18n";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
/** Kept in Chinese (they are the keys); translated where shown. */
const TIER: Record<number, string> = { 1: "重要·有期限", 2: "有期限", 3: "重要·无期限", 4: "常规" };

/**
 * The scheduler's own ordering, read-only (decided 2026-10-15, replacing the editable 「排程依据」 table): each task's urgency tier, its
 * due day and its first block or why it has none. Importance is the agent's call, changed on each milestone's card; a due day on the
 * task's card. Tasks waiting in the task library are listed apart, with the day each enters the schedule.
 */
export function RankingTable({ ranking, today, locale }: { ranking: RankedTask[]; today: string; locale?: Locale }) {
  const t = tFor(locale);
  const scheduled = ranking.filter((task) => !task.libraryUntil);
  const library = ranking.filter((task) => task.libraryUntil);
  if (!ranking.length) return <p className="muted">{t("暂无可排程的任务。")}</p>;
  return <>
    <div className="pl-rank-table" role="table" aria-label={t("排程顺序")}>
      <div className="pl-rank-row pl-rank-head" role="row">
        <span role="columnheader">{t("任务", { context: "column" })}</span><span role="columnheader">{t("优先档")}</span><span role="columnheader">{t("截止")}</span><span role="columnheader">{t("首个时段")}</span>
      </div>
      {scheduled.map((task) => <div key={task.id} className="pl-rank-row" role="row" data-line={task.line} data-unplaced={task.firstDay ? undefined : ""}>
        <a role="cell" href={`/workbench/${encodeURIComponent(task.id)}`} className="pl-rank-title" title={task.title}>{task.title}</a>
        <span role="cell"><Tag tone={task.tier <= 2 ? "info" : "neutral"}>{TIER[task.tier] ? t(TIER[task.tier]!) : ""}</Tag></span>
        <span role="cell" className="pl-rank-slot mono">{task.deadline ? md(task.deadline) : "—"}</span>
        <span role="cell" className="pl-rank-slot mono">{task.firstDay
          ? `${md(task.firstDay)} ${task.firstStart}${task.weekMinutes ? ` · ${t("本周 {{n}} h", { n: h(task.weekMinutes) })}` : ""}`
          : <small>{task.blocker ?? (task.notBefore && task.notBefore > today ? t("{{day}} 前不可开始", { day: md(task.notBefore) }) : t("可用时段内没有空位"))}</small>}</span>
      </div>)}
    </div>
    {library.length > 0 && <div className="pl-library"><h3>{t("任务库 · {{n}}（里程碑三周内到期时排入）", { n: library.length })}</h3>
      <ul>{library.map((task) => <li key={task.id} data-line={task.line}>
        <a href={`/workbench/${encodeURIComponent(task.id)}`}>{task.title}</a>
        <small className="mono">{t("{{day}} 起排入", { day: md(task.libraryUntil!) })}{task.deadline ? ` · ${t("截止 {{day}}", { day: md(task.deadline) })}` : ""}</small>
      </li>)}</ul>
    </div>}
  </>;
}
