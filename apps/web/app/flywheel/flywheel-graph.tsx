"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { RELATION_KIND_LABEL } from "@crossline/core";
import {
  buildGraph, createSimulation, edgeGeometry, fitTransform, graphLoops, layoutGraph, loopCentre, neighbours,
  type FlywheelGraphData, type GraphEdge, type GraphNode, type Point
} from "./graph-model";
import "./flywheel-graph.css";

const ZOOM = { min: 0.5, max: 4 };
const DEFAULT_WIDTH = 720;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const short = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const r1 = (n: number) => Math.round(n * 10) / 10;
const openMilestone = (id: string) => { location.href = `/milestones?open=${encodeURIComponent(id)}`; };

type View = { zoom: number; x: number; y: number };
type Drag = { kind: "node"; id: string; pointerId: number; startX: number; startY: number; moved: boolean }
  | { kind: "pan"; pointerId: number; startX: number; startY: number; view: View };

/**
 * The flywheel graph on Today (decided 2026-10-10), in the manner of Obsidian's knowledge graph. A dot per live milestone in its line's
 * colour, as large as its unfinished tasks; an anchor per line labelled with the line's long-term goal, which holds that line's
 * milestones around it. Thin lines are one milestone before the next on a line; thick arrowed lines are flywheel relations between lines,
 * in the upstream line's colour — solid once the person approved them, dashed while candidates, which can be approved or turned down on
 * the graph. A loop closed by approved relations is marked R at its centre, with its lag when the relations state one.
 *
 * Drag a dot, zoom with the wheel or two fingers, pan the background; hovering or focusing a dot lights its neighbours and dims the rest;
 * a click opens the milestone's drawer on the 主线 page. The layout is a hand-written force simulation seeded from the ids, settled before
 * the first paint, so the shape is the same on every load; with reduced motion nothing animates.
 */
export function FlywheelGraph({ data }: { data: FlywheelGraphData }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [relations, setRelations] = useState(data.relations);
  const graph = useMemo(() => buildGraph({ ...data, relations }), [data, relations]);
  const base = useMemo(() => layoutGraph(buildGraph(data)), [data]);
  const [positions, setShown] = useState(base);
  // The positions as the handlers last set them (state may not have rendered yet when the pointer is released).
  const live = useRef(base);
  const setPositions = (next: Map<string, Point>) => { live.current = next; setShown(next); };
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const pinned = useRef(new Set<string>());
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const frame = useRef<number | null>(null);
  const reduced = useRef(false);

  const height = clamp(Math.round(width * 0.62), 320, 500);
  const fit = useMemo(() => fitTransform([...base.values()], width, height), [base, width, height]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const loops = useMemo(() => graphLoops(graph), [graph]);
  const lit = hover ? neighbours(graph, hover) : null;
  const lineLabel = new Map(data.lines.map((line) => [line.id, line.label]));

  useEffect(() => { live.current = base; setShown(base); pinned.current.clear(); }, [base]);
  useEffect(() => {
    reduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const element = wrap.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(280, Math.round(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); if (frame.current) cancelAnimationFrame(frame.current); };
  }, []);

  // Layout coordinates → pixels: fitted to the drawing, then the person's zoom (about the centre) and pan.
  const centre = { x: width / 2, y: height / 2 };
  const toScreen = (p: Point): Point => ({ x: ((p.x * fit.scale + fit.x) - centre.x) * view.zoom + centre.x + view.x, y: ((p.y * fit.scale + fit.y) - centre.y) * view.zoom + centre.y + view.y });
  const toLayout = (s: Point): Point => ({ x: (((s.x - centre.x - view.x) / view.zoom + centre.x) - fit.x) / fit.scale, y: (((s.y - centre.y - view.y) / view.zoom + centre.y) - fit.y) / fit.scale });
  const local = (clientX: number, clientY: number): Point => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: (clientX - rect.left) * (width / Math.max(1, rect.width)), y: (clientY - rect.top) * (height / Math.max(1, rect.height)) };
  };
  const zoomAbout = (at: Point, next: number) => setView((current) => {
    const zoom = clamp(next, ZOOM.min, ZOOM.max);
    const fx = (at.x - centre.x - current.x) / current.zoom + centre.x, fy = (at.y - centre.y - current.y) / current.zoom + centre.y;
    return { zoom, x: at.x - centre.x - (fx - centre.x) * zoom, y: at.y - centre.y - (fy - centre.y) * zoom };
  });

  // The wheel zooms the graph about the pointer; a passive listener could not stop the page scrolling at the same time.
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = local(event.clientX, event.clientY);
      setView((current) => {
        const zoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), ZOOM.min, ZOOM.max);
        const fx = (at.x - width / 2 - current.x) / current.zoom + width / 2, fy = (at.y - height / 2 - current.y) / current.zoom + height / 2;
        return { zoom, x: at.x - width / 2 - (fx - width / 2) * zoom, y: at.y - height / 2 - (fy - height / 2) * zoom };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [width, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // After a drop the rest of the graph relaxes around the dropped dot: animated, or settled at once under reduced motion.
  const relax = (from: Map<string, Point>) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    const simulation = createSimulation(graph, from);
    for (const id of pinned.current) simulation.fixed.add(id);
    if (reduced.current) { simulation.settle(120, 0.3); setPositions(new Map(simulation.positions)); return; }
    let alpha = 0.3;
    const step = () => {
      simulation.tick(alpha); simulation.tick(alpha);
      alpha *= 0.95;
      setPositions(new Map(simulation.positions));
      frame.current = alpha > 0.004 ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  };

  const onNodeDown = (node: GraphNode) => (event: ReactPointerEvent<SVGGElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = null; }
    drag.current = { kind: "node", id: node.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  };
  const onDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") touches.current.set(event.pointerId, local(event.clientX, event.clientY));
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, zoom: view.zoom };
      drag.current = null;
      return;
    }
    setPicked(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind: "pan", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, view };
  };
  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, local(event.clientX, event.clientY));
    if (pinch.current && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      zoomAbout({ x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, pinch.current.zoom * (Math.hypot(a!.x - b!.x, a!.y - b!.y) / pinch.current.distance));
      return;
    }
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const scale = width / Math.max(1, svg.current!.getBoundingClientRect().width);
    if (current.kind === "pan") {
      setView({ ...current.view, x: current.view.x + (event.clientX - current.startX) * scale, y: current.view.y + (event.clientY - current.startY) * scale });
      return;
    }
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4) return;
    current.moved = true;
    const at = toLayout(local(event.clientX, event.clientY));
    pinned.current.add(current.id);
    setPositions(new Map(live.current).set(current.id, at));
  };
  const onUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (current.kind !== "node") return;
    if (!current.moved) { const node = nodeById.get(current.id); if (node?.milestoneId) openMilestone(node.milestoneId); return; }
    relax(live.current);
  };

  const decide = async (edge: GraphEdge, decision: "approved" | "archived") => {
    if (!edge.relationId) return;
    setBusy(true); setStatus("");
    const response = await fetch("/api/milestone-relations/decide", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [edge.relationId], decision }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { ok?: boolean; decided?: string[]; skipped?: string[] } | null;
    setBusy(false);
    if (!response?.ok || !body?.ok) { setStatus("未能保存，请重试。"); return; }
    if (!body.decided?.includes(edge.relationId)) { setStatus("该关系缺少依据，暂不能批准；可在主线页查看。"); return; }
    setRelations((list) => decision === "archived" ? list.filter((relation) => relation.id !== edge.relationId)
      : list.map((relation) => relation.id === edge.relationId ? { ...relation, status: "approved" } : relation));
    setPicked(null);
    setStatus(decision === "approved" ? "已批准，图中改为实线。" : "已驳回，关系已移除。");
  };

  const at = (id: string) => { const p = positions.get(id); return p ? toScreen(p) : undefined; };
  // Milestone names only when they can be read: a dozen dots or fewer, or zoomed in; otherwise on hover or focus (anchors always). With
  // every name drawn, the real account's 37 milestones piled into an unreadable heap (2026-10-10).
  const milestoneCount = graph.nodes.filter((node) => node.kind === "milestone").length;
  const showNames = view.zoom >= 1.6 || (milestoneCount <= 12 && (width >= 600 || view.zoom >= 1.3));
  // Several relations between the same two milestones fan out instead of lying on top of each other.
  const fan = new Map<string, number>();
  const drawn = graph.edges.flatMap((edge) => {
    const a = at(edge.from), b = at(edge.to), target = nodeById.get(edge.to);
    if (!a || !b || !target) return [];
    const pair = [edge.from, edge.to].sort().join("|");
    const k = edge.kind === "member" ? 0 : fan.get(pair) ?? 0;
    if (edge.kind !== "member") fan.set(pair, k + 1);
    const bend = edge.kind === "cross" ? 18 + k * 16 : k * 14;
    return [{ edge, ...edgeGeometry(a, b, target.radius * (edge.kind === "member" ? 0 : 1), edge.from < edge.to ? bend : -bend) }];
  });
  const pickedEdge = drawn.find((item) => item.edge.id === picked);
  const titleOf = (id: string) => nodeById.get(id)?.label ?? "";
  const dim = (ids: string[]) => lit && !ids.every((id) => lit.has(id)) ? "" : undefined;

  return <div className="fw" ref={wrap}>
    {graph.nodes.every((node) => node.kind === "anchor")
      ? <p className="fw-empty">尚无进行中的里程碑。批准里程碑草稿后，各主线的里程碑与飞轮关系显示在此。</p>
      : <div className="fw-stage">
        <svg ref={svg} className="fw-graph" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`飞轮图谱：${graph.nodes.filter((node) => node.kind === "milestone").length} 个里程碑，${graph.edges.filter((edge) => edge.kind === "cross").length} 条飞轮关系`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <defs>{data.lines.map((line) => <marker key={line.id} id={`fw-${uid}-${line.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`} data-line={line.id}
            viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="fw-arrow" /></marker>)}</defs>
          {drawn.map(({ edge, path }) => <path key={edge.id} d={path} className="fw-edge" data-kind={edge.kind} data-status={edge.status} data-line={edge.line}
            data-dim={dim([edge.from, edge.to])} data-on={picked === edge.id || undefined}
            markerEnd={edge.kind === "cross" ? `url(#fw-${uid}-${edge.line.replace(/[^a-zA-Z0-9_-]/g, "_")})` : undefined} />)}
          {drawn.filter(({ edge }) => edge.relationId).map(({ edge, path }) => <path key={`hit-${edge.id}`} d={path} className="fw-hit"
            role="button" tabIndex={0} aria-label={`${titleOf(edge.from)} → ${titleOf(edge.to)}：${RELATION_KIND_LABEL[edge.relationKind ?? ""] ?? "关系"}${edge.status === "candidate" ? "，待确认" : ""}`}
            onPointerDown={(event) => event.stopPropagation()} onClick={() => setPicked(picked === edge.id ? null : edge.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPicked(picked === edge.id ? null : edge.id); } }}>
            <title>{`${titleOf(edge.from)} → ${titleOf(edge.to)}：${RELATION_KIND_LABEL[edge.relationKind ?? ""] ?? ""}${edge.explanation ? `。${edge.explanation}` : ""}`}</title></path>)}
          {graph.nodes.map((node) => {
            const p = at(node.id);
            if (!p) return null;
            const anchor = node.kind === "anchor";
            const named = anchor || showNames || Boolean(lit?.has(node.id));
            const label = anchor ? short(node.label, width < 600 ? 10 : 16) : short(node.label, 14);
            return <g key={node.id} className="fw-node" data-kind={node.kind} data-line={node.line} data-status={node.status} data-dim={dim([node.id])}
              transform={`translate(${r1(p.x)},${r1(p.y)})`} onPointerDown={onNodeDown(node)}
              onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover((current) => current === node.id ? null : current)}
              {...(node.milestoneId ? { role: "link", tabIndex: 0, "aria-label": `${lineLabel.get(node.line) ?? ""} · ${node.label}，${node.openTasks ?? 0} 项未完成${node.status === "draft" ? "，草稿" : ""}，打开主线页`,
                onFocus: () => setHover(node.id), onBlur: () => setHover(null),
                onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openMilestone(node.milestoneId!); } } } : { "aria-hidden": true })}>
              <title>{anchor ? `${lineLabel.get(node.line) ?? ""}：${node.label}` : `${node.label} · ${node.openTasks ?? 0} 项未完成${node.status === "draft" ? " · 草稿" : ""}`}</title>
              {anchor ? <><circle r={node.radius} className="fw-anchor-ring" /><circle r={5} className="fw-anchor-dot" /></> : <circle r={node.radius} className="fw-dot" />}
              {named && <text y={node.radius + 15} textAnchor="middle" className={anchor ? "fw-label fw-label-goal" : "fw-label"}>{label}</text>}
            </g>;
          })}
          {loops.map((loop) => {
            const centrePoint = loopCentre(loop, graph, at);
            if (!centrePoint) return null;
            return <g key={loop.id} className="fw-loop" transform={`translate(${r1(centrePoint.x)},${r1(centrePoint.y)})`}>
              <title>{`飞轮回路：${[...loop.lines, loop.lines[0]!].map((line) => lineLabel.get(line) ?? line).join(" → ")}`}</title>
              <circle r={14} /><text y={4} textAnchor="middle">{loop.label}</text>
              {loop.lagDays !== undefined && <text y={30} textAnchor="middle" className="fw-label">时延约 {loop.lagDays} 天</text>}
            </g>;
          })}
        </svg>
        <div className="fw-zoom" role="group" aria-label="缩放">
          <button type="button" aria-label="放大" onClick={() => zoomAbout(centre, view.zoom * 1.25)}>+</button>
          <button type="button" aria-label="缩小" onClick={() => zoomAbout(centre, view.zoom / 1.25)}>−</button>
          <button type="button" onClick={() => { setView({ zoom: 1, x: 0, y: 0 }); pinned.current.clear(); setPositions(base); }}>复位</button>
        </div>
        {pickedEdge?.edge.relationId && <div className="fw-pop" role="dialog" aria-label="飞轮关系" data-line={pickedEdge.edge.line}
          style={{ left: clamp(pickedEdge.mid.x - 150, 4, Math.max(4, width - 304)), top: pickedEdge.mid.y > height * 0.6 ? undefined : pickedEdge.mid.y + 12,
            bottom: pickedEdge.mid.y > height * 0.6 ? height - pickedEdge.mid.y + 12 : undefined }}>
          <p className="fw-pop-head"><b>{lineLabel.get(nodeById.get(pickedEdge.edge.from)?.line ?? "")} → {lineLabel.get(nodeById.get(pickedEdge.edge.to)?.line ?? "")}</b>
            <span className="fw-kind">{RELATION_KIND_LABEL[pickedEdge.edge.relationKind ?? ""] ?? "关系"}</span>
            <span className="fw-kind">{pickedEdge.edge.status === "candidate" ? "待确认" : "已确认"}</span></p>
          <p className="fw-pop-ends">{titleOf(pickedEdge.edge.from)} → {titleOf(pickedEdge.edge.to)}</p>
          {pickedEdge.edge.explanation && <p className="fw-pop-why gen">{pickedEdge.edge.explanation}</p>}
          <div className="fw-pop-actions">
            {pickedEdge.edge.status === "candidate" && <>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void decide(pickedEdge.edge, "approved")}>成立</button>
              <button type="button" disabled={busy} onClick={() => void decide(pickedEdge.edge, "archived")}>不成立</button>
            </>}
            <button type="button" className="fw-quiet" onClick={() => setPicked(null)}>关闭</button>
          </div>
        </div>}
      </div>}
    {status && <small role="status" className="fw-status">{status}</small>}
    <ul className="fw-lines" aria-label="各主线">
      {data.lines.map((line) => <li key={line.id} data-line={line.id}>
        <i aria-hidden="true" /><a href="/milestones"><b>{line.label}</b></a> · <span className="mono">{line.openTasks}</span> 项进行中
        {line.goal && <small title={line.goal}>{short(line.goal, 36)}</small>}
      </li>)}
    </ul>
    <ul className="fw-key" aria-label="图例">
      <li>点：里程碑，大小为未完成任务数，空心为草稿</li>
      <li>细线：同一主线前后</li>
      <li>粗线带箭头：飞轮关系，颜色取上游主线</li>
      <li>实线已确认，虚线待确认</li>
      <li>R：已确认关系构成的回路</li>
      <li>健康是容量约束，不画在图中</li>
      <li>拖动节点或空白处，滚轮或双指缩放；点里程碑打开主线页，点关系线查看与确认</li>
      {!showNames && <li>里程碑名称：悬停或放大后显示</li>}
    </ul>
  </div>;
}
