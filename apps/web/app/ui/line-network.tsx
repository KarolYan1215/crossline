"use client";

import { useState } from "react";
import { RELATION_KIND_LABEL, RELATION_KIND_MEANING, flywheelLoops } from "@crossline/core";
import type { Translate } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";

export type NetworkLine = { id: string; label: string; rank?: number | null; hard?: boolean };
/** One way a line feeds another. `candidate` = proposed, not yet judged by the person; drawn dashed until they say it holds. */
export type NetworkEdge = { id: string; from: string; to: string; kind: string; explanation: string; status: "confirmed" | "candidate" };

const SIZE = 360, C = SIZE / 2, R = 122, NODE = 32;
const roleOf = (line: NetworkLine, t: Translate) => line.hard ? t("硬约束") : line.rank === 1 ? t("底座") : line.rank ? t("第 {{rank}}", { rank: line.rank }) : "";
const safe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * The lines as a network (decided 2026-10-08): each line a node on one ring, each proposed or confirmed way one line feeds another a
 * directed edge in the source line's colour, labelled with its kind. Every candidate is drawn until the person says it does not hold;
 * what is left is their flywheel, and the loops it closes are listed under it. A constraint is drawn but never closes a loop.
 */
export function LineNetwork({ lines, edges, onConfirm, onReject, title = "主线飞轮" }: {
  lines: NetworkLine[]; edges: NetworkEdge[]; title?: string;
  onConfirm?: (edge: NetworkEdge) => void; onReject?: (edge: NetworkEdge) => void;
}) {
  const t = useT();
  const locale = useLocale();
  // A relation kind's label and meaning, in the page's language.
  const kindLabel = (kind: string) => RELATION_KIND_LABEL[kind] ? t(RELATION_KIND_LABEL[kind]!) : "";
  const [selected, setSelected] = useState<string | null>(null);
  const interactive = Boolean(onConfirm || onReject);
  const at = new Map(lines.map((line, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, lines.length)) * Math.PI * 2;
    return [line.id, { x: C + (lines.length > 1 ? R : 0) * Math.cos(angle), y: C + (lines.length > 1 ? R : 0) * Math.sin(angle) }];
  }));
  const drawn = edges.filter((edge) => at.has(edge.from) && at.has(edge.to) && edge.from !== edge.to);
  const name = (id: string) => lines.find((line) => line.id === id)?.label ?? id;
  const loops = flywheelLoops(drawn.filter((edge) => edge.status === "confirmed"));
  const possible = flywheelLoops(drawn).filter((loop) => !loops.some((done) => done.join() === loop.join()));
  const kinds = [...new Set(drawn.map((edge) => edge.kind))].filter((kind) => RELATION_KIND_LABEL[kind]);

  // Several edges in one direction between the same pair fan out, each bending a little further from the chord.
  const rank = new Map<string, number>();
  const geometry = drawn.map((edge) => {
    const key = `${edge.from}>${edge.to}`;
    const k = rank.get(key) ?? 0; rank.set(key, k + 1);
    const a = at.get(edge.from)!, b = at.get(edge.to)!;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    // The normal flips with the direction, so A→B and B→A bend to opposite sides and never overlap.
    const bend = d * (0.14 + 0.1 * k);
    const mx = (a.x + b.x) / 2 - (dy / d) * bend, my = (a.y + b.y) / 2 + (dx / d) * bend;
    const toward = (from: { x: number; y: number }, gap: number) => { const len = Math.hypot(mx - from.x, my - from.y) || 1; return { x: from.x + ((mx - from.x) / len) * gap, y: from.y + ((my - from.y) / len) * gap }; };
    const start = toward(a, NODE + 2), end = toward(b, NODE + 6);
    // The label sits on the curve itself (a quadratic's midpoint), not at the control point.
    const lx = 0.25 * start.x + 0.5 * mx + 0.25 * end.x, ly = 0.25 * start.y + 0.5 * my + 0.25 * end.y;
    return { edge, d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`, lx, ly };
  });

  // `title` is a Chinese key (or already translated, which `t` returns as it is).
  return <section className="ln" aria-label={t(title || "主线飞轮")}>
    {title && <h3>{t(title)}</h3>}
    {drawn.length === 0 ? <p className="ln-muted">{t("还没有主线之间的关系。访谈中提出的关系显示在此。")}</p> : <>
      <svg className="ln-graph" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={t("{{title}}：{{count}} 条关系", { title: t(title), count: drawn.length })}>
        <defs>{lines.map((line) => <marker key={line.id} id={`ln-arrow-${safe(line.id)}`} data-line={line.id} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--lc, var(--ink))" }} /></marker>)}</defs>
        {geometry.map(({ edge, d }) => <path key={edge.id} d={d} data-line={edge.from} className="ln-edge"
          data-status={edge.status} data-dim={selected && selected !== edge.id ? "" : undefined} data-on={selected === edge.id ? "" : undefined}
          markerEnd={`url(#ln-arrow-${safe(edge.from)})`} onClick={interactive ? () => setSelected(selected === edge.id ? null : edge.id) : undefined}>
          <title>{t("{{from}} → {{to}}：{{kind}}。{{explanation}}", { from: name(edge.from), to: name(edge.to), kind: kindLabel(edge.kind), explanation: edge.explanation })}</title></path>)}
        {geometry.map(({ edge, lx, ly }) => {
          if (!RELATION_KIND_LABEL[edge.kind]) return null;
          // English kind names are longer than two characters: the box follows the word.
          const half = locale === "en" ? Math.max(17, kindLabel(edge.kind).length * 3.3 + 5) : 17;
          return <g key={`l-${edge.id}`} className="ln-label" data-line={edge.from}
            data-dim={selected && selected !== edge.id ? "" : undefined} onClick={interactive ? () => setSelected(selected === edge.id ? null : edge.id) : undefined}>
            <rect x={lx - half} y={ly - 9} width={half * 2} height={18} rx={2} />
            <text x={lx} y={ly + 4} textAnchor="middle">{kindLabel(edge.kind)}</text>
          </g>;
        })}
        {lines.map((line) => { const p = at.get(line.id)!; const role = roleOf(line, t); return <g key={line.id} data-line={line.id} className="ln-node">
          <circle cx={p.x} cy={p.y} r={NODE} strokeWidth={line.rank === 1 || line.hard ? 4 : 2} />
          <text x={p.x} y={p.y + 5} textAnchor="middle">{line.label}</text>
          {role && <text className="ln-role" x={p.x} y={p.y < C - 1 ? p.y - NODE - 8 : p.y + NODE + 16} textAnchor="middle">{role}</text>}
        </g>; })}
      </svg>
      {kinds.length > 0 && <dl className="ln-legend">{kinds.map((kind) => <div key={kind}><dt>{kindLabel(kind)}</dt><dd>{RELATION_KIND_MEANING[kind] ? t(RELATION_KIND_MEANING[kind]!) : ""}</dd></div>)}
        <div><dt>{t("实线 / 虚线")}</dt><dd>{t("本人确认成立 / 尚待判断")}</dd></div></dl>}
      {loops.length > 0 && <p className="ln-loops"><b>{t("已形成的飞轮")}</b>{loops.slice(0, 3).map((loop) => <span key={loop.join()}>{[...loop, loop[0]!].map(name).join(" → ")}</span>)}
        {loops.length > 3 && <small>{t("等 {{count}} 个回路", { count: loops.length })}</small>}</p>}
      {!loops.length && possible.length > 0 && <p className="ln-loops"><b>{t("可能的飞轮（待确认）")}</b>{possible.slice(0, 3).map((loop) => <span key={loop.join()}>{[...loop, loop[0]!].map(name).join(" → ")}</span>)}</p>}
      {interactive && <ul className="ln-list">
        {drawn.map((edge) => <li key={edge.id} data-line={edge.from} data-on={selected === edge.id ? "" : undefined} data-status={edge.status}>
          <button type="button" className="ln-pick" onClick={() => setSelected(selected === edge.id ? null : edge.id)}>
            <b>{name(edge.from)} → {name(edge.to)}</b> <span className="ln-kind">{kindLabel(edge.kind) || edge.kind}</span>
            {edge.status === "confirmed" && <span className="ln-kind">{t("已确认")}</span>}
          </button>
          <p>{edge.explanation}</p>
          {edge.status === "candidate" && <span className="ln-actions">
            {onConfirm && <button type="button" onClick={() => onConfirm(edge)}>{t("成立")}</button>}
            {onReject && <button type="button" className="ln-quiet" onClick={() => onReject(edge)}>{t("不成立")}</button>}
          </span>}
        </li>)}
      </ul>}
    </>}
  </section>;
}
