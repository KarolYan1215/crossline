"use client";

import type { CSSProperties, ReactNode } from "react";
import { CalendarCheck, Clock, Flag, Gauge, TriangleAlert } from "lucide-react";
import { lineShareRows, type CapacityWeek, type EstimatePoint, type LineShareRow, type PlanKpis, type UnplacedItem } from "../../lib/plan-stats";
import { ICON } from "../ui/icon-button";
import { Sheet } from "../ui/overlay";
import { LineTag } from "../ui/tag";
import { EstimateChart } from "./plan-stats-charts";
import { hours, md } from "./chart-geometry";
import { usePlanPreview } from "./preview-context";
import { useT } from "../locale-context";

/**
 * The plan page's head (2026-10-28 redesign, docs/plans/page-drafts-1028/plan.html): four figures, then what the schedule could not place
 * with why, and each line against its share of the coming weeks. Every figure links to where it is dealt with; nothing here decides.
 */

function Kpi({ icon, label, value, unit, note, alarm, children }: { icon: ReactNode; label: string; value: ReactNode; unit?: string | undefined; note?: ReactNode;
  alarm?: boolean; children?: ReactNode }) {
  return <section className="pl-kpi" data-alarm={alarm || undefined} aria-label={label}>
    <span className="pl-kpi-label">{icon}{label}</span>
    <b className="pl-kpi-value"><span className="ds-serif">{value}</span>{unit && <small>{unit}</small>}</b>
    {children}
    {note && <small className="pl-kpi-note">{note}</small>}
  </section>;
}

/**
 * 本周可用 / 本周已排 / 未排进 / 估时偏差. The bias is a summary of 系统体检 (Settings), its own home; the scatter behind it opens in place
 * once anything was timed, and with nothing timed the figure says so in a word instead of drawing an empty card.
 */
export function PlanKpiRow({ kpis, configuredWeekly, estimates, labels }: { kpis: PlanKpis; configuredWeekly: number;
  estimates: { points: EstimatePoint[]; covered: number; coverage: number | null }; labels: Record<string, string> }) {
  const t = useT();
  const share = kpis.usableMinutes ? Math.min(100, Math.round(kpis.scheduledMinutes / kpis.usableMinutes * 100)) : 0;
  return <div className="pl-kpis">
    <Kpi icon={<Clock {...ICON} />} label={t("本周可用")} value={hours(kpis.usableMinutes)} unit="h"
      note={t("可用时段每周 {{n}} h，扣除日历与预留", { n: configuredWeekly })} />
    <Kpi icon={<CalendarCheck {...ICON} />} label={t("本周已排")} value={hours(kpis.scheduledMinutes)} unit={`/ ${hours(kpis.usableMinutes)} h`}>
      <span className="pl-kpi-bar" aria-hidden="true"><i style={{ "--pct": `${share}%` } as CSSProperties} /></span>
    </Kpi>
    <Kpi icon={<TriangleAlert {...ICON} />} label={t("未排进")} value={kpis.unplaced.count} unit={kpis.unplaced.count ? t("项 · {{n}} h", { n: hours(kpis.unplaced.minutes) }) : t("项")}
      alarm={kpis.unplaced.count > 0}
      note={kpis.unplaced.count ? <a href="#why">{kpis.unplaced.earliest ? t("最早截止 {{day}} · 看原因", { day: md(kpis.unplaced.earliest) }) : t("看原因")}</a> : t("全部排进")} />
    <Kpi icon={<Gauge {...ICON} />} label={t("估时偏差")} value={kpis.bias ? `${kpis.bias.percent > 0 ? "+" : ""}${kpis.bias.percent}` : "—"} unit={kpis.bias ? "%" : undefined}
      note={kpis.bias ? <>{t("实测 {{count}} 次，中位数", { count: kpis.bias.samples })}{" · "}
        <Sheet title={t("估时准确度")} trigger={<button type="button" className="text-button">{t("散点")}</button>}>
          <EstimateChart estimates={estimates} labels={labels} /></Sheet>{" · "}<a href="/settings#usage">{t("详情在系统体检")}</a></>
        : <>{t("尚无实测")} · <a href="/settings#usage">{t("系统体检")}</a></>} />
  </div>;
}

/**
 * 「排不下的原因」 (decided 2026-10-28, scenarios.md §3 conclusion 3): each task the schedule could not place, with the planner's reason.
 * Its one action is more hours (the grid below); what to push or drop this week is the weekly commitment's, linked at the foot.
 */
export function UnplacedCard({ items, labels, today }: { items: UnplacedItem[]; labels: Record<string, string>; today: string }) {
  const t = useT();
  const reason = (item: UnplacedItem) => item.reason ?? (item.notBefore && item.notBefore > today ? t("{{day}} 前不可开始", { day: md(item.notBefore) })
    : item.partial ? t("部分步骤未排入") : t("可用时段内没有空位"));
  return <section className="pl-card pl-unplaced" id="why" aria-labelledby="pl-unplaced-title">
    <header><h2 id="pl-unplaced-title" className="ds-serif">{t("排不下的原因")}</h2>{items.length > 0 && <span className="pl-count">{items.length}</span>}</header>
    {!items.length ? <p className="pl-empty">{t("统计范围内的任务都排进了可用时段。")}</p>
      : <ul className="pl-unplaced-list">{items.map((item) => <li key={item.id} data-line={item.line}>
        <div>
          <a className="pl-unplaced-title" href={`/workbench/${encodeURIComponent(item.id)}`}>{item.title}</a>
          <p className="pl-unplaced-meta"><LineTag line={item.line}>{labels[item.line] ?? item.line}</LineTag>
            <span className="mono">{hours(item.minutes)} h</span>
            {item.deadline && <span className="mono"><Flag {...ICON} width={14} height={14} />{t("截止 {{day}}", { day: md(item.deadline) })}</span>}
            {item.partial && item.reason && <span>{t("部分已排")}</span>}</p>
          <p className="pl-unplaced-reason">{reason(item)}</p>
        </div>
        <a className="ds-icon pl-add-time" href="#time" aria-label={t("加时段：在下方周表里刷涂更多可用时段")} title={t("加时段")}><Clock {...ICON} /></a>
      </li>)}</ul>}
    <p className="pl-card-foot"><a href="/commit">{t("本周内排不下的推或砍，去本周承诺 →")}</a></p>
  </section>;
}

/**
 * 「各线排程 vs 份额」 over the coming weeks (decided 2026-10-28: the look back moved to the weekly review). Each line's share of the
 * usable hours as a light bar, the hours a week planned for it as a solid one in its colour; while a change is previewed, the planned
 * bar is the after-state with the current figure as a dashed ghost.
 */
export function LineShareChart({ capacity, shares, lineOrder, labels }: { capacity: CapacityWeek[]; shares: Record<string, number>; lineOrder: string[];
  labels: Record<string, string> }) {
  const t = useT();
  const preview = usePlanPreview();
  const weeks = Math.min(4, capacity.length);
  const rows: LineShareRow[] = lineShareRows({ capacity: preview?.after.capacity ?? capacity, shares, lineOrder, weeks,
    before: preview ? preview.before.capacity : null });
  const peak = Math.max(60, ...rows.flatMap((row) => [row.shareMinutes, row.plannedMinutes, row.beforeMinutes ?? 0]));
  const width = (minutes: number) => `${Math.round(minutes / peak * 1000) / 10}%`;
  return <section className="pl-card pl-shares-chart" aria-labelledby="pl-shares-title">
    <header><h2 id="pl-shares-title" className="ds-serif">{t("各线排程 vs 份额")}</h2><small>{t("未来 {{count}} 周 · 每周小时", { count: weeks })}</small></header>
    {!rows.length ? <p className="pl-empty">{t("还没有设份额，也没有排程。")}</p>
      : <ul className="pl-share-rows">{rows.map((row) => <li key={row.line} data-line={row.line}
        aria-label={t("{{line}}：份额 {{share}} 小时，计划 {{planned}} 小时", { line: labels[row.line] ?? row.line, share: hours(row.shareMinutes), planned: hours(row.plannedMinutes) })}>
        <span className="pl-share-name">{labels[row.line] ?? row.line}</span>
        <span className="pl-share-bars">
          <span className="pl-share-bar" data-k="share" style={{ width: width(row.shareMinutes) }} title={t("份额 {{n}}%，约 {{h}} 小时/周", { n: row.share, h: hours(row.shareMinutes) })} />
          <span className="pl-share-bar" data-k="planned" style={{ width: width(row.plannedMinutes) }}
            title={t("计划 {{h}} 小时/周，其中已排 {{s}} 小时", { h: hours(row.plannedMinutes), s: hours(row.scheduledMinutes) })} />
          {row.beforeMinutes !== null && row.beforeMinutes !== row.plannedMinutes && <span className="pl-share-ghost" style={{ width: width(row.beforeMinutes) }}
            title={t("改动前 {{h}} 小时/周", { h: hours(row.beforeMinutes) })} />}
        </span>
        <span className="pl-share-figures mono">{t("{{h}}h 份额", { h: hours(row.shareMinutes) })}<br />{t("{{h}}h 计划", { h: hours(row.plannedMinutes) })}</span>
      </li>)}</ul>}
    <p className="pl-legend"><span><span className="pl-key" data-k="share" />{t("份额")}</span><span><span className="pl-key" data-k="planned" />{t("计划（已排与待排）")}</span>
      {preview && <span><span className="pl-key" data-k="ghost" />{t("改动前")}</span>}</p>
    <p className="pl-card-foot"><a href="/review">{t("过去一周的计划与实际在「周复盘」→")}</a></p>
  </section>;
}
