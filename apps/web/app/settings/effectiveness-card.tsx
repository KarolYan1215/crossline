import type { Effectiveness } from "@crossline/core";
import { Bullet, Ring, StackedBar } from "../ui/charts";
import { Tag } from "../ui/tag";

const pct = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/**
 * 系统体检 as figures: milestones met on time, estimate accuracy against the 85% target, the week's hours by line with the share on
 * deadline work, the cost of running the system, and how much committed work gets the treatments the evidence supports. All from the
 * ledger; nothing here is a model's judgement.
 */
export function EffectivenessCard({ data, labels }: { data: Effectiveness & { decisionMinutesMeasured: false }; labels: Record<string, string> }) {
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
    <div className="st-health-cell st-health-wide">
      <div><b>近 7 天投入 {h(lines.reduce((sum, [, minutes]) => sum + minutes, 0))} h</b><small>有截止日的工作占 {pct(data.priorities.deadlineShare)}</small></div>
      {lines.length ? <StackedBar label="近 7 天各主线投入" unit=" h" segments={lines.map(([line, minutes]) => ({ label: labels[line] ?? line, value: h(minutes), line }))} />
        : <small className="muted">尚无计时记录</small>}
    </div>
    <div className="st-health-cell">
      <div className="ui-stat"><b>{data.overhead.decisionsPerDay}</b><span>每日决定次数</span></div>
      <div className="ui-stat"><b>{data.overhead.pendingNow}</b><span>当前待决</span></div>
      <div className="ui-stat"><b>{data.overhead.medianCaptureToScheduled === null ? "—" : `${data.overhead.medianCaptureToScheduled} 分`}</b><span>收集到排入（中位）</span></div>
    </div>
    <div className="st-health-cell st-health-wide">
      <b>机制覆盖</b>
      {([["有具体时段的承诺任务", data.coverage.datedAndTimed], ["近 7 天有进展记录的里程碑", data.coverage.progressRecorded], ["按时回复的等待项", data.coverage.followUpsOnTime]] as const)
        .map(([name, value]) => <div key={name} className="st-meter" title={`${name} ${pct(value)}`}><span>{name}</span>
          <span className="st-meter-bar" aria-hidden="true"><i style={{ width: `${(value ?? 0) * 100}%` }} /></span><small className="mono">{pct(value)}</small></div>)}
    </div>
  </div>;
}
