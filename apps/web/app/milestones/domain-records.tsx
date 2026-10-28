"use client";

import { useState } from "react";
import type { RecordTrends } from "@crossline/core";
import { Sparkline } from "../ui/charts";
import { useLocale, useT } from "../locale-context";
import { intlLocale, type Locale, type Translate } from "../../lib/i18n";
import { monthLabel as monthName } from "../timeline/format";

/** One record as the card lists it (docs/domain-lines.md). */
export type RecordRow = { id: string; kind: string; at: string; value: number; unit: string; currency: string; category: string; source: string };
/** What a domain line's card shows: this month's money or this week's exercise and the latest weight, the trend behind them, and the last records. */
export type DomainRecordsCard = {
  domain: "wellness" | "wealth";
  month: string; currency: string; income: number; expense: number; savingsRate: number | null;
  categories: Array<{ category: string; amount: number }>;
  workouts: number; workoutMinutes: number; weight: { value: number; at: string } | null;
  /** Six months of money and eight weeks of exercise; drawn once two periods hold anything. */
  trends?: RecordTrends;
  recent: RecordRow[];
};

/** Kept in Chinese (they are the keys); translated where shown. */
const SOURCE: Record<string, string> = { input: "输入框", mail: "邮件", phone: "手机", confirm: "完成确认", photo: "截图" };
const KIND: Record<string, string> = { income: "收入", expense: "支出", refund: "退款", workout: "运动", weight: "体重", meal: "饮食", metric: "指标" };
const money = (locale: Locale, value: number) => value.toLocaleString(intlLocale(locale), { maximumFractionDigits: 2 });
/** 「10 月」 / "Oct" for a `YYYY-MM` month. */
const monthLabel = (locale: Locale, t: Translate, month: string) =>
  locale === "en" ? monthName(locale, Number(month.slice(0, 4)), Number(month.slice(5, 7))) : t("{{month}} 月", { month: Number(month.slice(5, 7)) });
const weekLabel = (start: string) => `${Number(start.slice(5, 7))}/${Number(start.slice(8, 10))}`;

type TrendColumn = { label: string; bars: Array<{ value: number; title: string; tone: "light" | "solid" }> };
/** Columns of vertical bars sharing one scale, one column per month or week, oldest first; every bar names its value on hover. */
function TrendColumns({ label, note, columns }: { label: string; note: string; columns: TrendColumn[] }) {
  const top = Math.max(1, ...columns.flatMap((column) => column.bars.map((bar) => bar.value)));
  // Eight week labels do not fit a narrow card: past six columns every other one is named, the newest always; the bars name themselves on hover.
  const named = (index: number) => columns.length <= 6 || (columns.length - 1 - index) % 2 === 0;
  return <figure className="lb-trend" aria-label={label}>
    <div className="lb-trend-columns">
      {columns.map((column, index) => <div className="lb-trend-col" key={column.label}>
        <div className="lb-trend-bars">
          {column.bars.map((bar, at) => <span key={at} className={`lb-trend-bar lb-trend-${bar.tone}`} style={{ height: `${Math.max(bar.value > 0 ? 2 : 0, Math.round(bar.value / top * 100))}%` }} title={bar.title} />)}
        </div>
        <span className="lb-trend-label muted">{named(index) ? column.label : ""}</span>
      </div>)}
    </div>
    <figcaption className="muted">{note}</figcaption>
  </figure>;
}

/** The trend under the month's or week's numbers: by month for money, by week for exercise, with the weight as a line (docs/domain-lines.md). */
function RecordTrend({ card }: { card: DomainRecordsCard }) {
  const t = useT();
  const locale = useLocale();
  const trends = card.trends;
  if (!trends) return null;
  if (card.domain === "wealth") {
    if (trends.months.filter((month) => month.income > 0 || month.expense > 0).length < 2) return null;
    return <TrendColumns label={t("近 6 个月收支")} note={t("近 6 个月：浅色收入，深色支出（{{currency}}）", { currency: trends.currency })}
      columns={trends.months.map((month) => ({ label: monthLabel(locale, t, month.month), bars: [
        { value: month.income, title: t("{{month}}收入 {{amount}}", { month: monthLabel(locale, t, month.month), amount: money(locale, month.income) }), tone: "light" },
        { value: month.expense, title: t("{{month}}支出 {{amount}}", { month: monthLabel(locale, t, month.month), amount: money(locale, month.expense) }), tone: "solid" }] }))} />;
  }
  const weeks = trends.weeks;
  const weights = weeks.filter((week) => week.weight !== null);
  const exercise = weeks.filter((week) => week.workouts > 0).length >= 2;
  if (!exercise && weights.length < 2) return null;
  return <>
    {exercise && <TrendColumns label={t("近 8 周运动")} note={t("近 8 周每周运动分钟（周一起算）")}
      columns={weeks.map((week) => ({ label: weekLabel(week.start), bars: [{ value: week.workoutMinutes,
        title: t("{{day}} 起的一周：运动 {{count}} 次 · {{minutes}} 分钟", { day: weekLabel(week.start), count: week.workouts, minutes: week.workoutMinutes }), tone: "solid" }] }))} />}
    {weights.length >= 2 && <p className="lb-records-line lb-trend-weight">
      <Sparkline values={weights.map((week) => week.weight!)} labels={weights.map((week) => t("{{day}} 起的一周", { day: weekLabel(week.start) }))} label={t("近 8 周体重")} unit=" kg" />
      <span className="muted">{t("体重 {{from}} → {{to}} kg（{{count}} 周）", { from: weights[0]!.weight, to: weights.at(-1)!.weight, count: weights.length })}</span>
    </p>}
  </>;
}

/**
 * The numbers on a 健康 / 财富 line card, read from its records (never a model's estimate): a wealth line's month — income, spending,
 * the savings rate and the three largest spending categories as bars — or a wellness line's week and latest weight, then the trend by
 * month or week. 「最近记录」 opens the last thirty with where each came from; a wrong one is removed (undoable from 待确认 「最近操作」).
 */
export function DomainRecords({ card }: { card: DomainRecordsCard }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const remove = async (id: string) => {
    setStatus(t("删除中…"));
    const response = await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) { setStatus(t("未删除，请重试")); return; }
    location.reload();
  };
  const largest = Math.max(1, ...card.categories.map((item) => item.amount));
  return <div className="lb-records">
    {card.domain === "wealth" ? <>
      <p className="lb-records-line"><span>{monthLabel(locale, t, card.month)}</span>
        <span>{t("收入 {{amount}}", { amount: money(locale, card.income) })}</span><span>{t("支出 {{amount}}", { amount: money(locale, card.expense) })}</span>
        <span>{card.savingsRate === null ? t("储蓄率 —") : t("储蓄率 {{n}}%", { n: card.savingsRate })}</span>
        {card.currency !== "CNY" && <span className="mono">{card.currency}</span>}</p>
      {card.categories.length > 0 && <ul className="lb-records-bars" aria-label={t("本月支出最多的类别")}>
        {card.categories.slice(0, 3).map((item) => <li key={item.category}>
          <span>{item.category}</span><span className="lb-records-bar" style={{ width: `${Math.round(item.amount / largest * 100)}%` }} aria-hidden="true" />
          <span className="mono">{money(locale, item.amount)}</span></li>)}
      </ul>}
      <a className="text-button lb-records-ledger" href="/ledger">{t("打开总账")}</a>
    </> : <p className="lb-records-line"><span>{t("近 7 天运动 {{count}} 次 · {{minutes}} 分钟", { count: card.workouts, minutes: card.workoutMinutes })}</span>
      <span>{card.weight ? t("体重 {{value}} kg（{{day}}）", { value: card.weight.value, day: card.weight.at.slice(5) }) : t("体重 —")}</span></p>}
    <RecordTrend card={card} />
    {card.recent.length > 0 ? <details open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>{t("最近记录（{{count}}）", { count: card.recent.length })}</summary>
      <ul className="lb-records-list">
        {card.recent.map((row) => <li key={row.id}>
          <span className="mono">{row.at.slice(5, 10)}</span>
          <span>{KIND[row.kind] ? t(KIND[row.kind]!) : row.kind}{row.category ? ` · ${row.category}` : ""}</span>
          <span className="mono">{row.kind === "income" || row.kind === "expense" || row.kind === "refund" ? `${money(locale, row.value)} ${row.currency}` : `${row.value} ${row.unit}`}</span>
          <small className="muted">{SOURCE[row.source] ? t(SOURCE[row.source]!) : row.source}</small>
          <button type="button" className="text-button" aria-label={t("删除 {{day}} 的这条记录", { day: row.at.slice(5, 10) })} onClick={() => void remove(row.id)}>{t("删除")}</button>
        </li>)}
      </ul>
      {status && <small role="status">{status}</small>}
    </details> : <small className="muted">{t("还没有记录：在输入框说「午饭 35」「跑步 30 分钟」，或在设置里接入邮箱与手机。")}</small>}
  </div>;
}
