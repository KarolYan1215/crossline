"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LedgerRow, LedgerView } from "../../lib/ledger";
import { useLocale, useT } from "../locale-context";
import { intlLocale } from "../../lib/i18n";
import { BarChart } from "../ui/charts";

/** Kept in Chinese (they are keys); translated where shown. */
const SOURCE: Record<string, string> = { mail: "邮件", phone: "手机", input: "输入框", photo: "截图", confirm: "完成确认" };
const ROLE: Record<string, string> = { charge: "扣款提醒", receipt: "收据", refund: "退款", income: "到账", phone: "手机通知", input: "本人记的", photo: "截图", shipping: "发货" };
const KIND: Record<string, string> = { income: "收入", expense: "支出", refund: "退款" };
const CYCLE: Record<string, string> = { weekly: "每周", monthly: "每月", yearly: "每年" };
const INSTRUMENT: Record<string, string> = { card: "卡", paypal: "PayPal", alipay: "支付宝", wechat: "微信", bank: "银行", apple: "Apple", google: "Google" };

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

async function post(body: Record<string, unknown>): Promise<boolean> {
  const response = await fetch("/api/ledger", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.ok;
}

/** The ledger page (docs/mail-bookkeeping.md §5.2): the month's numbers, five charts, the recurring charges, the list and what waits. */
export function LedgerBoard({ view }: { view: LedgerView }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const fmt = (value: number) => value.toLocaleString(intlLocale(locale), { maximumFractionDigits: 2 });
  const { summary } = view;
  const cur = summary.currency;
  const [filter, setFilter] = useState<{ category: string; day: string; account: string; source: string; pending: boolean }>({ category: "", day: "", account: "", source: "", pending: false });
  const [busy, setBusy] = useState(false);
  const act = async (body: Record<string, unknown>) => { setBusy(true); try { if (await post(body)) router.refresh(); } finally { setBusy(false); } };
  const remove = async (id: string) => { setBusy(true); try { if ((await fetch(`/api/records?id=${encodeURIComponent(id)}`, { method: "DELETE" })).ok) router.refresh(); } finally { setBusy(false); } };
  const rows = useMemo(() => view.rows.filter((row) => (!filter.category || row.category === filter.category) && (!filter.day || row.at === filter.day)
    && (!filter.account || row.account === filter.account) && (!filter.source || row.source === filter.source) && (!filter.pending || row.status === "pending_review")),
  [view.rows, filter]);
  const accountLabel = (account: string) => account ? account.replace(/^(\w+)/, (word) => t(INSTRUMENT[word] ?? word)) : t("未注明");

  if (!view.hasRecords) return <section className="lg-empty">
    <p>{t("还没有任何记账。接入邮箱并打开「自动记账」，或在手机上设好钱包与付款通知，钱动了就会自动记下。")}</p>
    <a href="/settings#mail">{t("去接入邮箱")}</a>
  </section>;

  const pace = summary.pace.changePct;
  return <div className="lg" data-line="investment">
    <header className="lg-head">
      <label className="lg-month">{t("月份")}
        <select value={view.month} onChange={(event) => router.push(`/ledger?month=${event.target.value}`)}>
          {view.months.map((month) => <option key={month} value={month}>{month}</option>)}
        </select>
      </label>
      <dl className="lg-stats">
        <div><dt>{t("已花")}</dt><dd>{fmt(summary.spent)} <small>{cur}</small></dd></div>
        <div><dt>{t("收入")}</dt><dd>{fmt(summary.income)} <small>{cur}</small></dd></div>
        <div><dt>{t("净额")}</dt><dd>{fmt(summary.net)} <small>{cur}</small></dd></div>
        <div><dt>{t("储蓄率")}</dt><dd>{summary.savingsRate === null ? "—" : `${fmt(summary.savingsRate)}%`}</dd></div>
      </dl>
      {pace !== null && <p className="lg-pace">{pace >= 0
        ? t("到 {{day}} 日比上月同期多花 {{pct}}%", { day: summary.pace.day, pct: fmt(Math.round(pace)) })
        : t("到 {{day}} 日比上月同期少花 {{pct}}%", { day: summary.pace.day, pct: fmt(Math.round(-pace)) })}</p>}
      {summary.others.length > 0 && <p className="lg-others">{t("其他币种：")}{summary.others.map((item) => t("{{currency}} 花 {{spent}}、收 {{income}}", { currency: item.currency, spent: fmt(item.spent), income: fmt(item.income) })).join(t("；"))}</p>}
    </header>

    <div className="lg-grid">
      <section className="lg-card lg-wide">
        <h3>{t("本月累计支出")}</h3>
        <Cumulative view={view} fmt={fmt} />
      </section>

      <section className="lg-card">
        <h3>{t("分类")}</h3>
        <Categories view={view} fmt={fmt} active={filter.category} onPick={(category) => setFilter((old) => ({ ...old, category: old.category === category ? "" : category }))} />
      </section>

      <section className="lg-card">
        <h3>{t("每日花费")}</h3>
        <Calendar view={view} fmt={fmt} active={filter.day} onPick={(day) => setFilter((old) => ({ ...old, day: old.day === day ? "" : day }))} />
      </section>

      <section className="lg-card lg-wide">
        <h3>{t("近 12 个月收支")}</h3>
        <Months view={view} fmt={fmt} />
      </section>

      <section className="lg-card">
        <h3>{t("商户前 10 名")}</h3>
        {summary.merchants.length ? <BarChart label={t("商户前 10 名")} data={summary.merchants.map((item) => ({ label: item.merchant, value: item.amount, line: "investment",
          title: t("{{merchant}} {{amount}} {{currency}}，{{count}} 笔", { merchant: item.merchant, amount: fmt(item.amount), currency: cur, count: item.count }) }))} />
          : <p className="lg-muted">{t("本月还没有支出")}</p>}
      </section>

      <section className="lg-card">
        <h3>{t("账户")}</h3>
        {summary.accounts.length ? <table className="lg-table"><thead><tr><th>{t("账户")}</th><th>{t("支出")}</th><th>{t("收入")}</th></tr></thead>
          <tbody>{summary.accounts.map((item) => <tr key={item.account}><td>{accountLabel(item.account)}</td><td className="mono">{fmt(item.out)}</td><td className="mono">{fmt(item.in)}</td></tr>)}</tbody></table>
          : <p className="lg-muted">{t("本月还没有记录")}</p>}
        <p className="lg-muted">{t("没有接银行，所以只看进出，不显示余额。")}</p>
      </section>

      <section className="lg-card lg-wide">
        <h3>{t("周期扣费")}</h3>
        {view.recurring.length ? <>
          <table className="lg-table"><thead><tr><th>{t("商户")}</th><th>{t("周期")}</th><th>{t("每次")}</th><th>{t("年化")}</th><th>{t("下次")}</th><th /></tr></thead>
            <tbody>{view.recurring.map((item) => <tr key={`${item.merchant}|${item.currency}`}>
              <td>{item.merchant}</td><td>{t(CYCLE[item.cycle]!)}</td><td className="mono">{fmt(item.amount)} {item.currency}</td><td className="mono">{fmt(item.annual)}</td>
              <td>{item.next}</td><td>{item.priceUp && <span className="lg-flag">{t("涨价")}</span>}{item.resumed && <span className="lg-flag">{t("又开始扣费")}</span>}</td>
            </tr>)}</tbody></table>
          <p className="lg-muted">{t("周期扣费合计每年约 {{amount}}", { amount: fmt(view.recurring.filter((item) => item.currency === cur).reduce((total, item) => total + item.annual, 0)) })} {cur}</p>
        </> : <p className="lg-muted">{t("同一商户按周、月或年重复出现三次后会列在这里。")}</p>}
      </section>

      {view.pending.length > 0 && <section className="lg-card lg-wide lg-pending">
        <h3>{t("可能重复（不计入汇总）")}</h3>
        <ul>{view.pending.map(({ row, other }) => <li key={row.id}>
          <span>{t("{{day}} {{merchant}} {{amount}} {{currency}}（{{source}}）", { day: row.at, merchant: row.merchant || t(row.category), amount: fmt(row.value), currency: row.currency, source: t(SOURCE[row.source] ?? row.source) })}</span>
          {other && <span className="lg-muted">{t("可能与 {{day}} {{merchant}} {{amount}}（{{source}}）是同一笔", { day: other.at, merchant: other.merchant || t(other.category), amount: fmt(other.value), source: t(SOURCE[other.source] ?? other.source) })}</span>}
          <span className="lg-actions">
            <button type="button" disabled={busy} onClick={() => void act({ action: "duplicate", id: row.id, same: true })}>{t("是同一笔（合并）")}</button>
            <button type="button" disabled={busy} onClick={() => void act({ action: "duplicate", id: row.id, same: false })}>{t("是两笔")}</button>
          </span>
        </li>)}</ul>
      </section>}

      {view.anomalies.length > 0 && <section className="lg-card lg-wide">
        <h3>{t("值得留意")}</h3>
        <ul className="lg-list">{view.anomalies.map((item) => <li key={item.recordId}>{t("{{day}} {{merchant}} {{amount}}：{{why}}", { day: item.at, merchant: item.merchant, amount: fmt(item.value),
          why: item.reason === "large_for_merchant" ? t("比这个商户平时高三倍以上") : item.reason === "new_merchant_large" ? t("新商户第一笔就是大额") : t("比近 90 天绝大多数单笔都大") })}</li>)}</ul>
      </section>}

      <section className="lg-card lg-wide">
        <h3>{t("明细")}</h3>
        <div className="lg-filters">
          <select aria-label={t("分类")} value={filter.category} onChange={(event) => setFilter((old) => ({ ...old, category: event.target.value }))}>
            <option value="">{t("全部分类")}</option>
            {[...view.spendCategories, ...view.incomeCategories].map((category) => <option key={category} value={category}>{t(category)}</option>)}
          </select>
          <select aria-label={t("账户")} value={filter.account} onChange={(event) => setFilter((old) => ({ ...old, account: event.target.value }))}>
            <option value="">{t("全部账户")}</option>
            {[...new Set(view.rows.map((row) => row.account))].map((account) => <option key={account} value={account}>{accountLabel(account)}</option>)}
          </select>
          <select aria-label={t("来源")} value={filter.source} onChange={(event) => setFilter((old) => ({ ...old, source: event.target.value }))}>
            <option value="">{t("全部来源")}</option>
            {[...new Set(view.rows.map((row) => row.source))].map((source) => <option key={source} value={source}>{t(SOURCE[source] ?? source)}</option>)}
          </select>
          <label><input type="checkbox" checked={filter.pending} onChange={(event) => setFilter((old) => ({ ...old, pending: event.target.checked }))} /> {t("只看待确认")}</label>
          {(filter.day || filter.category) && <button type="button" onClick={() => setFilter({ category: "", day: "", account: "", source: "", pending: false })}>{t("清除筛选")}</button>}
        </div>
        <ul className="lg-rows">{rows.map((row) => <Row key={row.id} row={row} view={view} busy={busy} fmt={fmt} act={act} remove={remove} accountLabel={accountLabel} />)}</ul>
        {!rows.length && <p className="lg-muted">{t("没有符合条件的记录")}</p>}
      </section>

      {view.rules.length > 0 && <section className="lg-card lg-wide">
        <h3>{t("商户分类规则")}</h3>
        <ul className="lg-list">{view.rules.map((rule) => <li key={rule.merchantKey}>{t("{{merchant}} 记为「{{category}}」", { merchant: rule.merchantKey, category: t(rule.category) })}
          <button type="button" disabled={busy} onClick={() => void act({ action: "rule_delete", merchantKey: rule.merchantKey })}>{t("删除")}</button></li>)}</ul>
      </section>}
    </div>
  </div>;
}

function Row({ row, view, busy, fmt, act, remove, accountLabel }: { row: LedgerRow; view: LedgerView; busy: boolean; fmt: (value: number) => string;
  act: (body: Record<string, unknown>) => Promise<void>; remove: (id: string) => Promise<void>; accountLabel: (account: string) => string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState("");
  const categories = row.kind === "income" ? view.incomeCategories : view.spendCategories;
  const sign = row.kind === "income" ? "+" : row.kind === "refund" ? "−" : "";
  return <li className="lg-row" data-pending={row.status === "pending_review" || undefined}>
    <span className="lg-row-day">{row.at.slice(5)}</span>
    <span className="lg-row-who">{row.merchant || t(KIND[row.kind]!)}{row.status === "pending_review" && <span className="lg-flag">{t("待确认")}</span>}</span>
    <select aria-label={t("分类")} value={categories.includes(row.category) ? row.category : ""} disabled={busy}
      onChange={(event) => { setChanged(event.target.value); void act({ action: "category", id: row.id, category: event.target.value, everyFromMerchant: false }); }}>
      {!categories.includes(row.category) && <option value="">{t(row.category || "其他")}</option>}
      {categories.map((category) => <option key={category} value={category}>{t(category)}</option>)}
    </select>
    <span className="lg-row-amount mono" data-kind={row.kind}>{sign}{fmt(row.value)} <small>{row.currency}</small></span>
    <button type="button" className="lg-row-more" aria-expanded={open} onClick={() => setOpen(!open)}>{t("{{count}} 份证据", { count: Math.max(1, row.evidence.length) })}</button>
    {changed && row.merchantKey && <button type="button" className="lg-row-rule" disabled={busy}
      onClick={() => { void act({ action: "category", id: row.id, category: changed, everyFromMerchant: true }); setChanged(""); }}>
      {t("以后「{{merchant}}」都记为「{{category}}」", { merchant: row.merchant || row.merchantKey, category: t(changed) })}</button>}
    {open && <div className="lg-row-detail">
      <p>{t("账户：{{account}}", { account: accountLabel(row.account) })}{row.note && ` · ${row.note}`}</p>
      <ul>{row.evidence.map((piece) => <li key={piece.id}>
        {t("{{day}} · {{source}} · {{role}} · {{amount}}", { day: piece.at, source: t(SOURCE[piece.source] ?? piece.source), role: t(ROLE[piece.role] ?? piece.role), amount: fmt(piece.amount) })}
        {row.evidence.length > 1 && <button type="button" disabled={busy} onClick={() => void act({ action: "split", evidenceId: piece.id })}>{t("拆开")}</button>}
      </li>)}</ul>
      <button type="button" disabled={busy} onClick={() => void remove(row.id)}>{t("删除这笔")}</button>
    </div>}
  </li>;
}

/** Cumulative spending by day: this month solid, last month light, the three before as a dashed average; the limit and the projection when known. */
function Cumulative({ view, fmt }: { view: LedgerView; fmt: (value: number) => string }) {
  const t = useT();
  const { summary } = view;
  const days = daysIn(view.month);
  const top = Math.max(1, ...summary.cumulative.thisMonth, ...summary.cumulative.lastMonth, ...summary.cumulative.average3, summary.limit ?? 0, summary.projected ?? 0);
  const W = 600, H = 180;
  const x = (day: number) => ((day - 1) / Math.max(1, days - 1)) * W;
  const y = (value: number) => H - (value / top) * (H - 8) - 4;
  const path = (series: number[]) => series.map((value, index) => `${index ? "L" : "M"}${x(index + 1).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const now = summary.cumulative.thisMonth.length;
  const last = summary.cumulative.thisMonth.at(-1) ?? 0;
  return <figure className="lg-cum" aria-label={t("本月累计支出")}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      <path d={path(summary.cumulative.average3)} className="lg-avg"><title>{t("近 3 个月平均")}</title></path>
      <path d={path(summary.cumulative.lastMonth)} className="lg-last"><title>{t("上月：{{amount}}", { amount: fmt(summary.cumulative.lastMonth.at(-1) ?? 0) })}</title></path>
      {summary.limit !== null && <line x1={0} x2={W} y1={y(summary.limit)} y2={y(summary.limit)} className="lg-limit"><title>{t("月支出上限 {{amount}}", { amount: fmt(summary.limit) })}</title></line>}
      {summary.projected !== null && now > 0 && <line x1={x(now)} y1={y(last)} x2={x(days)} y2={y(summary.projected)} className="lg-proj"><title>{t("按当前速度月底约 {{amount}}", { amount: fmt(summary.projected) })}</title></line>}
      <path d={path(summary.cumulative.thisMonth)} className="lg-this"><title>{t("本月到今天：{{amount}}", { amount: fmt(last) })}</title></path>
    </svg>
    <figcaption className="lg-legend">
      <span className="lg-key lg-key-this">{t("本月")} {fmt(last)}</span>
      <span className="lg-key lg-key-last">{t("上月")} {fmt(summary.cumulative.lastMonth.at(-1) ?? 0)}</span>
      <span className="lg-key lg-key-avg">{t("近 3 个月平均")}</span>
      {summary.limit !== null && <span className="lg-key lg-key-limit">{t("上限")} {fmt(summary.limit)}</span>}
      {summary.projected !== null && <span className="lg-key lg-key-proj">{t("月底预计")} {fmt(summary.projected)}</span>}
    </figcaption>
  </figure>;
}

/** This month's categories as bars, each with a tick where last month's same category stood; a click filters the list. */
function Categories({ view, fmt, active, onPick }: { view: LedgerView; fmt: (value: number) => string; active: string; onPick: (category: string) => void }) {
  const t = useT();
  const items = view.summary.categories;
  if (!items.length) return <p className="lg-muted">{t("本月还没有支出")}</p>;
  const top = Math.max(1, ...items.map((item) => Math.max(item.amount, item.lastMonth)));
  return <ul className="lg-cats">{items.map((item) => <li key={item.category}>
    <button type="button" aria-pressed={active === item.category} onClick={() => onPick(item.category)}
      title={t("{{category}}：本月 {{amount}}，上月 {{last}}", { category: t(item.category), amount: fmt(item.amount), last: fmt(item.lastMonth) })}>
      <span className="lg-cat-label">{t(item.category)}</span>
      <span className="lg-cat-track"><span className="lg-cat-fill" style={{ width: `${(Math.max(0, item.amount) / top) * 100}%` }} />
        {item.lastMonth > 0 && <span className="lg-cat-tick" style={{ left: `${(item.lastMonth / top) * 100}%` }} />}</span>
      <span className="lg-cat-value mono">{fmt(item.amount)}</span>
    </button>
  </li>)}</ul>;
}

/** The month as a Monday-first grid, each day shaded by what was spent; a click filters the list to that day. */
function Calendar({ view, fmt, active, onPick }: { view: LedgerView; fmt: (value: number) => string; active: string; onPick: (day: string) => void }) {
  const t = useT();
  const days = view.summary.days;
  const top = Math.max(1, ...days.map((item) => item.amount));
  const lead = (new Date(`${view.month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const names = ["一", "二", "三", "四", "五", "六", "日"];
  return <div className="lg-cal" role="grid" aria-label={t("每日花费")}>
    {names.map((name) => <span key={name} className="lg-cal-head">{t(name)}</span>)}
    {Array.from({ length: lead }, (_, index) => <span key={`pad${index}`} />)}
    {days.map((item) => <button type="button" key={item.day} className="lg-cal-day" aria-pressed={active === item.day} disabled={item.day > view.today}
      style={{ ["--heat" as string]: String(Math.max(0, item.amount) / top) }}
      title={t("{{day}}：{{amount}}", { day: item.day, amount: fmt(item.amount) })} onClick={() => onPick(item.day)}>{Number(item.day.slice(8, 10))}</button>)}
  </div>;
}

/** Twelve months of income and spending side by side, one shared scale. */
function Months({ view, fmt }: { view: LedgerView; fmt: (value: number) => string }) {
  const t = useT();
  const months = view.summary.months;
  const top = Math.max(1, ...months.flatMap((item) => [item.income, item.expense]));
  return <figure className="lg-months" aria-label={t("近 12 个月收支")}>
    <div className="lg-months-cols">{months.map((item) => <div key={item.month} className="lg-months-col">
      <div className="lg-months-bars">
        <span className="lg-bar-in" style={{ height: `${(item.income / top) * 100}%` }} title={t("{{month}} 收入 {{amount}}", { month: item.month, amount: fmt(item.income) })} />
        <span className="lg-bar-out" style={{ height: `${(Math.max(0, item.expense) / top) * 100}%` }} title={t("{{month}} 支出 {{amount}}", { month: item.month, amount: fmt(item.expense) })} />
      </div>
      <span className="lg-months-label">{Number(item.month.slice(5, 7))}</span>
    </div>)}</div>
    <figcaption className="lg-legend"><span className="lg-key lg-key-in">{t("收入")}</span><span className="lg-key lg-key-out">{t("支出")}</span></figcaption>
  </figure>;
}
