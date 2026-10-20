import { ATTENTION_TARGET_MINUTES, type AttentionSummary, type Effectiveness } from "@crossline/core";
import { Bullet, Ring, Sparkline, StackedBar } from "../ui/charts";
import { Tag } from "../ui/tag";

const pct = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/**
 * 系统体检 as figures: milestones met on time, estimate accuracy against the 85% target, the week's hours by line with the share on
 * deadline work, the cost of running the system, and how much committed work gets the treatments the evidence supports. All from the
 * ledger; nothing here is a model's judgement.
 */
export function EffectivenessCard({ data, labels }: { data: Effectiveness & { setup?: AttentionSummary }; labels: Record<string, string> }) {
  const lines = Object.entries(data.priorities.minutesByLine).sort((a, b) => b[1] - a[1]);
  const coverage = data.estimates.coverageCalibrated ?? data.estimates.coverageRaw;
  return <div className="st-health">
    <div className="st-health-cell">
      {data.onTime.rate === null ? <div className="ui-stat"><b>—</b></div> : <Ring label="里程碑按时达成" value={data.onTime.rate} />}
      <div><b>按时达成</b><small>{data.onTime.due ? `${data.onTime.met}/${data.onTime.due} 个已到期里程碑` : "尚无到期里程碑"}</small>
        {data.onTime.atRisk.length > 0 && <Tag tone="risk" title={data.onTime.atRisk.join("、")}>{data.onTime.atRisk.length} 个有截止风险</Tag>}</div>
    </div>
    <div className="st-health-cell">
      {coverage !== null && <div className="st-health-bullet"><Bullet label="估时覆盖率" target={85} max={100} unit="%" actual={Math.round(coverage * 100)} /></div>}
      <div><b>估时覆盖率 {pct(coverage)}</b><small>{data.estimates.n ? `实际用时不超过保守估时的比例，目标 85%；${data.estimates.n} 个样本` : "尚无计时完成的任务"}</small></div>
    </div>
    <div className="st-health-cell">
      {(() => {
        const weeks = data.estimates.weekly.filter((week) => week.medianBias !== null);
        return <>
          {weeks.length > 1 && <Sparkline label="估时偏差（实际 ÷ 估时）按周" unit=" 倍" values={weeks.map((week) => week.medianBias!)}
            labels={weeks.map((week) => `${week.week.slice(5).replace("-", "/")} 周`)} />}
          <div><b>估时偏差 {weeks.length ? `${weeks.at(-1)!.medianBias} 倍` : "—"}</b><small>{weeks.length
            ? "最近一周实际用时与估时之比的中位数，1 倍为准；每周至少 3 个样本才计" : "每周至少 3 个计时完成的任务后显示"}</small></div>
        </>;
      })()}
    </div>
    <div className="st-health-cell st-health-wide">
      <div><b>近 7 天投入 {h(lines.reduce((sum, [, minutes]) => sum + minutes, 0))} h</b><small>有截止日的工作占 {pct(data.priorities.deadlineShare)}</small></div>
      {lines.length ? <StackedBar label="近 7 天各主线投入" unit=" h" segments={lines.map(([line, minutes]) => ({ label: labels[line] ?? line, value: h(minutes), line }))} />
        : <small className="muted">尚无计时记录</small>}
    </div>
    <div className="st-health-cell st-health-wide">
      <div><b>系统本身的成本</b><small>{data.overhead.decisionsTimed
        ? `决策用时只计待决卡片在屏幕上的时间（单张最多 5 分钟）；近 7 天 ${data.overhead.decisionsTimed} 次回答有计时`
        : "待决卡片从现在起记录在屏幕上的时间，回答几次后显示决策用时"}{data.overhead.planDaysRecorded
        ? `；计划变动为已排时段被挪开或撤下的工作块，${data.overhead.planDaysRecorded} 天有记录` : ""}</small></div>
      <div className="st-health-stats">
        <div className="ui-stat"><b>{data.overhead.decisionsPerDay}</b><span>每日决定次数</span></div>
        <div className="ui-stat"><b>{data.overhead.decisionsTimed ? `${data.overhead.decisionMinutesPerDay} 分` : "—"}</b><span>每日决策用时</span></div>
        <div className="ui-stat"><b>{data.overhead.planChangesPerDay === null ? "—" : data.overhead.planChangesPerDay}</b><span>每日计划变动（块）</span></div>
        <div className="ui-stat"><b>{data.overhead.pendingNow}</b><span>当前待决</span></div>
        <div className="ui-stat"><b>{data.overhead.medianCaptureToScheduled === null ? "—" : `${data.overhead.medianCaptureToScheduled} 分`}</b><span>收集到排入（中位）</span></div>
        {data.overhead.setupMinutes !== null && !data.setup && <div className="ui-stat"><b>{data.overhead.setupMinutes} 分</b><span>访谈投入（一次性）</span></div>}
      </div>
    </div>
    {data.setup && <div className="st-health-cell">
      <div className="ui-stat"><b>{data.setup.ready ? `${data.setup.ready.minutes} 分` : "—"}</b><span>访谈到可开始</span></div>
      <div className="ui-stat"><b>{data.setup.complete ? `${data.setup.complete.minutes} 分` : "—"}</b><span>访谈到完整</span></div>
      <div><b>访谈用时 {data.setup.minutes} 分</b><small>只计页面在前台且一分钟内有操作的时间；目标：可开始 ≤{ATTENTION_TARGET_MINUTES.ready} 分、完整 ≤{ATTENTION_TARGET_MINUTES.complete} 分
        {data.setup.ready ? `；第 ${data.setup.ready.rounds} 轮可开始` : ""}{data.setup.complete ? `，第 ${data.setup.complete.rounds} 轮完整` : ""}</small>
        {[data.setup.ready, data.setup.complete].some((mark) => mark && !mark.withinTarget) && <Tag tone="risk">超出目标</Tag>}</div>
    </div>}
    <div className="st-health-cell">
      {data.relations.rate === null ? <div className="ui-stat"><b>—</b></div> : <Ring label="跨线关系兑现率" value={data.relations.rate} />}
      <div><b>跨线关系兑现率</b><small>{data.relations.checked ? `${data.relations.checked} 条飞轮关系已到核对日，部分兑现按一半计` : "尚无到核对日的飞轮关系"}</small>
        {data.relations.byKind.filter((kind) => kind.checked >= 2 && kind.rate < 0.5).map((kind) =>
          <Tag key={kind.kind} tone="risk" title={`${kind.kind}：${kind.checked} 条，兑现 ${pct(kind.rate)}`}>{kind.kind} 兑现偏低</Tag>)}</div>
    </div>
    <div className="st-health-cell st-health-wide">
      <b>机制覆盖</b>
      {([["有具体时段的承诺任务", data.coverage.datedAndTimed], ["近 7 天有进展记录的里程碑", data.coverage.progressRecorded], ["按时回复的等待项", data.coverage.followUpsOnTime]] as const)
        .map(([name, value]) => <div key={name} className="st-meter" title={`${name} ${pct(value)}`}><span>{name}</span>
          <span className="st-meter-bar" aria-hidden="true"><i style={{ width: `${(value ?? 0) * 100}%` }} /></span><small className="mono">{pct(value)}</small></div>)}
    </div>
  </div>;
}
