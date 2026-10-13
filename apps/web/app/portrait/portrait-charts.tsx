"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SAY_DO_DIMENSIONS, type PortraitReport, type PortraitType, type SayDoReading } from "@crossline/core";
import { axisBar, dodgeMatrix, energyLegend } from "./poster-geometry";

/**
 * Draws its child at the width it actually has, so a chart's 12px labels are 12px on a phone and on an A4 page alike (an SVG scaled to
 * fit shrank them to 7px on a phone). Starts at `initial` until measured; the export renders what is on screen.
 */
export function Fit({ initial, max, children }: { initial: number; max: number; children: (width: number) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const next = Math.round(Math.min(max, entry?.contentRect.width ?? initial)); if (next > 0) setWidth(next); });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [initial, max]);
  return <div ref={box} className="pt-fit">{children(width)}</div>;
}

/**
 * The portrait's charts (decided 2026-10-08: the report was all words; restyled 2026-10-12 as style A 「编辑杂志」). Hand-rolled like
 * every chart in the app; each draws nothing when its field is missing (a report written before the field existed). Dots that carry a
 * number are HTML, not SVG text, so the design audit reads the colour actually behind the number.
 */

const INK = "#1C1A17", MUTED = "#4F4A42", TRACK = "#DDD5C7";
const LINE_COLOUR: Record<string, string> = { research: "#0A5198", startup: "#8C3709", media: "#792E9C", investment: "#085E3A", health: "#664E00" };
const colourOf = (lineId: string) => LINE_COLOUR[lineId] ?? INK;

/**
 * The four typing axes as diverging bars: both poles named, the one leaned to in bold, the bar growing from the middle towards it, the
 * percentage inside a long bar and beside a short one. `evidence` adds each axis's reason under it.
 */
export function DivergingAxes({ type, evidence }: { type: PortraitType; evidence?: boolean }) {
  return <ul className="pt-axes">{type.axes.map((axis) => {
    const bar = axisBar(axis.score);
    const outside: CSSProperties = bar.side === "right" ? { left: `calc(${bar.from + bar.width}% + 6px)` } : { right: `calc(${100 - bar.from}% + 6px)` };
    return <li key={axis.id}>
      <span className="pt-axis-side pt-serif" data-on={bar.side === "left" || undefined}>{axis.left}</span>
      <span className="pt-axis-track" role="img" aria-label={`${axis.label} ${bar.percent}%`}>
        <i style={{ left: `${bar.from}%`, width: `${bar.width}%` }} data-side={bar.side}>{bar.inside && <b>{bar.percent}%</b>}</i>
        {!bar.inside && <b className="pt-axis-out" style={outside}>{bar.percent}%</b>}
      </span>
      <span className="pt-axis-side pt-serif" data-on={bar.side === "right" || undefined}>{axis.right}</span>
      {evidence && axis.evidence && <small className="gen">{axis.evidence}</small>}
    </li>;
  })}</ul>;
}

/** Lines as rows: the suggested share as a solid bar in the line's colour, the current share as a hollow marker, and both in words. */
export function IdentityBars({ rows }: { rows: Array<{ lineId: string; label: string; target: number; now: number | null }> }) {
  if (!rows.length) return null;
  return <ul className="pt-identities">{rows.map((row) => <li key={row.lineId} style={{ ["--lc" as string]: colourOf(row.lineId) }}>
    <b>{row.label}</b>
    <span className="pt-identity-track" role="img" aria-label={`${row.label}：${row.now === null ? "" : `现在 ${row.now}%，`}建议 ${row.target}%`}>
      <i style={{ width: `${row.target}%` }} />
      {row.now !== null && <u style={{ left: `${row.now}%` }} />}
    </span>
    <small>{row.now === null ? `建议 ${row.target}%` : `${row.now}% → ${row.target}%`}</small>
  </li>)}</ul>;
}

/** Schwartz's ten values on fixed axes in the circle's order (`radarValues`), each 0–100 from the evidence. */
export function ValuesRadar({ values, size = 300 }: { values: NonNullable<PortraitReport["compass"]["values"]>; size?: number }) {
  const c = size / 2, r = size / 2 - 72;
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index / values.length) * Math.PI * 2;
    return { x: c + Math.cos(angle) * r * (value / 100), y: c + Math.sin(angle) * r * (value / 100), angle };
  };
  const shape = values.map((item, index) => point(index, item.score)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return <svg className="pt-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`价值取向：${values.map((item) => `${item.name} ${item.score}`).join("，")}`}>
    {[25, 50, 75, 100].map((ring) => <polygon key={ring} points={values.map((_, index) => point(index, ring)).map((p) => `${p.x},${p.y}`).join(" ")}
      fill="none" stroke={TRACK} strokeWidth={ring === 100 ? 1.2 : 0.8} />)}
    {values.map((_, index) => { const p = point(index, 100); return <line key={index} x1={c} y1={c} x2={p.x} y2={p.y} stroke={TRACK} strokeWidth="0.8" />; })}
    <polygon points={shape} style={{ fill: "var(--pt-accent)", stroke: "var(--pt-accent)" }} fillOpacity=".16" strokeWidth="2" />
    {values.map((item, index) => { const p = point(index, item.score); return <circle key={item.name} cx={p.x} cy={p.y} r="3.5" style={{ fill: "var(--pt-accent)" }}><title>{item.evidence}</title></circle>; })}
    {values.map((item, index) => {
      const p = point(index, 116);
      const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
      const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
      return <text key={`t-${item.name}`} x={p.x} y={p.y + 4 + (Math.abs(cos) < 0.2 ? sin * 6 : 0)} textAnchor={anchor} fontSize="13" fill={INK}>
        <tspan className="pt-serif" fontWeight="700">{item.name}</tspan><tspan fill={MUTED}> {item.score}</tspan></text>;
    })}
  </svg>;
}

type PlaneDot = { key: string; x: number; y: number; number: number; filled: boolean; title: string };
/** A plane of numbered dots (HTML, so a number's backdrop is real): `x`/`y` 0–100, filled or hollow, spread where they would touch. */
function NumberedPlane({ dots, width, height, x, y, corner, shade, r }: { dots: PlaneDot[]; width: number; height: number; x: string; y: string;
  corner: string; shade: "top-right" | "top-left"; r: number }) {
  const pad = { left: 14, right: 14, top: 24, bottom: 24 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const placed = dodgeMatrix(dots.map((dot) => ({ ...dot, x: pad.left + (dot.x / 100) * w, y: pad.top + (1 - dot.y / 100) * h })), r);
  return <div className="pt-plane" style={{ width, height }}>
    <span className="pt-plane-frame" style={{ left: pad.left, top: pad.top, width: w, height: h }}>
      <span className="pt-plane-shade" data-at={shade} />
    </span>
    <small className="pt-plane-y">{y}</small>
    <small className="pt-plane-x">{x}</small>
    <small className="pt-plane-corner" data-at={shade}>{corner}</small>
    {placed.map((dot) => <span key={dot.key} className="pt-dot" data-filled={dot.filled || undefined} title={dot.title}
      style={{ left: dot.x - r, top: dot.y - r, width: r * 2, height: r * 2 }}>{dot.number}</span>)}
  </div>;
}

/**
 * Activities on the energy plane — how good they are at it (→) and how much they love it (↑) — as numbered dots (filled charges them,
 * hollow drains), with a legend under it grouped by the six fixed categories; names never sit on the plane, so they cannot collide.
 */
export function EnergyScatter({ map, width = 520 }: { map: PortraitReport["energy"]["map"]; width?: number }) {
  if (!map.length) return null;
  const groups = energyLegend(map);
  // An older report has only high/low: placed in its quadrant.
  const dots = groups.flatMap((group) => group.entries).map((item) => ({ key: `${item.number}`, number: item.number, filled: item.charge === "charge", title: item.activity,
    x: item.skillScore ?? (item.skill === "high" ? 70 : 30), y: item.loveScore ?? (item.love === "high" ? 70 : 30) }));
  return <div className="pt-energy">
    <NumberedPlane dots={dots} width={width} height={Math.round(Math.min(380, width * 0.66))} r={12} shade="top-right" x="擅长 →" y="热爱 ↑" corner="擅长且热爱" />
    <dl className="pt-legend">{groups.map((group) => <div key={group.category}>
      <dt>{group.category}</dt>
      {group.entries.map((entry) => <dd key={entry.number}><b>{entry.number}</b><span className="gen">{entry.activity}</span><small>{entry.charge === "charge" ? "充电" : "耗电"}</small></dd>)}
    </div>)}</dl>
  </div>;
}

/**
 * Say against do on the five fixed dimensions: what the person says matters (filled, from the interview) and what the execution record
 * shows (hollow, `sayDoFor`). Until the record is long enough nothing is scored — a line says how much there is so far.
 */
export function GapChart({ pairs, sayDo, width = 520 }: { pairs: NonNullable<PortraitReport["gap"]["pairs"]>; sayDo: SayDoReading; width?: number }) {
  if (!sayDo.sufficient) return <p className="pt-gap-note">执行记录满 14 天且不少于 10 次后画出对照（现有 {sayDo.days} 天、{sayDo.executions} 次）。</p>;
  const rows = SAY_DO_DIMENSIONS.map((dimension) => ({ ...dimension, says: pairs.find((pair) => pair.dimension === dimension.label)?.says ?? null, does: sayDo.does[dimension.id] }));
  const row = 38, left = 104, right = 76, height = rows.length * row + 34;
  const x = (value: number) => left + (value / 100) * (width - left - right);
  return <svg className="pt-chart" viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label={`言行对照：${rows.map((item) => `${item.label} 所说 ${item.says ?? "无"}，所做 ${item.does ?? "暂无记录"}`).join("；")}`}>
    <circle cx={left} cy={10} r="5" fill={INK} /><text x={left + 10} y={14} fontSize="12" fill={INK}>所说</text>
    <circle cx={left + 60} cy={10} r="5" fill="#fff" stroke={INK} strokeWidth="2" /><text x={left + 70} y={14} fontSize="12" fill={INK}>所做</text>
    {rows.map((item, index) => { const cy = 38 + index * row; return <g key={item.id}>
      <line x1={x(0)} y1={cy} x2={x(100)} y2={cy} stroke={TRACK} strokeWidth="0.8" />
      <text x={left - 10} y={cy + 4} textAnchor="end" fontSize="13" fontWeight="700" fill={INK}>{item.label}</text>
      {item.says !== null && item.does !== null && <line x1={x(Math.min(item.says, item.does))} y1={cy} x2={x(Math.max(item.says, item.does))} y2={cy} stroke={INK} strokeWidth="3" />}
      {item.says !== null && <circle cx={x(item.says)} cy={cy} r="6" fill={INK} />}
      {item.does !== null && <circle cx={x(item.does)} cy={cy} r="6" fill="#fff" stroke={INK} strokeWidth="2" />}
      <text x={width - right + 8} y={cy + 4} fontSize="12" fill={MUTED}>{item.does === null ? "暂无记录" : item.says === null ? "" : `差 ${Math.abs(item.says - item.does)}`}</text>
    </g>; })}
  </svg>;
}

/** The advice on impact (↑) against effort (→): the numbered dots match the list beside it; top-left is where to start. */
export function AdviceMatrix({ insights }: { insights: PortraitReport["insights"] }) {
  const rated = insights.map((item, index) => ({ ...item, index })).filter((item) => item.impact && item.effort);
  if (!rated.length) return null;
  // 1–5 sit in the middle of five equal bands, so a 5 is inside the frame, not on it.
  const band = (value: number) => ((value - 0.5) / 5) * 100;
  return <div className="pt-matrix" role="img" aria-label="建议矩阵：纵轴影响，横轴投入">
    <NumberedPlane dots={rated.map((item) => ({ key: `${item.index}`, number: item.index + 1, filled: item.priority === "high", title: item.advice, x: band(item.effort!), y: band(item.impact!) }))}
      width={300} height={300} r={11} shade="top-left" x="投入 →" y="影响 ↑" corner="先做" />
  </div>;
}
