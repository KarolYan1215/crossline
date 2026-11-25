import { ATTENTION_CLASSES, ESTIMATE_RATIO_DAYS, NIGHT_HOURS, type AttentionClass } from "@crossline/core";
import type { GateReview } from "../../lib/gates";
import type { Translate } from "../../lib/i18n";
import { BarChart } from "../ui/charts";
import { SetbackReport } from "./setback-report";

/* i18n-ignore-start: class keys, translated through `t` below */
const CLASS_LABEL: Record<AttentionClass, string> = { execution: "执行本身", outside_gate: "外部关口", meta: "元工作", other: "其他" };
/* i18n-ignore-end */

/**
 * The weekly review's 「关口」 (docs/plans/execution-gates-1124.md §四): how each gate judged this week and how often the person turned it
 * over, tasks marked done without evidence, where the week's time went (J3), the estimate ratio (J5), night actions (J6), parked milestones.
 */
export function GatesBlock({ review, t }: { review: GateReview; t: Translate }) {
  const hours = review.attention?.hours ?? {};
  return <section className="rd-card review-block review-wide" aria-labelledby="rv-gates">
    <header className="rd-card-head"><h2 id="rv-gates" className="ds-serif">{t("关口")}</h2>
      <small>{t("模型按证据判定，推翻的次数与内容都在这里")}</small></header>
    {review.stats.length === 0
      ? <p className="review-empty">{t("本周还没有关口判定。")}</p>
      : <table className="rv-gates-table"><thead><tr><th>{t("关口")}</th><th>{t("判定")}</th><th>{t("判断不了")}</th><th>{t("两次不一致")}</th><th>{t("问了你")}</th><th>{t("被推翻")}</th></tr></thead>
        <tbody>{review.stats.map((row) => <tr key={row.gate}><td>{row.label}</td><td className="mono">{row.judged}</td><td className="mono">{row.cannotJudge}</td>
          <td className="mono">{row.disagreed}</td><td className="mono">{row.asked}</td><td className="mono">{row.overridden}{row.agreedButOverridden ? t("（其中两次一致仍被推翻 {{count}}）", { count: row.agreedButOverridden }) : ""}</td></tr>)}</tbody></table>}

    {review.claimedNoEvidence.length > 0 && <>
      <h3 className="review-week-head">{t("点了完成、但没找到证据的 P1 / 对外任务")}</h3>
      <ul className="review-list">{review.claimedNoEvidence.map((item) => <li key={item.id}><b>{item.title}</b> <span className="muted">{item.reason || t("还没判定")}</span></li>)}</ul>
    </>}

    {review.attention && <>
      <h3 className="review-week-head">{t("上周时间去哪了")}</h3>
      <BarChart label={t("上周各类时间")} unit=" h" data={ATTENTION_CLASSES.map((key) => ({ label: t(CLASS_LABEL[key]), value: hours[key] ?? 0 }))} />
      <p className="review-note">{t("其中开发 Crossline {{hours}} 小时；元工作占 {{share}}%。", { hours: review.attention.crossline, share: Math.round(review.attention.metaShare * 100) })} {review.attention.reason}
        {review.attention.unclear ? ` ${review.attention.unclear}` : ""}</p>
    </>}

    {review.ratio && <p className="review-note">{t("实际用时是估计的 {{median}} 倍（中位数，近 {{days}} 天 {{count}} 件；四分位 {{p25}}–{{p75}}）。", { median: review.ratio.median, days: ESTIMATE_RATIO_DAYS, count: review.ratio.n, p25: review.ratio.p25, p75: review.ratio.p75 })}</p>}

    {(review.night.own > 0 || review.night.held > 0) && <p className="review-note">
      {t("深夜（{{from}}–{{until}} 点）：你自己发出 {{own}} 件，其中不可撤回 {{irreversible}} 件；Crossline 停下等早上确认的表单 {{held}} 件。", { from: NIGHT_HOURS.from, until: NIGHT_HOURS.until, own: review.night.own, irreversible: review.night.ownIrreversible, held: review.night.held })}</p>}

    {review.parked.length > 0 && <>
      <h3 className="review-week-head">{t("停放的里程碑")}</h3>
      <ul className="review-list">{review.parked.map((item) => <li key={item.id}><b>{item.title}</b>{item.unparkWhen ? <span className="muted"> {t("等「{{after}}」完成", { after: item.unparkWhen })}</span> : null}</li>)}</ul>
    </>}

    {review.overrides.length > 0 && <>
      <h3 className="review-week-head">{t("本周推翻的判定")}</h3>
      <ul className="review-list">{review.overrides.map((item) => <li key={`${item.at}${item.title}`}><b>{item.gate}</b> {item.title}：{item.from} → {item.to}{item.note ? <span className="muted"> {item.note}</span> : null}</li>)}</ul>
    </>}

    <h3 className="review-week-head">{t("记一次挫折")}</h3>
    <SetbackReport />
  </section>;
}
