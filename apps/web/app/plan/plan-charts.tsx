import type { PlanBoard } from "../../lib/plan-board";
import { BarChart } from "../ui/charts";
import { Tag } from "../ui/tag";
import { RankingTable } from "./ranking-table";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;
const DAY = 86_400_000;

/**
 * The week's capacity in one chart: what the person said they put in, what the availability pattern offers, what the schedule fills
 * this week, and how much open work there is (usual and cautious). It replaces a sentence that compared two of these numbers.
 */
export function CapacityPanel({ board }: { board: PlanBoard }) {
  const { capacity } = board;
  const short = capacity.statedWeekly !== null && capacity.configuredWeekly < capacity.statedWeekly * 0.8;
  return <section className="pl-card" aria-label="每周容量">
    <header><h2>每周容量</h2>
      {capacity.usingDefault && <Tag tone="warn" title="可用时段仍为默认值，在下方「可用时段」中刷涂实际作息">默认时段</Tag>}
      {short && <Tag tone="warn" title="可用时段少于画像所述的每周投入，排程只能使用可用时段">可用时段不足</Tag>}</header>
    <BarChart label="每周容量" unit=" h" data={[
      ...(capacity.statedWeekly !== null ? [{ label: "所述投入", value: capacity.statedWeekly, title: `画像所述每周投入 ${capacity.statedWeekly} 小时` }] : []),
      { label: "可用时段", value: capacity.configuredWeekly, title: `可用时段每周 ${capacity.configuredWeekly} 小时（未扣除日历）` },
      { label: "本周已排", value: h(capacity.plannedThisWeek), title: `未来 7 天已排入 ${h(capacity.plannedThisWeek)} 小时` },
      { label: "待完成·通常", value: h(capacity.openP50), title: `可排程任务的剩余工作，通常估时合计 ${h(capacity.openP50)} 小时` },
      { label: "待完成·保守", value: h(capacity.openP85), title: `保守估时合计 ${h(capacity.openP85)} 小时` }
    ]} />
  </section>;
}

/**
 * Eight weeks ahead: each week's free time (net, and the part left after the reserve the forecast keeps), and each milestone as a
 * range from today to its usual finish (solid) and its cautious finish (light), with its deadline as a tick. Every mark has its value
 * on hover.
 */
export function ForecastChart({ board }: { board: PlanBoard }) {
  const start = Date.parse(`${board.today}T12:00:00Z`);
  const span = 56;
  const at = (day: string) => Math.max(0, Math.min(100, ((Date.parse(`${day}T12:00:00Z`) - start) / DAY / span) * 100));
  const top = Math.max(1, ...board.weeks.map((week) => week.netMinutes));
  return <section className="pl-card" aria-label="未来 8 周">
    <header><h2>未来 8 周</h2><small>日期为按当前估时与容量推算的情景</small></header>
    <p className="pl-chart-note">柱：每周可用时段扣除日历后的净时间；深色为再扣除预留后可排入任务的时间，下方数字即这部分小时数。行：每个已批准里程碑，实线到通常完成日，浅色延伸到保守完成日，竖线为截止日。</p>
    <div className="pl-weeks" role="img" aria-label="每周可用时间">
      {board.weeks.map((week) => <div key={week.week} className="pl-week" title={`第 ${week.week} 周（${md(week.start)} 起）：净可用 ${h(week.netMinutes)} h，预留 ${h(week.netMinutes - week.usableMinutes)} h，可排 ${h(week.usableMinutes)} h`}>
        <span className="pl-week-bar" aria-hidden="true">
          <i className="pl-week-net" style={{ height: `${(week.netMinutes / top) * 100}%` }} />
          <i className="pl-week-usable" style={{ height: `${(week.usableMinutes / top) * 100}%` }} />
        </span>
        <small className="mono">{h(week.usableMinutes)}</small>
        <small className="mono">{md(week.start)}</small>
      </div>)}
    </div>
    {board.goals.length > 0 && <div className="pl-goals">
      <div className="pl-goal-axis" aria-hidden="true">{[0, 14, 28, 42, 56].map((offset) => <span key={offset} style={{ left: `${(offset / span) * 100}%` }}>
        {md(new Date(start + offset * DAY).toISOString().slice(0, 10))}</span>)}</div>
      {board.goals.map((goal) => <div key={goal.id} className="pl-goal" data-line={goal.line}>
        <span className="pl-goal-title" title={goal.title}>{goal.title}</span>
        <span className="pl-goal-track">
          {goal.p50Day && <i className="pl-goal-p50" style={{ width: `${at(goal.p50Day)}%` }} title={`通常完成 ${goal.p50Day}`} />}
          {goal.p50Day && goal.p85Day && <i className="pl-goal-p85" style={{ left: `${at(goal.p50Day)}%`, width: `${Math.max(0.6, at(goal.p85Day) - at(goal.p50Day))}%` }}
            title={`保守完成 ${goal.p85Day}`} />}
          {goal.deadline && <i className="pl-goal-deadline" style={{ left: `${at(goal.deadline)}%` }} title={`截止 ${goal.deadline}`} />}
        </span>
        <span className="pl-goal-tags">
          {!goal.p85Day && (!goal.p50Minutes ? <Tag title="该里程碑下尚无可排程的任务">尚无任务</Tag>
            : goal.unforecast ? <Tag title="重要性低于 60 且无截止日的里程碑不参与预测">无截止日</Tag>
            : <Tag tone="warn" title={goal.bottleneck ?? "按当前容量 8 周内排不完"}>8 周内未完成</Tag>)}
          {goal.atRisk && <Tag tone="risk" title={`保守完成日距截止 ${goal.slackDays} 天`}>截止风险</Tag>}
          {goal.p85Day && !goal.atRisk && <small className="mono">{md(goal.p85Day)}</small>}
        </span>
      </div>)}
      <p className="pl-legend"><span className="pl-key" data-k="p50" />通常完成　<span className="pl-key" data-k="p85" />保守完成　<span className="pl-key" data-k="deadline" />截止</p>
    </div>}
    {board.inferredRegularBlocks > 0 && <small className="muted">第 2–8 周按日历中的 {board.inferredRegularBlocks} 个重复日程预留时间。</small>}
  </section>;
}

/**
 * Why the plan looks the way it does, from the scheduler's own input and result (`RankingTable`), with the optional written explanation
 * under it.
 */
export function RankingPanel({ board, explanation }: { board: PlanBoard;
  explanation: React.ReactNode }) {
  return <section className="pl-card" id="why" aria-label="排程依据">
    <header><h2>排程依据</h2><small>排序规则：优先档 → 重要性 → 截止日。调整重要性或截止日时先预览对排程的影响。</small></header>
    <RankingTable ranking={board.ranking} today={board.today} presets={Object.fromEntries(board.importance.map((row) => [row.id, row.preset.weight]))}
      weighable={board.importance.map((row) => row.id)} />
    {explanation}
  </section>;
}
