"use client";
import { useT } from "../locale-context";

/**
 * The chart primitives every page draws with: plain SVG, no library. Each mark carries a <title>, so hovering shows the exact value
 * (and a screen reader reads it); the chart itself carries the shape. Colours come from the line palette (`data-line`) or the
 * neutral ink, so light and dark mode follow the stylesheet. Client components (their props are plain data) so the words they add
 * themselves — 上限, 分数线 — follow the page's language (docs/i18n.md); labels are passed in already translated.
 */

export type Datum = { label: string; value: number; line?: string; title?: string };

/** Horizontal bars, one per row, sharing one scale. */
export function BarChart({ data, unit = "", max, label }: { data: Datum[]; unit?: string; max?: number; label: string }) {
  const top = Math.max(max ?? 0, ...data.map((d) => d.value), 1);
  return <figure className="ui-bars" aria-label={label}>
    {data.map((d) => <div key={d.label} className="ui-bar-row" data-line={d.line}>
      <span className="ui-bar-label">{d.label}</span>
      <svg className="ui-bar-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
        <rect width={(d.value / top) * 100} height="10" className="ui-bar-fill"><title>{d.title ?? `${d.label} ${fmt(d.value)}${unit}`}</title></rect>
      </svg>
      <span className="ui-bar-value mono">{fmt(d.value)}{unit}</span>
    </div>)}
  </figure>;
}

/** One bar split into parts (e.g. the week's hours by line), with an optional limit line (capacity). */
export function StackedBar({ segments, limit, unit = "", label, height = 14 }: { segments: Datum[]; limit?: number; unit?: string; label: string; height?: number }) {
  const t = useT();
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const scale = Math.max(total, limit ?? 0, 1);
  let x = 0;
  return <svg className="ui-stacked" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={t("{{label}}：{{value}}", { label, value: `${fmt(total)}${unit}${limit ? ` / ${fmt(limit)}${unit}` : ""}` })}>
    <rect width="100" height={height} className="ui-stacked-bg" />
    {segments.map((s) => {
      const w = (s.value / scale) * 100;
      const rect = <rect key={s.label} x={x} width={w} height={height} data-line={s.line} className="ui-stacked-seg"><title>{s.title ?? `${s.label} ${fmt(s.value)}${unit}`}</title></rect>;
      x += w;
      return rect;
    })}
    {limit !== undefined && <line x1={(limit / scale) * 100} x2={(limit / scale) * 100} y1="0" y2={height} className="ui-limit"><title>{t("上限 {{value}}", { value: `${fmt(limit)}${unit}` })}</title></line>}
  </svg>;
}

/**
 * A bullet chart for a threshold: the bare line that only just reaches the outcome, the line actually set, and the current reading or
 * prediction. Higher is better unless `lowerIsBetter`.
 */
export function Bullet({ bare, target, actual, predicted, max, min = 0, unit = "", label }: {
  bare?: number; target: number; actual?: number; predicted?: number; max: number; min?: number; unit?: string; label: string;
}) {
  const t = useT();
  const at = (v: number) => ((v - min) / Math.max(1e-9, max - min)) * 100;
  const v = (value: number) => `${fmt(value)}${unit}`;
  const parts = [t("分数线 {{value}}", { value: v(target) }), ...(bare !== undefined ? [t("最低够线 {{value}}", { value: v(bare) })] : []),
    ...(actual !== undefined ? [t("实际 {{value}}", { value: v(actual) })] : predicted !== undefined ? [t("预测 {{value}}", { value: v(predicted) })] : [])];
  return <svg className="ui-bullet" viewBox="0 0 100 16" preserveAspectRatio="none" role="img"
    aria-label={t("{{label}}：{{value}}", { label, value: parts.join(t("，")) })}>
    <rect width="100" height="16" className="ui-bullet-bg" />
    {bare !== undefined && <rect width={at(bare)} height="16" className="ui-bullet-bare"><title>{t("最低够线 {{value}}", { value: v(bare) })}</title></rect>}
    {(actual ?? predicted) !== undefined && <rect y="5" width={at((actual ?? predicted)!)} height="6" className="ui-bullet-value" data-predicted={actual === undefined || undefined}>
      <title>{actual !== undefined ? t("实际 {{value}}", { value: v(actual) }) : t("预测 {{value}}", { value: v(predicted!) })}</title></rect>}
    <rect x={at(target) - 0.6} width="1.2" height="16" className="ui-bullet-target"><title>{t("分数线 {{value}}", { value: v(target) })}</title></rect>
  </svg>;
}

/** A donut for a share of a whole (e.g. on-time milestones). */
export function Ring({ value, max = 1, label, size = 56, line }: { value: number; max?: number; label: string; size?: number; line?: string }) {
  const t = useT();
  const share = Math.max(0, Math.min(1, value / Math.max(1e-9, max)));
  const r = size / 2 - 5, c = 2 * Math.PI * r;
  return <svg className="ui-donut" data-line={line} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("{{label}}：{{value}}", { label, value: `${Math.round(share * 100)}%` })}>
    <circle cx={size / 2} cy={size / 2} r={r} className="ui-donut-bg" />
    <circle cx={size / 2} cy={size / 2} r={r} className="ui-donut-fg" strokeDasharray={`${share * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
      <title>{`${label} ${Math.round(share * 100)}%`}</title></circle>
    <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="ui-donut-text">{Math.round(share * 100)}%</text>
  </svg>;
}

/** A small trend line; the last point is marked. `labels` (same length) name each point for hover. */
export function Sparkline({ values, labels, label, width = 120, height = 28, unit = "" }: { values: number[]; labels?: string[]; label: string; width?: number; height?: number; unit?: string }) {
  const t = useT();
  if (values.length === 0) return null;
  const top = Math.max(...values, 1), step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values.map((v, i) => [i * step, height - 3 - (v / top) * (height - 6)] as const);
  return <svg className="ui-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("{{label}}：最近 {{value}}", { label, value: `${fmt(values.at(-1)!)}${unit}` })}>
    <polyline points={points.map(([x, y]) => `${x},${y}`).join(" ")} className="ui-spark-line" />
    {points.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === points.length - 1 ? 2.5 : 6} className={i === points.length - 1 ? "ui-spark-last" : "ui-spark-hit"}>
      <title>{`${labels?.[i] ?? ""} ${fmt(values[i]!)}${unit}`.trim()}</title></circle>)}
  </svg>;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
