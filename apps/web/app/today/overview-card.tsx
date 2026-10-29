"use client";

import type { CSSProperties, ReactNode } from "react";
import { usePendingView } from "../pending-badge";
import { useLocale, useT } from "../locale-context";
import { formatMinutes } from "../ui/controls";

function Cell({ href, label, value, title, alarm, children }: { href: string; label: string; value: ReactNode; title: string; alarm?: boolean; children?: ReactNode }) {
  return <li><a href={href} title={title} data-alarm={alarm || undefined}><span className="ov-label">{label}</span><b className="ov-value ds-serif">{value}</b>{children}</a></li>;
}

/**
 * 「今日概览」 (2026-10-28 redesign): four numbers, each a link to where it is dealt with — the hours still available today (the plan's
 * hours), the minutes of work due today (the calendar, with the load bar the head used to carry), what waits on 待确认 (the same shared
 * count as the badge, red while anything waits) and what was finished this week (the weekly review).
 */
export function OverviewCard({ availableMinutes, committedMinutes, weekCount }: { availableMinutes: number; committedMinutes: number; weekCount: number }) {
  const t = useT();
  const locale = useLocale();
  const pending = usePendingView()?.total;
  const load = availableMinutes > 0 ? Math.min(100, Math.round(committedMinutes / availableMinutes * 100)) : committedMinutes > 0 ? 100 : 0;
  return <section className="td-card ov" aria-labelledby="overview-title">
    <header className="td-card-head"><h2 id="overview-title" className="ds-serif">{t("今日概览")}</h2></header>
    <ul className="ov-grid">
      <Cell href="/plan#time" label={t("可用", { context: "today" })} value={formatMinutes(availableMinutes, locale)} title={t("今天还可用的时间，按可用时段扣掉日历")} />
      <Cell href="#calendar" label={t("待办", { context: "today" })} value={formatMinutes(committedMinutes, locale)} title={t("今天待办的分钟数，条形为占可用时间的比例")}>
        <span className="time-bar" aria-hidden="true"><span className="time-bar-fill" style={{ "--pct": `${load}%` } as CSSProperties} /></span></Cell>
      <Cell href="/approvals" label={t("待处理")} value={pending ?? "—"} alarm={Boolean(pending)} title={t("待确认：待决事项、任务提案、助手成果等")} />
      <Cell href="/review" label={t("本周完成")} value={t("{{count}} 件", { count: weekCount })} title={t("本周已完成的任务")} />
    </ul>
  </section>;
}
