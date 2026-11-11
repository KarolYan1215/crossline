"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCOUNT_CLASS_LABEL, ASSET_CLASSES, HOLDING_CLASSES, LIABILITY_CLASSES, type AccountClass, type NetWorthPoint } from "@crossline/core";
import type { WealthView } from "../../lib/wealth";
import { useLocale, useT } from "../locale-context";
import { intlLocale } from "../../lib/i18n";

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
  const response = await fetch("/api/wealth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try { return await response.json() as { ok: boolean; message?: string }; } catch { return { ok: response.ok }; }
}

const SOURCE: Record<string, string> = { person: "本人记的", assistant: "小帮手记的", valuation: "按行情估值", longbridge: "长桥行情", coingecko: "CoinGecko", ecb: "欧洲央行" };

/**
 * 资产与负债 (docs/ledger-wealth.md): net worth now and over time, what it is made of, and every account with its last balance and how
 * old it is. Two hues only — assets and liabilities (validated for colour-blind separation in both modes); every bar carries its number.
 */
export function WealthBoard({ view }: { view: WealthView }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const nf = (value: number, digits = 0) => value.toLocaleString(intlLocale(locale), { maximumFractionDigits: digits });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setError("");
    try { const result = await post(body); if (result.ok) router.refresh(); else setError(result.message ?? t("没有保存，请检查填写的内容")); } finally { setBusy(false); }
  };
  const live = view.accounts.filter((item) => !item.account.archivedAt);
  const archived = view.accounts.filter((item) => item.account.archivedAt);
  const previous = view.series.at(-2);
  const change = previous ? view.now.net - previous.net : null;

  return <section className="lg-wealth" id="wealth" aria-labelledby="lg-wealth-title">
    <header className="lg-wealth-head">
      <h2 id="lg-wealth-title">{t("资产与负债")}</h2>
      <label className="lg-month">{t("本位币")}
        <select value={view.base} disabled={busy} onChange={(event) => void act({ action: "base_currency", currency: event.target.value })}>
          {view.currencies.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
      <p className="lg-muted">{view.rateDay ? t("汇率：欧洲央行参考汇率，{{day}}", { day: view.rateDay }) : t("还没有汇率：联网后每天取一次；没有汇率的币种单独列出，不折算。")}
        {!view.baseChosen && ` ${t("（本位币按所在时区推断，可改）")}`}</p>
    </header>

    {live.length > 0 && <dl className="lg-stats">
      <div><dt>{t("净资产")}</dt><dd>{nf(view.now.net)} <small>{view.base}</small></dd></div>
      <div><dt>{t("资产")}</dt><dd>{nf(view.now.assets)} <small>{view.base}</small></dd></div>
      <div><dt>{t("负债")}</dt><dd>{nf(view.now.liabilities)} <small>{view.base}</small></dd></div>
      <div><dt>{t("较上月末")}</dt><dd>{change === null ? "—" : `${change >= 0 ? "+" : "−"}${nf(Math.abs(change))}`}</dd></div>
    </dl>}
    {view.now.unconverted > 0 && <p className="lg-muted">{t("{{count}} 个账户的币种没有汇率，未计入合计。", { count: view.now.unconverted })}</p>}

    {live.length > 0 && <div className="lg-grid">
      <section className="lg-card lg-wide">
        <h3>{t("净资产走势")}</h3>
        {view.series.length >= 2 ? <NetWorthChart series={view.series} base={view.base} nf={nf} />
          : <p className="lg-muted">{t("记满两个月的余额后画出走势；每个点是月末各账户最后一次记下的数。")}</p>}
      </section>
      <section className="lg-card lg-wide">
        <h3>{t("构成")}</h3>
        <Composition point={view.now} base={view.base} nf={nf} />
      </section>
    </div>}

    <section className="lg-card lg-wide">
      <h3>{t("账户")}</h3>
      {live.length > 0 ? <ul className="lg-accounts">{live.map((item) => <AccountRow key={item.account.id} item={item} view={view} busy={busy} act={act} nf={nf} />)}</ul>
        : <p className="lg-muted">{t("还没有账户。加一个现金、券商、加密资产或负债账户，每月记一次余额；券商和加密资产也可以记持仓，按每日行情估值。")}</p>}
      {error && <p className="lg-error" role="alert">{error}</p>}
      <AddAccount view={view} busy={busy} act={act} />
      {archived.length > 0 && <details className="lg-archived"><summary>{t("已归档 {{count}} 个", { count: archived.length })}</summary>
        <ul className="lg-list">{archived.map((item) => <li key={item.account.id}>{item.account.name}
          <button type="button" disabled={busy} onClick={() => void act({ action: "account_archive", id: item.account.id, archived: false })}>{t("恢复")}</button></li>)}</ul>
      </details>}
      <p className="lg-muted">{t("不连银行：余额只来自本人记的数，券商和加密资产按每日行情估值。这里只记数字，不给买卖建议。")}</p>
    </section>
  </section>;
}

/** Net worth over the months: one line with a light wash under it, the last value labelled, a crosshair and tooltip on hover. */
function NetWorthChart({ series, base, nf }: { series: NetWorthPoint[]; base: string; nf: (value: number, digits?: number) => string }) {
  const t = useT();
  const locale = useLocale();
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the plot's own width, so the axis text stays 11px on a phone instead of shrinking with a fixed viewBox.
  const plot = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const element = plot.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const width = Math.round(entry?.contentRect.width ?? 0); if (width > 0) setW(width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const narrow = W < 480;
  const H = narrow ? 180 : 200, left = 44, right = 12, top = 12, bottom = 24;
  const labels = narrow ? 4 : 8;
  const values = series.map((point) => point.net);
  const lo = Math.min(0, ...values), hi = Math.max(1, ...values);
  const step = niceStep((hi - lo) / 3);
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step;
  const x = (index: number) => left + (index / Math.max(1, series.length - 1)) * (W - left - right);
  const y = (value: number) => top + (1 - (value - min) / Math.max(1, max - min)) * (H - top - bottom);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step);
  const compact = (value: number) => value.toLocaleString(intlLocale(locale), { notation: Math.abs(max) >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });
  const line = series.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.net).toFixed(1)}`).join(" ");
  const area = `${line} L${x(series.length - 1).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(min, 0)).toFixed(1)} Z`;
  const last = series.at(-1)!;
  const shown = hover === null ? null : series[hover]!;
  const pick = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = ((event.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(((at - left) / (W - left - right)) * (series.length - 1)))));
  };
  return <figure className="lg-nw">
    <div className="lg-nw-plot" ref={plot}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("净资产走势，最新 {{value}} {{currency}}", { value: nf(last.net), currency: base })}
        onPointerMove={pick} onPointerLeave={() => setHover(null)}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={left} x2={W - right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "lg-nw-zero" : "lg-nw-grid"} />
          <text x={left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="lg-nw-tick">{compact(tick)}</text>
        </g>)}
        <path d={area} className="lg-nw-area" />
        <path d={line} className="lg-nw-line" />
        {series.map((point, index) => (index === 0 || index === series.length - 1 || series.length <= labels || (index % Math.ceil(series.length / labels) === 0 && series.length - 1 - index >= Math.ceil(series.length / labels) / 2))
          && <text key={point.day} x={x(index)} y={H - 6} textAnchor={index === 0 ? "start" : index === series.length - 1 ? "end" : "middle"} className="lg-nw-tick">
            {point.day.slice(2, 7).replace("-", "/")}</text>)}
        <circle cx={x(series.length - 1)} cy={y(last.net)} r={4} className="lg-nw-dot" />
        {shown && <g>
          <line x1={x(hover!)} x2={x(hover!)} y1={top} y2={H - bottom} className="lg-nw-cross" />
          <circle cx={x(hover!)} cy={y(shown.net)} r={4} className="lg-nw-dot" />
        </g>}
      </svg>
      {shown && <div className="lg-nw-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
        <strong>{shown.day}</strong>
        <span>{t("净资产 {{value}}", { value: nf(shown.net) })}</span>
        <span>{t("资产 {{value}} · 负债 {{debt}}", { value: nf(shown.assets), debt: nf(shown.liabilities) })}</span>
      </div>}
    </div>
    <figcaption className="lg-muted">{t("{{currency}}；月末取各账户最后一次记下的余额，没有新数的账户沿用上次。", { currency: base })}</figcaption>
    <table className="sr-only"><caption>{t("净资产走势")}</caption><thead><tr><th>{t("日期")}</th><th>{t("净资产")}</th><th>{t("资产")}</th><th>{t("负债")}</th></tr></thead>
      <tbody>{series.map((point) => <tr key={point.day}><td>{point.day}</td><td>{point.net}</td><td>{point.assets}</td><td>{point.liabilities}</td></tr>)}</tbody></table>
  </figure>;
}

function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
}

/** What net worth is made of: assets by class and liabilities by class, one shared scale, each bar with its amount and share. */
function Composition({ point, base, nf }: { point: NetWorthPoint; base: string; nf: (value: number, digits?: number) => string }) {
  const t = useT();
  const rows = (classes: readonly AccountClass[], total: number) => classes.map((name) => ({ name, value: point.byClass[name] ?? 0 })).filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value).map((row) => ({ ...row, share: total > 0 ? Math.round(row.value / total * 100) : 0 }));
  const assets = rows(ASSET_CLASSES, point.assets), debts = rows(LIABILITY_CLASSES, point.liabilities);
  const top = Math.max(1, ...assets.map((row) => row.value), ...debts.map((row) => row.value));
  const bar = (row: { name: AccountClass; value: number; share: number }, kind: "asset" | "debt") => <li key={row.name} className="lg-comp-row"
    title={t("{{name}}：{{value}} {{currency}}，占{{kind}} {{share}}%", { name: t(ACCOUNT_CLASS_LABEL[row.name]), value: nf(row.value), currency: base, kind: kind === "asset" ? t("资产") : t("负债"), share: row.share })}>
    <span className="lg-comp-label">{t(ACCOUNT_CLASS_LABEL[row.name])}</span>
    <span className="lg-comp-track"><span className="lg-comp-fill" data-kind={kind} style={{ width: `${(row.value / top) * 100}%` }} /></span>
    <span className="lg-comp-value mono">{nf(row.value)} <small>{row.share}%</small></span>
  </li>;
  return <div className="lg-comp">
    <div><h4><span className="lg-swatch" data-kind="asset" />{t("资产")} {nf(point.assets)}</h4>
      {assets.length ? <ul>{assets.map((row) => bar(row, "asset"))}</ul> : <p className="lg-muted">{t("还没有资产余额")}</p>}</div>
    <div><h4><span className="lg-swatch" data-kind="debt" />{t("负债")} {nf(point.liabilities)}</h4>
      {debts.length ? <ul>{debts.map((row) => bar(row, "debt"))}</ul> : <p className="lg-muted">{t("没有负债")}</p>}
      {point.assets > 0 && point.liabilities > 0 && <p className="lg-muted">{t("负债是资产的 {{pct}}%", { pct: Math.round(point.liabilities / point.assets * 100) })}</p>}</div>
  </div>;
}

type Act = (body: Record<string, unknown>) => Promise<void>;

function AccountRow({ item, view, busy, act, nf }: { item: WealthView["accounts"][number]; view: WealthView; busy: boolean; act: Act; nf: (value: number, digits?: number) => string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [on, setOn] = useState(view.today);
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const { account } = item;
  const stale = view.stale.includes(account.id);
  const holdsPositions = HOLDING_CLASSES.includes(account.accountClass);
  return <li className="lg-account" data-liability={item.liability || undefined}>
    <div className="lg-account-main">
      <span className="lg-account-name">{account.name}<small>{t(ACCOUNT_CLASS_LABEL[account.accountClass])} · {account.currency}</small></span>
      <span className="lg-account-value mono">{item.native === null ? "—" : `${item.liability ? "−" : ""}${nf(item.native, 2)}`}
        {item.base !== null && account.currency !== view.base && <small>≈ {nf(item.base)} {view.base}</small>}</span>
      <span className="lg-account-age">{item.asOf ? t("{{day}}（{{days}} 天前）", { day: item.asOf, days: item.ageDays ?? 0 }) : t("还没有余额")}
        {stale && <span className="lg-flag">{t("本月未更新")}</span>}</span>
      <button type="button" className="lg-row-more" aria-expanded={open} onClick={() => setOpen(!open)}>{t("更新")}</button>
    </div>
    {open && <div className="lg-account-detail">
      {!item.valued && <form className="lg-inline" onSubmit={(event) => { event.preventDefault(); void act({ action: "snapshot", accountId: account.id, on, value }).then(() => setValue("")); }}>
        <label>{item.liability ? t("欠款") : t("余额")} <input type="number" inputMode="decimal" min="0" step="any" required value={value} onChange={(event) => setValue(event.target.value)} /></label>
        <label>{t("日期")} <input type="date" max={view.today} value={on} onChange={(event) => setOn(event.target.value)} /></label>
        <button type="submit" disabled={busy}>{t("记下")}</button>
      </form>}
      {holdsPositions && <>
        {item.holdings.length > 0 && <table className="lg-table lg-holdings"><thead><tr><th>{t("代码")}</th><th>{t("数量")}</th><th>{t("价格")}</th><th>{t("市值")}</th><th /></tr></thead>
          <tbody>{item.holdings.map((holding) => <tr key={holding.id}>
            <td>{holding.symbol}</td><td className="mono">{nf(holding.quantity, 8)}</td>
            <td className="mono">{holding.valuePrice === null ? t("缺价格") : `${nf(holding.valuePrice, 4)} ${holding.valueCurrency}`}
              {holding.priceOn && <small className="lg-muted"> {t("{{day}} · {{source}}", { day: holding.priceOn, source: t(SOURCE[holding.priceSource] ?? holding.priceSource) })}</small>}
              {holding.priceStale && <span className="lg-flag">{t("价格停在 {{day}}，已过期，不计入估值", { day: holding.priceOn })}</span>}</td>
            <td className="mono">{holding.value === null ? "—" : nf(holding.value, 2)}</td>
            <td><button type="button" disabled={busy} onClick={() => void act({ action: "holding_delete", id: holding.id })}>{t("删除")}</button></td>
          </tr>)}</tbody></table>}
        <form className="lg-inline" onSubmit={(event) => { event.preventDefault(); void act({ action: "holding", accountId: account.id, symbol, quantity, price }).then(() => { setSymbol(""); setQuantity(""); setPrice(""); }); }}>
          <label>{t("代码")} <input value={symbol} required placeholder={account.accountClass === "crypto" ? "BTC" : "AAPL.US"} onChange={(event) => setSymbol(event.target.value)} /></label>
          <label>{t("数量")} <input type="number" inputMode="decimal" min="0" step="any" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label>{t("自填价格（可空）")} <input type="number" inputMode="decimal" min="0" step="any" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
          <button type="submit" disabled={busy}>{t("记持仓")}</button>
        </form>
        <p className="lg-muted">{account.accountClass === "crypto" ? t("BTC、ETH 等常见币每天取 CoinGecko 价格；其他币按自填价格估值。")
          : t("代码带市场后缀（.US / .HK / .SH / .SZ）。每天用长桥的只读行情估值（需要在 ChatGPT 里连上长桥）；没有行情时用自填价格。")}</p>
      </>}
      <div className="lg-actions">
        <button type="button" disabled={busy} onClick={() => void act({ action: "account_archive", id: account.id, archived: true })}>{t("归档（不再计入）")}</button>
        <button type="button" disabled={busy} onClick={() => void act({ action: "account_delete", id: account.id })}>{t("删除账户和它的记录")}</button>
      </div>
    </div>}
  </li>;
}

function AddAccount({ view, busy, act }: { view: WealthView; busy: boolean; act: Act }) {
  const t = useT();
  const [name, setName] = useState("");
  const [accountClass, setAccountClass] = useState<AccountClass>("cash");
  const [currency, setCurrency] = useState(view.base);
  return <form className="lg-inline lg-add" onSubmit={(event) => { event.preventDefault(); void act({ action: "account_add", name, accountClass, currency, note: "" }).then(() => setName("")); }}>
    <label>{t("账户名")} <input value={name} required maxLength={60} placeholder={t("例如 招行储蓄")} onChange={(event) => setName(event.target.value)} /></label>
    <label>{t("类别")} <select value={accountClass} onChange={(event) => setAccountClass(event.target.value as AccountClass)}>
      <optgroup label={t("资产")}>{ASSET_CLASSES.map((name) => <option key={name} value={name}>{t(ACCOUNT_CLASS_LABEL[name])}</option>)}</optgroup>
      <optgroup label={t("负债")}>{LIABILITY_CLASSES.map((name) => <option key={name} value={name}>{t(ACCOUNT_CLASS_LABEL[name])}</option>)}</optgroup>
    </select></label>
    <label>{t("币种")} <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
      {view.currencies.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
    <button type="submit" disabled={busy}>{t("加账户")}</button>
  </form>;
}
