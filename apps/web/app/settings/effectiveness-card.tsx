import { ATTENTION_TARGET_MINUTES, type AttentionSummary, type Effectiveness } from "@crossline/core";
import { Bullet, Ring, Sparkline, StackedBar } from "../ui/charts";
import { Tag } from "../ui/tag";
import { joinList, tFor, type Locale } from "../../lib/i18n";

const pct = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
const h = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/**
 * 系统体检 as figures: milestones met on time, estimate accuracy against the 85% target, the week's hours by line with the share on
 * deadline work, the cost of running the system, and how much committed work gets the treatments the evidence supports. All from the
 * ledger; nothing here is a model's judgement.
 */
export function EffectivenessCard({ data, labels, locale }: { data: Effectiveness & { setup?: AttentionSummary }; labels: Record<string, string>; locale?: Locale }) {
  const t = tFor(locale);
  const lines = Object.entries(data.priorities.minutesByLine).sort((a, b) => b[1] - a[1]);
  const coverage = data.estimates.coverageCalibrated ?? data.estimates.coverageRaw;
  return <div className="st-health">
    <div className="st-health-cell">
      {data.onTime.rate === null ? <div className="ui-stat"><b>—</b></div> : <Ring label={t("里程碑按时达成")} value={data.onTime.rate} />}
      <div><b>{t("按时达成")}</b><small>{data.onTime.due ? t("{{met}}/{{due}} 个已到期里程碑", { met: data.onTime.met, due: data.onTime.due }) : t("尚无到期里程碑")}</small>
        {data.onTime.atRisk.length > 0 && <Tag tone="risk" title={locale === "en" ? joinList(locale, data.onTime.atRisk) : data.onTime.atRisk.join("、")}>{t("{{count}} 个有截止风险", { count: data.onTime.atRisk.length })}</Tag>}</div>
    </div>
    <div className="st-health-cell">
      {coverage !== null && <div className="st-health-bullet"><Bullet label={t("估时覆盖率")} target={85} max={100} unit="%" actual={Math.round(coverage * 100)} /></div>}
      <div><b>{t("估时覆盖率 {{pct}}", { pct: pct(coverage) })}</b><small>{data.estimates.n ? t("实际用时不超过保守估时的比例，目标 85%；{{count}} 个样本", { count: data.estimates.n }) : t("尚无计时完成的任务")}</small></div>
    </div>
    <div className="st-health-cell">
      {(() => {
        const weeks = data.estimates.weekly.filter((week) => week.medianBias !== null);
        return <>
          {weeks.length > 1 && <Sparkline label={t("估时偏差（实际 ÷ 估时）按周")} unit={t(" 倍")} values={weeks.map((week) => week.medianBias!)}
            labels={weeks.map((week) => t("{{week}} 周", { week: week.week.slice(5).replace("-", "/") }))} />}
          <div><b>{t("估时偏差 {{bias}}", { bias: weeks.length ? t("{{n}} 倍", { n: weeks.at(-1)!.medianBias }) : "—" })}</b><small>{weeks.length
            ? t("最近一周实际用时与估时之比的中位数，1 倍为准；每周至少 3 个样本才计") : t("每周至少 3 个计时完成的任务后显示")}</small></div>
        </>;
      })()}
    </div>
    <div className="st-health-cell st-health-wide">
      <div><b>{t("近 7 天投入 {{hours}} h", { hours: h(lines.reduce((sum, [, minutes]) => sum + minutes, 0)) })}</b><small>{t("有截止日的工作占 {{pct}}", { pct: pct(data.priorities.deadlineShare) })}</small></div>
      {lines.length ? <StackedBar label={t("近 7 天各主线投入")} unit=" h" segments={lines.map(([line, minutes]) => ({ label: labels[line] ?? line, value: h(minutes), line }))} />
        : <small className="muted">{t("尚无计时记录")}</small>}
    </div>
    <div className="st-health-cell st-health-wide">
      <div><b>{t("系统本身的成本")}</b><small>{data.overhead.decisionsTimed
        ? t("决策用时只计待决卡片在屏幕上的时间（单张最多 5 分钟）；近 7 天 {{count}} 次回答有计时", { count: data.overhead.decisionsTimed })
        : t("待决卡片从现在起记录在屏幕上的时间，回答几次后显示决策用时")}{data.overhead.planDaysRecorded
        ? t("；计划变动为已排时段被挪开或撤下的工作块，{{count}} 天有记录", { count: data.overhead.planDaysRecorded }) : ""}</small></div>
      <div className="st-health-stats">
        <div className="ui-stat"><b>{data.overhead.decisionsPerDay}</b><span>{t("每日决定次数")}</span></div>
        <div className="ui-stat"><b>{data.overhead.decisionsTimed ? t("{{n}} 分", { n: data.overhead.decisionMinutesPerDay }) : "—"}</b><span>{t("每日决策用时")}</span></div>
        <div className="ui-stat"><b>{data.overhead.planChangesPerDay === null ? "—" : data.overhead.planChangesPerDay}</b><span>{t("每日计划变动（块）")}</span></div>
        <div className="ui-stat"><b>{data.overhead.pendingNow}</b><span>{t("当前待决")}</span></div>
        <div className="ui-stat"><b>{data.overhead.medianCaptureToScheduled === null ? "—" : t("{{n}} 分", { n: data.overhead.medianCaptureToScheduled })}</b><span>{t("收集到排入（中位）")}</span></div>
        {data.overhead.setupMinutes !== null && !data.setup && <div className="ui-stat"><b>{t("{{n}} 分", { n: data.overhead.setupMinutes })}</b><span>{t("访谈投入（一次性）")}</span></div>}
      </div>
    </div>
    {data.setup && <div className="st-health-cell">
      <div className="ui-stat"><b>{data.setup.ready ? t("{{n}} 分", { n: data.setup.ready.minutes }) : "—"}</b><span>{t("访谈到可开始")}</span></div>
      <div className="ui-stat"><b>{data.setup.complete ? t("{{n}} 分", { n: data.setup.complete.minutes }) : "—"}</b><span>{t("访谈到完整")}</span></div>
      <div><b>{t("访谈用时 {{n}} 分", { n: data.setup.minutes })}</b><small>{t("只计页面在前台且一分钟内有操作的时间；目标：可开始 ≤{{ready}} 分、完整 ≤{{complete}} 分", { ready: ATTENTION_TARGET_MINUTES.ready, complete: ATTENTION_TARGET_MINUTES.complete })}
        {data.setup.ready ? t("；第 {{n}} 轮可开始", { n: data.setup.ready.rounds }) : ""}{data.setup.complete ? t("，第 {{n}} 轮完整", { n: data.setup.complete.rounds }) : ""}</small>
        {[data.setup.ready, data.setup.complete].some((mark) => mark && !mark.withinTarget) && <Tag tone="risk">{t("超出目标")}</Tag>}</div>
    </div>}
    <div className="st-health-cell">
      {data.relations.rate === null ? <div className="ui-stat"><b>—</b></div> : <Ring label={t("跨线关系兑现率")} value={data.relations.rate} />}
      <div><b>{t("跨线关系兑现率")}</b><small>{data.relations.checked ? t("{{count}} 条飞轮关系已到核对日，部分兑现按一半计", { count: data.relations.checked }) : t("尚无到核对日的飞轮关系")}</small>
        {data.relations.byKind.filter((kind) => kind.checked >= 2 && kind.rate < 0.5).map((kind) =>
          <Tag key={kind.kind} tone="risk" title={t("{{kind}}：{{count}} 条，兑现 {{pct}}", { kind: t(kind.kind), count: kind.checked, pct: pct(kind.rate) })}>{t("{{kind}} 兑现偏低", { kind: t(kind.kind) })}</Tag>)}</div>
    </div>
    <div className="st-health-cell st-health-wide">
      <b>{t("机制覆盖")}</b>
      {([["有具体时段的承诺任务", data.coverage.datedAndTimed], ["近 7 天有进展记录的里程碑", data.coverage.progressRecorded], ["按时回复的等待项", data.coverage.followUpsOnTime]] as const)
        .map(([name, value]) => <div key={name} className="st-meter" title={`${t(name)} ${pct(value)}`}><span>{t(name)}</span>
          <span className="st-meter-bar" aria-hidden="true"><i style={{ width: `${(value ?? 0) * 100}%` }} /></span><small className="mono">{pct(value)}</small></div>)}
    </div>
  </div>;
}
