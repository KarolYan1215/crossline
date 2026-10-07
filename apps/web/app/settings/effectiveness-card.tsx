import type { Effectiveness } from "@crossline/core";

const pct = (value: number | null) => value === null ? "还没有数据" : `${Math.round(value * 100)}%`;
const num = (value: number | null, unit = "") => value === null ? "还没有数据" : `${value}${unit}`;

/**
 * 系统体检: the four numbers the person chose as their test of whether this works, plus how much of their work gets
 * the treatment the evidence supports. All read from the ledger daily; none needs an experiment.
 */
export function EffectivenessCard({ data, labels }: { data: Effectiveness & { decisionMinutesMeasured: false }; labels: Record<string, string> }) {
  const lines = Object.entries(data.priorities.minutesByLine).sort((a, b) => b[1] - a[1]);
  return <div className="effectiveness">
    <dl className="effectiveness-grid">
      <div><dt>里程碑按时达成</dt><dd>{data.onTime.due ? `${data.onTime.met}/${data.onTime.due}（${pct(data.onTime.rate)}）` : "还没有到期的"}
        {data.onTime.atRisk.length > 0 && <small> · 可能赶不上：{data.onTime.atRisk.join("、")}</small>}</dd></div>
      <div><dt>估时准确度</dt><dd>{data.estimates.n ? <>AI 原值偏差 {num(data.estimates.maeRaw)} · 校准后 {num(data.estimates.maeCalibrated)}
        <small>（对数误差，越小越准；实际用时没超过「宽一点」的比例：AI {pct(data.estimates.coverageRaw)} · 校准 {pct(data.estimates.coverageCalibrated)}，目标 85%）</small></> : "还没有完成并记了用时的任务"}</dd></div>
      <div><dt>时间花在优先级上</dt><dd>{lines.length ? <>近 7 天：{lines.map(([line, minutes]) => `${labels[line] ?? line} ${Math.round(minutes / 60 * 10) / 10} 小时`).join("、")}
        <small> · 有截止日的工作占 {pct(data.priorities.deadlineShare)}</small></> : "近 7 天还没有记录的工作时间"}</dd></div>
      <div><dt>管理系统本身的开销</dt><dd>每天约 {data.overhead.decisionsPerDay} 次决定 · 现在 {data.overhead.pendingNow} 件待决
        <small> · 从收集到排进日历中位 {num(data.overhead.medianCaptureToScheduled, " 分钟")}；花在决定上的分钟数还没开始记录</small></dd></div>
    </dl>
    <p className="muted">机制覆盖：已承诺的工作中有具体日期时段的 {pct(data.coverage.datedAndTimed)}（写下「何时何地做」是证据最强的做法之一）；
      近 7 天有进展记录的里程碑 {pct(data.coverage.progressRecorded)}；等待项按时回答 {pct(data.coverage.followUpsOnTime)}。</p>
  </div>;
}
