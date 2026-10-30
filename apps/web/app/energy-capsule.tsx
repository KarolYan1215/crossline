"use client";

import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { EnergyProbe } from "./energy-probe";
import type { DashboardData } from "./dashboard-view";
import { useLocale, useT } from "./locale-context";
import { ICON, IconButton } from "./ui/icon-button";

const LEVEL = { low: "低", medium: "中", high: "高" } as const;
const SURE = { low: "把握低", medium: "把握中", high: "把握高" } as const;
type Curve = NonNullable<NonNullable<DashboardData["energyEstimate"]>["curve"]>;

const FROM = 360, TO = 1440, W = 320, H = 88;

/**
 * The day's curve as an SVG path and where now sits on it (the energy card's drawing). Alertness is mapped onto the height between a
 * little below the lower cut point and a little above the upper one, so the dashed lines between low, medium and high sit where the
 * calibration puts them. Exported for its test.
 */
export function curveGeometry(curve: Curve): { line: string; area: string; low: number; high: number; now?: { x: number; y: number } } {
  const values = curve.points.map((point) => point.alertness);
  const bottom = Math.min(...values, curve.low) - 0.6, top = Math.max(...values, curve.high) + 0.6;
  const x = (minute: number) => ((minute - FROM) / (TO - FROM)) * W;
  const y = (alertness: number) => H - ((alertness - bottom) / (top - bottom)) * H;
  const points = curve.points.map((point) => [x(point.minute), y(point.alertness)] as const);
  // Catmull-Rom through the half-hour readings, so the band reads as a curve and not as steps.
  let line = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const [p0, p1, p2, p3] = [points[index - 1] ?? points[index]!, points[index]!, points[index + 1]!, points[index + 2] ?? points[index + 1]!];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    line += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const area = `${line} L${points.at(-1)![0].toFixed(1)},${H} L${points[0]![0].toFixed(1)},${H} Z`;
  const nearest = curve.points.reduce((best, point) => Math.abs(point.minute - curve.nowMinute) < Math.abs(best.minute - curve.nowMinute) ? point : best, curve.points[0]!);
  const inDay = curve.nowMinute >= FROM && curve.nowMinute <= TO;
  return { line, area, low: y(curve.low), high: y(curve.high), ...(inDay ? { now: { x: x(curve.nowMinute), y: y(nearest.alertness) } } : {}) };
}

/**
 * 「今日精力」 (docs/energy-and-ecosystem.md §3.4; a card since 2026-10-28): the model's reading of now — the one the schedule uses — with
 * the first lines of its basis, or the person's own word from the last four hours; the day's curve from the same model with its cut
 * points (calibrated by the person's reports, the defaults until there are some) dashed across it; and what the day's capacity is held to. It asks nothing: the pencil opens the three levels, and the
 * answer is a self-report with `context: "correction"` that recalibrates the model. With no known last sleep the curve is the usual day
 * (the person's recorded nights, else a typical adult's), drawn with a line saying so. `children` carries the rest of the day's energy facts.
 */
export function EnergyCard({ estimate, fallback, children }: { estimate?: DashboardData["energyEstimate"]; fallback: string; children?: ReactNode }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const own = estimate?.selfReport;
  const reading = !estimate ? fallback : own ? t("{{level}}（本人自评）", { level: t(LEVEL[own]) }) : `${t(LEVEL[estimate.level])} · ${t(SURE[estimate.confidence])}`;
  const basis = estimate && !own ? estimate.basis.slice(0, 2) : [];
  const shape = estimate?.curve ? curveGeometry(estimate.curve) : undefined;
  const typical = estimate?.curve?.typical;
  const hh = (hours: number) => { const m = Math.round((hours % 24) * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
  return <section className="td-card energy-card" data-testid="energy-capsule" aria-labelledby="energy-title">
    <header className="td-card-head">
      <h2 id="energy-title" className="ds-serif">{t("今日精力")}</h2>
      {estimate && <IconButton label={t("纠正精力读数")} icon={<Pencil {...ICON} />} aria-expanded={open} onClick={() => setOpen((value) => !value)} />}
    </header>
    <p className="energy-reading" title={estimate ? [...estimate.basis, ...(estimate.capacity?.basis ?? [])].join(locale === "en" ? "; " : "；") : undefined}>
      <small>{t("此刻")}</small><b>{reading}</b></p>
    {shape ? <figure className="energy-curve">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={typical ? t("平常一天的精力曲线（模型推算）") : t("今天的精力曲线（模型推算）")}>
        <defs><linearGradient id="energy-band" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" className="energy-band-top" /><stop offset="1" className="energy-band-bottom" /></linearGradient></defs>
        <path d={shape.area} fill="url(#energy-band)" />
        <line className="energy-cut" x1="0" x2={W} y1={shape.high} y2={shape.high} />
        <line className="energy-cut" x1="0" x2={W} y1={shape.low} y2={shape.low} />
        <path className="energy-line" d={shape.line} />
        {shape.now && <line className="energy-now" x1={shape.now.x} x2={shape.now.x} y1="0" y2={H} />}
      </svg>
      {/* Outside the stretched drawing, so the mark stays round at any width. */}
      {shape.now && <span className="energy-now-dot" aria-hidden="true" style={{ left: `${(shape.now.x / W) * 100}%`, top: shape.now.y }} />}
      <figcaption className="energy-axis" aria-hidden="true"><span>06</span><span>12</span><span>18</span><span>24</span></figcaption>
      <small className="energy-legend">{t("虚线：低 / 中 / 高的分界；竖线：此刻")}</small>
      {typical && <small className="energy-legend">{typical.nights
        ? t("不知道昨晚的睡眠，按近四周 {{nights}} 晚的平常作息（{{from}} 睡、{{to}} 起）推算", { nights: typical.nights, from: hh(typical.from), to: hh(typical.to) })
        : t("还没有睡眠记录，按普通成年人作息（23:30 睡、7:30 起）推算；有了作息记录和几次纠正后按本人校准")}</small>}
    </figure>
      : estimate && <p className="energy-empty muted">{t("还没有可靠的睡眠记录，今天的精力曲线暂不绘制（把握低）。")}</p>}
    {basis.length > 0 && <p className="energy-basis">{basis.join(" · ")}</p>}
    {estimate?.capacity && <p className="energy-basis">{t("今天无截止的工作按 {{pct}}% 安排：{{basis}}", { pct: Math.round(estimate.capacity.multiplier * 100),
      basis: estimate.capacity.basis.join(locale === "en" ? ", " : "、") })}</p>}
    {open && <p className="energy-correct"><span>{t("实际精力")}</span><EnergyProbe context="correction" /></p>}
    {children}
  </section>;
}
