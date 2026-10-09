"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PortraitReport } from "@crossline/core";

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
 * The portrait's charts (decided 2026-10-08: the report was all words). Hand-rolled SVG like every chart in the app; each reads one
 * field the writer scores from evidence, and draws nothing when the field is missing (a report written before the field existed).
 */

const INK = "#111", SOFT = "#4a4a4a", RULE = "#d0d0d0";
const LINE_COLOUR: Record<string, string> = { research: "#0A5198", startup: "#8C3709", media: "#792E9C", investment: "#085E3A", health: "#664E00" };
const colourOf = (lineId: string) => LINE_COLOUR[lineId] ?? INK;

/** What their work and life serve, each axis 0–100 from the evidence. */
export function ValuesRadar({ values, size = 300 }: { values: NonNullable<PortraitReport["compass"]["values"]>; size?: number }) {
  if (values.length < 3) return null;
  const c = size / 2, r = size / 2 - 58;
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index / values.length) * Math.PI * 2;
    return { x: c + Math.cos(angle) * r * (value / 100), y: c + Math.sin(angle) * r * (value / 100), angle };
  };
  const shape = values.map((item, index) => point(index, item.score)).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  return <svg className="pt-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`价值取向：${values.map((item) => `${item.name} ${item.score}`).join("，")}`}>
    {[25, 50, 75, 100].map((ring) => <polygon key={ring} points={values.map((_, index) => point(index, ring)).map((p) => `${p.x},${p.y}`).join(" ")}
      fill="none" stroke={RULE} strokeWidth={ring === 100 ? 1.2 : 0.8} />)}
    {values.map((_, index) => { const p = point(index, 100); return <line key={index} x1={c} y1={c} x2={p.x} y2={p.y} stroke={RULE} strokeWidth="0.8" />; })}
    <polygon points={shape} fill={INK} fillOpacity=".12" stroke={INK} strokeWidth="2" />
    {values.map((item, index) => { const p = point(index, item.score); return <circle key={item.name} cx={p.x} cy={p.y} r="3.5" fill={INK}><title>{item.evidence}</title></circle>; })}
    {values.map((item, index) => {
      const p = point(index, 118);
      const anchor = Math.abs(Math.cos(p.angle)) < 0.2 ? "middle" : Math.cos(p.angle) > 0 ? "start" : "end";
      return <text key={`t-${item.name}`} x={p.x} y={p.y + 4} textAnchor={anchor} fontSize="13" fontWeight="700" fill={INK}>{item.name}
        <tspan fontWeight="400" fill={SOFT}> {item.score}</tspan></text>;
    })}
  </svg>;
}

/** Activities on the energy plane: how good they are at it (→) and how much they love it (↑); filled = charges them, hollow = drains. */
export function EnergyScatter({ map, width = 520, height = 360 }: { map: PortraitReport["energy"]["map"]; width?: number; height?: number }) {
  if (!map.length) return null;
  const pad = { left: 30, right: 16, top: 16, bottom: 30 };
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  // An older report has only high/low: placed in its quadrant, spread so labels do not sit on each other.
  const placed = map.map((item, index) => ({ ...item,
    sx: item.skillScore ?? (item.skill === "high" ? 70 : 30) + ((index * 37) % 20) - 10,
    ly: item.loveScore ?? (item.love === "high" ? 70 : 30) + ((index * 53) % 20) - 10 }));
  const x = (value: number) => pad.left + (value / 100) * w, y = (value: number) => pad.top + (1 - value / 100) * h;
  return <svg className="pt-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="能量地图：横轴擅长程度，纵轴热爱程度；实心为充电，空心为耗电">
    <rect x={x(50)} y={y(100)} width={w / 2} height={h / 2} fill="#f4f4f1" />
    <line x1={x(0)} y1={y(50)} x2={x(100)} y2={y(50)} stroke={RULE} />
    <line x1={x(50)} y1={y(0)} x2={x(50)} y2={y(100)} stroke={RULE} />
    <rect x={pad.left} y={pad.top} width={w} height={h} fill="none" stroke={SOFT} strokeWidth="1" />
    <text x={x(100)} y={height - 8} textAnchor="end" fontSize="12" fill={SOFT}>擅长 →</text>
    <text x={8} y={pad.top + 12} fontSize="12" fill={SOFT}>热爱 ↑</text>
    <text x={x(98)} y={y(96)} textAnchor="end" fontSize="12" fill={SOFT}>擅长且热爱</text>
    {placed.map((item) => <g key={item.activity}>
      <circle cx={x(item.sx)} cy={y(item.ly)} r="6" fill={item.charge === "charge" ? INK : "#fff"} stroke={INK} strokeWidth="2" />
      <text x={x(item.sx) + (item.sx > 75 ? -10 : 10)} y={y(item.ly) + 4} textAnchor={item.sx > 75 ? "end" : "start"} fontSize="12" fill={INK}>{item.activity}</text>
    </g>)}
  </svg>;
}

/** Each line's share of attention now (hollow) and what the portrait suggests (filled, in the line's colour). */
export function AllocationChart({ items, label, width = 520 }: { items: Array<{ lineId: string; name: string; share?: number | undefined; targetShare?: number | undefined }>; label: string; width?: number }) {
  const rows = items.filter((item) => item.share !== undefined && item.targetShare !== undefined);
  if (!rows.length) return null;
  const row = 34, left = 92, right = 60, height = rows.length * row + 30;
  const x = (value: number) => left + (value / 100) * (width - left - right);
  return <svg className="pt-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    {[0, 25, 50, 75, 100].map((tick) => <g key={tick}><line x1={x(tick)} y1={8} x2={x(tick)} y2={height - 20} stroke={RULE} strokeWidth="0.8" />
      <text x={x(tick)} y={height - 6} textAnchor="middle" fontSize="12" fill={SOFT}>{tick}%</text></g>)}
    {rows.map((item, index) => { const cy = 22 + index * row, now = item.share!, target = item.targetShare!; return <g key={item.lineId}>
      <text x={left - 10} y={cy + 4} textAnchor="end" fontSize="13" fontWeight="700" fill={INK}>{item.name}</text>
      <line x1={x(Math.min(now, target))} y1={cy} x2={x(Math.max(now, target))} y2={cy} stroke={colourOf(item.lineId)} strokeWidth="3" />
      <circle cx={x(now)} cy={cy} r="6" fill="#fff" stroke={colourOf(item.lineId)} strokeWidth="2.5"><title>{`现在 ${now}%`}</title></circle>
      <circle cx={x(target)} cy={cy} r="6" fill={colourOf(item.lineId)}><title>{`建议 ${target}%`}</title></circle>
      <text x={width - right + 8} y={cy + 4} fontSize="12" fill={INK}>{now}→{target}</text>
    </g>; })}
  </svg>;
}

/** Where what they say and what they do part: says (filled) and does (hollow) on each dimension, 0–100. */
export function GapChart({ pairs, width = 520 }: { pairs: NonNullable<PortraitReport["gap"]["pairs"]>; width?: number }) {
  if (!pairs.length) return null;
  const row = 38, left = 104, right = 52, height = pairs.length * row + 34;
  const x = (value: number) => left + (value / 100) * (width - left - right);
  return <svg className="pt-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`言行对照：${pairs.map((pair) => `${pair.dimension} 所说 ${pair.says}，所做 ${pair.does}`).join("；")}`}>
    <circle cx={left} cy={10} r="5" fill={INK} /><text x={left + 10} y={14} fontSize="12" fill={INK}>所说</text>
    <circle cx={left + 60} cy={10} r="5" fill="#fff" stroke={INK} strokeWidth="2" /><text x={left + 70} y={14} fontSize="12" fill={INK}>所做</text>
    {pairs.map((pair, index) => { const cy = 38 + index * row; return <g key={pair.dimension}>
      <line x1={x(0)} y1={cy} x2={x(100)} y2={cy} stroke={RULE} strokeWidth="0.8" />
      <text x={left - 10} y={cy + 4} textAnchor="end" fontSize="13" fontWeight="700" fill={INK}>{pair.dimension}</text>
      <line x1={x(Math.min(pair.says, pair.does))} y1={cy} x2={x(Math.max(pair.says, pair.does))} y2={cy} stroke={INK} strokeWidth="3" />
      <circle cx={x(pair.says)} cy={cy} r="6" fill={INK} />
      <circle cx={x(pair.does)} cy={cy} r="6" fill="#fff" stroke={INK} strokeWidth="2" />
      <text x={width - right + 8} y={cy + 4} fontSize="12" fill={SOFT}>差 {Math.abs(pair.says - pair.does)}</text>
    </g>; })}
  </svg>;
}

/** The advice on impact (↑) against effort (→): the numbered dots match the list beside it; top-left is where to start. */
export function AdviceMatrix({ insights }: { insights: PortraitReport["insights"] }) {
  const rated = insights.map((item, index) => ({ ...item, index })).filter((item) => item.impact && item.effort);
  if (!rated.length) return null;
  const size = 300, pad = 30, span = size - pad * 2;
  // 1–5 sit in the middle of five equal bands, so a 5 is inside the frame, not on it.
  const pos = (value: number) => ((value - 0.5) / 5) * span;
  return <svg className="pt-chart pt-matrix" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="建议矩阵：纵轴影响，横轴投入">
    <rect x={pad} y={pad} width={span / 2} height={span / 2} fill="#f4f4f1" />
    <rect x={pad} y={pad} width={span} height={span} fill="none" stroke={SOFT} />
    <line x1={pad + span / 2} y1={pad} x2={pad + span / 2} y2={pad + span} stroke={RULE} />
    <line x1={pad} y1={pad + span / 2} x2={pad + span} y2={pad + span / 2} stroke={RULE} />
    <text x={pad + 6} y={pad + 16} fontSize="12" fill={SOFT}>先做</text>
    <text x={pad + span} y={size - 8} textAnchor="end" fontSize="12" fill={SOFT}>投入 →</text>
    <text x={4} y={pad - 10} fontSize="12" fill={SOFT}>影响 ↑</text>
    {rated.map((item) => { const cx = pad + pos(item.effort!) + ((item.index * 7) % 9) - 4, cy = pad + span - pos(item.impact!) + ((item.index * 5) % 9) - 4;
      return <g key={item.index}><circle cx={cx} cy={cy} r="11" fill={item.priority === "high" ? INK : "#fff"} stroke={INK} strokeWidth="2" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill={item.priority === "high" ? "#fff" : INK}>{item.index + 1}</text></g>; })}
  </svg>;
}
