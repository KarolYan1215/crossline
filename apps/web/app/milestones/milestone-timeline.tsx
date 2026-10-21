"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { MILESTONE_RISK_KIND_LABEL, MILESTONE_RISK_LEVEL_LABEL, RELATION_KIND_LABEL, riskLevelOf, type MilestoneRisk, type MilestoneRiskLevel } from "@crossline/core";
import { RiskGlyph } from "./risk-glyph";
import type { BoardMilestone, BoardRelation, MilestoneBoard } from "../../lib/milestone-board";
import { Sheet } from "../ui/overlay";
import { useReturnState } from "../ui/return-state";
import { Tag } from "../ui/tag";
import { TICK_HIT, TL, connectionsOf, edgeLabelSize, focusLabels, labelObstacles, layoutTimeline, placeEdgeLabels, riskBox, riskGlyphsShown, tickStory,
  tickTargets, type TimelineLayout } from "./timeline-model";

/** The board names a relation's kind by its label; the curve's dash pattern needs the kind itself. */
const KIND_OF_LABEL = new Map(Object.entries(RELATION_KIND_LABEL).map(([kind, label]) => [label, kind]));
/** How long a hovered relation's labels stay after the pointer leaves, so it can reach a label (an artifact's chip) placed off the curve. */
const LINGER_MS = 300;
import { MilestoneDrawer, CourseDrawer } from "./milestone-drawer";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/**
 * The lines on one shared date axis, fitted to the width of the page: a row per line, a marker at each milestone's deadline (filled when
 * approved, hollow with a halo while it waits for approval, a ring inside once reached), its risk as a glyph beside it where that fits, the
 * ticks before it, chains above the axis (faint in a crowded row until hovered) and relations between rows, their kind as the line style
 * and their name only on hover, placed where it covers nothing. The year is on the axis, with a separator at every 1 January. A click on a
 * marker or its label opens the milestone beside the timeline; 「一键批准」 at the top right approves every draft after showing their risks
 * together. Row heights are fixed (two label lanes at most), so the whole timeline stays inside one screen.
 *
 * What is in focus is said in full, never by a cut label (2026-10-21, the owner: 「选中后看不出来各个里程碑分别是啥」): a strip of fixed
 * height above the canvas names the hovered or focused milestone (title, deadline, state, risk, what it is joined to) or the ticks under
 * the pointer or picked; the milestones in focus get their full names on the canvas (`focusLabels`), and the rest dim only their graphics,
 * never their text. Every tick dot and every postponed tick's dashed ghost is a target (`tickTargets`); a click pins its explanation in
 * the strip until closed (×, Esc).
 */
export function MilestoneTimeline({ board, actions }: { board: MilestoneBoard; actions?: ReactNode }) {
  const [selected, setSelected] = useState<{ kind: "milestone"; id: string } | { kind: "course"; id: string } | null>(null);
  // Ticks under the pointer (or keyboard focus), and the ticks picked by a click, whose explanation stays in the strip until closed.
  const [tickHover, setTickHover] = useState<string[] | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // Hovering (or focusing) a milestone lights up its chain steps and relations and the milestones at their other ends; the rest dims.
  const [hover, setHover] = useState<string | null>(null);
  // Hovering a relation's curve does the same for that one relation.
  const [edgeHover, setEdgeHover] = useState<string | null>(null);
  // Relation labels are not drawn until asked for: `m:<id>` shows the labels of every relation of that milestone, `e:<edge>` the one
  // curve's. They linger briefly after the pointer leaves, so it can move onto a label to open what the relation carries.
  const [labelKey, setLabelKey] = useState<string | null>(null);
  const linger = useRef<number | undefined>(undefined);
  const showLabels = (key: string) => { window.clearTimeout(linger.current); setLabelKey(key); };
  const holdLabels = () => window.clearTimeout(linger.current);
  const hideLabels = () => { window.clearTimeout(linger.current); linger.current = window.setTimeout(() => setLabelKey(null), LINGER_MS); };
  useEffect(() => () => window.clearTimeout(linger.current), []);
  // Hovering (or focusing) a cross-line edge's label shows what it carries: the artifact, the transfer, the check day, the counterfactual.
  const [flow, setFlow] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1100);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // `?open=<id>` (a link from another page, such as the weekly review) opens that milestone.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("open");
    if (id && board.milestones.some((item) => item.id === id)) setSelected({ kind: "milestone", id });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing drops `?open=`, which an edit in the drawer reloads with, so a later reload does not open it again.
  const closeDrawer = () => {
    setSelected(null);
    const url = new URL(location.href);
    if (url.searchParams.has("open")) { url.searchParams.delete("open"); history.replaceState(history.state, "", url.toString()); }
  };
  // Back from a task opened in the milestone's panel, the panel is open again.
  useReturnState("milestone-drawer", selected, setSelected);

  const courseNodes = board.courses.map((course) => ({ id: `course:${course.projectId}`, line: course.identityId, title: `${course.name} · ${course.value}`,
    status: "approved" as const, kind: "course" as const, day: course.endDay ? new Date(Date.parse(`${course.endDay}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10) : undefined, dependsOn: [] }));
  const drafts = board.milestones.filter((item) => item.status === "draft");
  // 「按主线」 beside 「一键批准」: one row per line with drafts, each approved on its own after its risks are shown.
  const [byLine, setByLine] = useState(false);
  const layout = layoutTimeline({
    nodes: [...board.milestones.map((milestone) => ({ id: milestone.id, line: milestone.identityId, title: milestone.title, status: milestone.status,
      kind: "milestone" as const, day: milestone.deadline, dependsOn: milestone.dependsOn })), ...courseNodes],
    ticks: board.milestones.flatMap((milestone) => milestone.ticks.map((item) => ({ id: item.id, milestoneId: milestone.id, line: milestone.identityId,
      day: item.day, state: item.state, plannedDay: item.plannedDay }))),
    relations: board.milestones.flatMap((milestone) => milestone.relations.filter((relation) => relation.direction === "out")
      .map((relation) => ({ id: relation.id, from: milestone.id, to: relation.otherId, pending: relation.pending, label: relation.kindLabel,
        ...(KIND_OF_LABEL.has(relation.kindLabel) ? { kind: KIND_OF_LABEL.get(relation.kindLabel)! } : {}), broken: Boolean(relation.broken) }))),
    lineOrder: board.lineOrder, today: board.today, width
  });
  const head = <header className="mt-head">
    <MilestoneStats board={board} />
    <div className="mt-head-actions">
      {drafts.length > 0 && <span className="ba-split">
        <BatchApprove drafts={drafts} labels={board.labels} lineOrder={board.lineOrder} />
        <button type="button" className="secondary-button ba-toggle" aria-expanded={byLine} aria-controls="ba-by-line"
          onClick={() => setByLine(!byLine)}>按主线<span aria-hidden="true">{byLine ? " ▴" : " ▾"}</span></button>
      </span>}
      {actions}
    </div>
    {drafts.length > 0 && byLine && <LineApprovals id="ba-by-line" drafts={drafts} labels={board.labels} lineOrder={board.lineOrder} />}
    <DraftingNotes board={board} />
  </header>;
  if (!layout.nodes.length) return <div className="mt">{head}<p className="flow-empty">{board.drafting?.pending.length ? "里程碑草稿一条线一条线出来，好了会出现在这里等待批准。" : board.firstDrafts === "running"
    ? "系统正在按访谈为每条主线设计里程碑草稿（每条主线几分钟），好了会出现在这里等待批准。"
    : board.firstDrafts === "stalled" ? "里程碑草稿没有生成，点上方「让 AI 重新提议草稿」再试一次。" : "尚无里程碑。访谈结束（或达到开始标准后停下 20 分钟）时系统自动设计草稿；也可以点上方「让 AI 重新提议草稿」。"}</p></div>;
  const milestone = selected?.kind === "milestone" ? board.milestones.find((item) => item.id === selected.id) : undefined;
  const course = selected?.kind === "course" ? board.courses.find((item) => `course:${item.projectId}` === selected.id) : undefined;
  const byId = new Map(board.milestones.map((item) => [item.id, item]));
  const ticksById = new Map(board.milestones.flatMap((item) => item.ticks.map((t) => [t.id, t] as const)));
  const outgoing = new Map<string, { relation: BoardRelation; from: BoardMilestone }>(board.milestones.flatMap((item) => item.relations.filter((relation) => relation.direction === "out")
    .map((relation) => [`relation:${relation.id}`, { relation, from: item }] as const)));
  // What the strip names: the milestone under the pointer or focus, else the ticks under it, else the ticks picked by a click.
  const tickSubject = hover ? null : tickHover ?? picked;
  const milestoneOfTick = new Map(layout.ticks.map((item) => [item.id, item.milestoneId]));
  const hot = hover ? new Set(layout.edges.filter((edge) => edge.from === hover || edge.to === hover).flatMap((edge) => [edge.id, edge.from, edge.to]).concat(hover))
    : tickSubject ? new Set(tickSubject.flatMap((id) => [id, milestoneOfTick.get(id) ?? ""]))
    : edgeHover ? new Set(layout.edges.filter((edge) => edge.id === edgeHover).flatMap((edge) => [edge.id, edge.from, edge.to])) : null;
  const targets = tickTargets(layout);
  // A tick lights up with its milestone, and with the milestone under the pointer.
  const hotTick = (id: string) => Boolean(hot && (hot.has(id) || hot.has(milestoneOfTick.get(id) ?? "")));
  // Full names for the milestones in focus, never over the tick targets under the pointer. Not while a relation's curve is hovered: a name
  // drawn over the curve would take the pointer off it.
  const inFocus = hover ? [hover, ...[...(hot ?? [])].filter((id) => id !== hover)] : tickSubject ? tickSubject.flatMap((id) => milestoneOfTick.get(id) ?? []) : [];
  const fullNames = focusLabels(layout, [...new Set(inFocus)], tickSubject
    ? targets.filter((target) => target.ticks.some((id) => tickSubject.includes(id))) : []);
  const pick = (ids: string[]) => {
    setPicked(ids);
    strip.current?.scrollIntoView({ block: "nearest" });
  };
  const lines = [...new Set(layout.edges.flatMap((edge) => edge.line ? [edge.line] : []))];
  const enter = (id: string) => { setHover(id); showLabels(`m:${id}`); };
  const leave = () => { setHover(null); hideLabels(); };
  const focus = (id: string) => ({ onMouseEnter: () => enter(id), onMouseLeave: leave, onFocus: () => enter(id), onBlur: leave });
  // A risk glyph is drawn only where it does not run into the next marker; the risk is in the marker's name and the drawer either way.
  const risky = riskGlyphsShown(layout, new Set(board.milestones.filter((item) => item.risks.length).map((item) => item.id)));
  // The relation labels asked for, placed where they cover no marker, milestone label, tick, risk glyph or other label; one that finds
  // no such spot is left out (its curve names it on hover).
  const asked = layout.edges.filter((edge) => edge.kind === "relation" && edge.label && (flow === edge.id || labelKey === `e:${edge.id}`
    || (labelKey?.startsWith("m:") && (edge.from === labelKey.slice(2) || edge.to === labelKey.slice(2)))));
  const placed = placeEdgeLabels(layout, asked.map((edge) => ({ id: edge.id, ...edgeLabelSize(edge.label!, Boolean(outgoing.get(edge.id)?.relation.artifact)) })),
    labelObstacles(layout, risky));
  const titleOf = new Map(layout.nodes.map((node) => [node.id, node.title]));
  const curveName = (edge: (typeof layout.edges)[number]) => {
    const relation = outgoing.get(edge.id)?.relation;
    return [`${edge.label ?? "飞轮关系"}：${titleOf.get(edge.from) ?? edge.from} → ${titleOf.get(edge.to) ?? edge.to}`, relation ? flowSummary(relation) : "",
      edge.pending ? "随下游里程碑一起批准" : ""].filter(Boolean).join("，");
  };
  const kinds = Object.keys(RELATION_KIND_LABEL).filter((kind) => layout.edges.some((edge) => edge.relationKind === kind));
  const open = (id: string, kind: "milestone" | "course") => setSelected(kind === "course" ? { kind: "course", id } : { kind: "milestone", id });
  const nameOf = (id: string, kind: "milestone" | "course", title: string) => {
    const data = kind === "milestone" ? byId.get(id) : undefined;
    const level = data ? riskLevelOf(data.risks) : null;
    return [title, data?.deadline ? `截止 ${md(data.deadline)}` : kind === "course" ? "课程分数线" : "未定日期", data?.status === "draft" ? "待批准" : "",
      data?.retrospective ? "已达成" : "", level ? `${MILESTONE_RISK_LEVEL_LABEL[level]}风险` : ""].filter(Boolean).join(" · ");
  };
  const todayLabelX = layout.years.some((year) => Math.abs(year.x - layout.todayX) < 40) ? layout.todayX + 40 : layout.todayX + 3;

  return <div className="mt" role="group" aria-label="里程碑时间轴" data-hover={hot ? "" : undefined}
    onKeyDown={(event) => { if (event.key === "Escape" && picked) setPicked(null); }}>
    {head}
    <FocusStrip ref={strip} layout={layout} board={board} milestoneId={hover} ticks={tickSubject} pinned={Boolean(picked) && !hover && (!tickHover || tickHover.join() === picked!.join())}
      onClose={() => setPicked(null)} onOpen={open} />
    <div className="mt-scroll" ref={frame}>
      <div className="mt-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true" className="mt-svg">
          {layout.axis.map((mark) => <g key={`${mark.kind}${mark.x}`}><line x1={mark.x} x2={mark.x} y1={TL.headH - 4} y2={layout.height} className={mark.kind === "month" ? "mt-grid-month" : "mt-grid"} />
            <text x={mark.x + 3} y={28} className={mark.kind === "month" ? "mt-axis-month" : "mt-axis"}>{mark.label}</text></g>)}
          {layout.years.map((year) => <g key={year.label}>
            {year.boundary && <line x1={year.x} x2={year.x} y1={2} y2={layout.height} className="mt-year-line" />}
            <text x={year.x + (year.boundary ? 4 : 0)} y={12} className="mt-year">{year.label}</text></g>)}
          {layout.datedEnd < layout.width - 30 && layout.nodes.some((node) => node.undated) && <text x={layout.datedEnd + 14} y={28} className="mt-axis">未定日期</text>}
          {layout.rows.map((row) => <g key={row.line} data-line={row.line}>
            <line x1={TL.labelW} x2={layout.width - 8} y1={row.axisY} y2={row.axisY} className="mt-axisline" />
            <line x1={0} x2={layout.width} y1={row.y + row.height} y2={row.y + row.height} className="mt-rowrule" /></g>)}
          {/* One arrowhead per line, inside a group carrying the line, so it takes the line's colour (`--lc`) like the edge it ends. */}
          <defs>{lines.map((line) => <g key={line} data-line={line}><marker id={`mt-arrow-${line.replace(/[^a-zA-Z0-9_-]/g, "_")}`} viewBox="0 0 8 8" refX="7" refY="4"
            markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="mt-arrowhead" /></marker></g>)}</defs>
          {layout.edges.map((edge) => <g key={edge.id} data-line={edge.line} data-hot={hot?.has(edge.id) || undefined} data-faint={edge.faint || undefined}
            className={edge.kind === "chain" ? "mt-edge mt-edge-chain" : "mt-edge mt-edge-relation"}>
            {/* Only a solid curve draws itself in: `pathLength` would rescale a dash pattern along with it. */}
            <path d={edge.path} {...(edge.kind === "relation" && !edge.pending && !edge.broken && (edge.relationKind ?? "enables") === "enables" ? { pathLength: 1 } : {})}
              data-pending={edge.pending || undefined} data-broken={edge.broken || undefined} data-kind={edge.relationKind}
              className={edge.kind === "chain" ? "mt-chain" : "mt-relation"} markerEnd={`url(#mt-arrow-${(edge.line ?? "").replace(/[^a-zA-Z0-9_-]/g, "_")})`} />
            {/* A wider invisible stroke to hover, naming the relation in a tooltip whether or not its label found room. */}
            {edge.kind === "relation" && <path d={edge.path} className="mt-edge-hit"
              onMouseEnter={() => { setEdgeHover(edge.id); showLabels(`e:${edge.id}`); }} onMouseLeave={() => { setEdgeHover(null); hideLabels(); }}>
              <title>{curveName(edge)}</title></path>}
          </g>)}
          {asked.map((edge) => {
            const box = placed.get(edge.id);
            return box && !outgoing.get(edge.id)?.relation.artifact
              ? <text key={edge.id} x={box.x + box.w / 2} y={box.y + 12} textAnchor="middle" className="mt-relation-label">{edge.label}</text> : null;
          })}
          <line x1={layout.todayX} x2={layout.todayX} y1={TL.headH - 4} y2={layout.height} className="mt-today" />
          <text x={todayLabelX} y={12} className="mt-today-label">今天</text>
          {layout.ticks.map((item) => <g key={item.id} data-line={item.line}>
            {item.plannedX !== null && <circle cx={item.plannedX} cy={item.axisY} r={3} className="mt-tick-ghost" data-hot={hotTick(item.id) || undefined} />}
          </g>)}
        </svg>
        {asked.filter((edge) => placed.get(edge.id) && outgoing.get(edge.id)?.relation.artifact).map((edge) => {
          const { relation, from } = outgoing.get(edge.id)!;
          const box = placed.get(edge.id)!;
          return <div key={edge.id} className="mt-flow" style={{ left: box.x, top: box.y }} data-line={edge.line} data-hot={hot?.has(edge.id) || undefined}>
            <button type="button" className="mt-flow-chip" data-pending={edge.pending || undefined} data-broken={edge.broken || undefined}
              aria-label={`${edge.label ?? "飞轮关系"}：${flowSummary(relation)}`} aria-expanded={flow === edge.id}
              onMouseEnter={() => { holdLabels(); setFlow(edge.id); }} onMouseLeave={() => { setFlow(null); hideLabels(); }}
              onFocus={() => { holdLabels(); setFlow(edge.id); }} onBlur={() => { setFlow(null); hideLabels(); }}
              onClick={() => setFlow(flow === edge.id ? null : edge.id)}>{edge.label}</button>
            {flow === edge.id && <FlowCard relation={relation} from={from} labels={board.labels} />}
          </div>;
        })}
        {layout.rows.map((row) => {
          const waiting = drafts.filter((item) => item.identityId === row.line).length;
          return <div key={row.line} className="mt-line" data-line={row.line} style={{ top: row.y, height: row.height, width: TL.labelW - 6 }}>
            <b>{board.labels[row.line] ?? row.line}</b>{waiting > 0 && <small className="mt-line-waiting">{waiting} 待批准</small>}</div>;
        })}
        {/* Each dot and each dashed ghost is a target as wide as its neighbours allow; the dots are drawn inside it. */}
        {targets.map((target) => {
          const name = target.ticks.map((id) => {
            const data = ticksById.get(id);
            return data ? `${data.outcome} · ${tickStory(data).status}${target.points.some((point) => point.id === id && point.ghost) ? " · 原定日" : ""}` : "";
          }).filter(Boolean).join("；");
          const isPicked = Boolean(picked && target.ticks.every((id) => picked.includes(id)));
          return <button key={target.key} type="button" className="mt-tick-hit" data-line={target.line} data-over={target.over || undefined}
            data-hot={target.ticks.some(hotTick) || undefined} data-picked={isPicked || undefined} aria-pressed={isPicked}
            tabIndex={target.ghostOnly ? -1 : undefined} style={{ left: target.x, top: target.y, width: target.w, height: target.h }}
            aria-label={name} title={name} onMouseEnter={() => setTickHover(target.ticks)} onMouseLeave={() => setTickHover(null)}
            onFocus={() => setTickHover(target.ticks)} onBlur={() => setTickHover(null)} onClick={() => pick(target.ticks)}>
            {target.points.filter((point) => !point.ghost).map((point) =>
              <i key={point.id} className="mt-tick" data-state={ticksById.get(point.id)?.state} style={{ left: point.x - target.x - 6, top: TICK_HIT.up - 6 }} />)}
          </button>;
        })}
        {layout.nodes.map((item) => {
          const data = item.kind === "milestone" ? byId.get(item.id) : undefined;
          const level = data ? riskLevelOf(data.risks) : null;
          const name = nameOf(item.id, item.kind, item.title);
          return <div key={item.id}>
            <button type="button" className="mt-marker" data-line={item.line} data-kind={item.kind} data-status={item.status}
              data-reached={data?.retrospective ? "" : undefined} data-hot={hot?.has(item.id) || undefined} {...focus(item.id)}
              style={{ left: item.x - 11, top: item.axisY - 11 }} aria-label={name} title={name} onClick={() => open(item.id, item.kind)}><i /></button>
            {level && risky.has(item.id) && <span className="mt-risk" style={{ left: riskBox(item).x, top: riskBox(item).y }} title={data!.risks.map((risk) => MILESTONE_RISK_KIND_LABEL[risk.kind]).join("、")}>
              <RiskGlyph level={level} /></span>}
            {(fullNames.has(item.id) || item.labelW > 0) && <button type="button" className="mt-node" data-line={item.line} data-kind={item.kind} data-status={item.status}
              data-hot={hot?.has(item.id) || undefined} data-full={fullNames.has(item.id) || undefined} {...focus(item.id)} tabIndex={-1} title={name}
              style={fullNames.has(item.id) ? { left: fullNames.get(item.id)!.x, top: fullNames.get(item.id)!.y, width: fullNames.get(item.id)!.w }
                : { left: item.labelX, top: item.labelY, width: item.labelW }} onClick={() => open(item.id, item.kind)}>{item.title}</button>}
          </div>;
        })}
      </div>
    </div>
    <p className="mt-legend"><span><span className="mt-key" data-k="milestone" />已批准</span>
      {drafts.length > 0 && <span><span className="mt-key" data-k="draft" />待批准</span>}
      {board.milestones.some((item) => item.retrospective) && <span><span className="mt-key" data-k="reached" />已达成</span>}
      {board.milestones.some((item) => item.risks.length) && <span><RiskGlyph level="medium" />风险等级</span>}
      {board.courses.length > 0 && <span><span className="mt-key" data-k="course" />课程分数线</span>}
      {layout.ticks.length > 0 && <span><span className="mt-key" data-k="done" />已达成刻度</span>}
      {layout.ticks.length > 0 && <span><span className="mt-key" data-k="planned" />计划刻度</span>}
      {layout.ticks.some((item) => item.state === "postponed") && <span><span className="mt-key" data-k="postponed" />已顺延</span>}
      {layout.ticks.some((item) => item.plannedX !== null) && <span><span className="mt-key" data-k="ghost" />顺延前的原定日</span>}      {layout.edges.some((edge) => edge.kind === "chain") && <span><span className="mt-key" data-k="chain" />前后依赖</span>}
      {/* A relation's kind is its line style; its name shows when the curve or one of its milestones is hovered. */}
      {kinds.map((kind) => <span key={kind}><svg className="mt-kind-svg" width={26} height={6} aria-hidden="true">
        <line x1={1} x2={25} y1={3} y2={3} className="mt-kind-key" data-kind={kind} /></svg>{RELATION_KIND_LABEL[kind]}</span>)}
      {layout.edges.some((edge) => edge.kind === "relation" && !edge.relationKind) && <span><span className="mt-key" data-k="relation" />飞轮关系</span>}
      {layout.edges.some((edge) => edge.kind === "relation" && edge.pending) && <span><svg className="mt-kind-svg" width={26} height={6} aria-hidden="true">
        <line x1={1} x2={25} y1={3} y2={3} className="mt-kind-key" data-pending="" /></svg>候选关系</span>}
      {layout.edges.some((edge) => edge.broken) && <span><span className="mt-key" data-k="broken" />时间顺序不成立</span>}</p>
    {milestone && <MilestoneDrawer milestone={milestone} labels={board.labels} onClose={closeDrawer} />}
    {course && <CourseDrawer course={course} milestones={board.milestones.filter((item) => item.projectId === course.projectId)} onClose={() => setSelected(null)} />}
  </div>;
}

/** At most this many ticks are explained at once in the strip; the rest are counted. */
const STRIP_TICKS = 4;

/**
 * The strip above the timeline, of fixed height so the canvas never moves under the pointer: the milestone in focus in full (title, line,
 * deadline and days left, state, risk with its kinds, and the milestones it is joined to), or the ticks under the pointer or picked (what
 * the tick is, its state and day, for a postponed one the day it was due and why it moved, its step, task and milestone, and a link to the
 * task). A picked tick stays until closed.
 */
export function FocusStrip({ ref, layout, board, milestoneId, ticks, pinned, onClose, onOpen }: { ref?: Ref<HTMLDivElement>; layout: TimelineLayout; board: MilestoneBoard;
  milestoneId: string | null; ticks: string[] | null; pinned: boolean; onClose: () => void; onOpen: (id: string, kind: "milestone" | "course") => void }) {
  const byId = new Map(board.milestones.map((item) => [item.id, item]));
  const titleOf = (id: string) => byId.get(id)?.title ?? layout.nodes.find((node) => node.id === id)?.title ?? id;
  const lineName = (line: string) => board.labels[line] ?? line;
  let body: ReactNode = <p className="mt-focus-hint">指向或点选里程碑、刻度，这里显示全名、日期、状态与关联；点刻度后说明会保留到关闭。</p>;
  let line: string | undefined;
  if (milestoneId?.startsWith("course:")) {
    const course = board.courses.find((item) => `course:${item.projectId}` === milestoneId);
    if (course) {
      line = course.identityId;
      body = <>
        <p className="mt-focus-title"><b>{course.name} · {course.value}</b> <Tag>课程分数线</Tag>{course.proposed && <Tag tone="warn">待批准</Tag>}</p>
        <p className="mt-focus-meta">{lineName(course.identityId)}{course.endDay ? <> · <span className="mono">课程结束 {md(course.endDay)}</span></> : null}</p>
        {course.why && <p className="mt-focus-meta gen">{course.why}</p>}
      </>;
    }
  } else if (milestoneId) {
    const milestone = byId.get(milestoneId);
    if (milestone) {
      line = milestone.identityId;
      const level = riskLevelOf(milestone.risks);
      const joined = connectionsOf(layout, milestone.id);
      const names = (ids: string[]) => ids.map((id) => `「${titleOf(id)}」`).join("、");
      body = <>
        <p className="mt-focus-title"><b>{milestone.title}</b>{" "}
          {milestone.status === "draft" ? <Tag tone="warn">待批准</Tag> : <Tag>已批准</Tag>}
          {milestone.retrospective && <Tag tone="ok">已达成</Tag>}
          {level && <Tag tone={level === "high" ? "risk" : "warn"} title={milestone.risks.map((risk) => risk.note).join("；")}>
            {MILESTONE_RISK_LEVEL_LABEL[level]}风险 · {[...new Set(milestone.risks.map((risk) => MILESTONE_RISK_KIND_LABEL[risk.kind]))].join("、")}</Tag>}</p>
        <p className="mt-focus-meta">{lineName(milestone.identityId)}{milestone.projectName ? ` · ${milestone.projectName}` : ""} · {milestone.deadline
          ? <span className="mono">截止 {md(milestone.deadline)}{milestone.daysLeft !== undefined ? milestone.daysLeft >= 0 ? `，还有 ${milestone.daysLeft} 天` : `，已过 ${-milestone.daysLeft} 天` : ""}</span>
          : "未定日期"}{milestone.ticks.length > 0 ? <> · <span className="mono">刻度 {milestone.ticks.filter((item) => item.state === "done").length}/{milestone.ticks.length}</span></> : null}</p>
        {(joined.before.length > 0 || joined.after.length > 0 || joined.relations.length > 0) && <p className="mt-focus-meta">
          {[joined.before.length ? `前置 ${names(joined.before)}` : "", joined.after.length ? `后续 ${names(joined.after)}` : "",
            ...joined.relations.map((relation) => `${relation.label ?? "飞轮关系"}${relation.pending ? " · 候选" : ""} ${relation.direction === "out" ? "→" : "←"} 「${titleOf(relation.other)}」`)]
            .filter(Boolean).join("；")}</p>}
      </>;
    }
  } else if (ticks?.length) {
    const all = board.milestones.flatMap((milestone) => milestone.ticks.map((item) => ({ item, milestone })));
    const shown = ticks.flatMap((id) => all.find((entry) => entry.item.id === id) ?? []);
    line = shown[0]?.milestone.identityId;
    body = <>
      {pinned && <button type="button" className="ui-icon-button mt-focus-close" aria-label="关闭刻度说明" onClick={onClose}>×</button>}
      {shown.slice(0, STRIP_TICKS).map(({ item, milestone }) => {
        const story = tickStory(item);
        return <article key={item.id} className="mt-focus-tick">
          <p className="mt-focus-title"><Tag tone={item.state === "done" ? "ok" : item.state === "postponed" ? "warn" : "neutral"}>{story.status}刻度</Tag>{" "}
            <b className="gen">{item.outcome}</b> <span className="mono">{story.when}</span></p>
          {story.why && <p className="mt-focus-meta">{story.why}</p>}
          <p className="mt-focus-meta">步骤「<span className="gen">{item.stepTitle}</span>」 · 任务「<span className="gen">{item.taskTitle}</span>」 · 里程碑{" "}
            <button type="button" className="text-button" onClick={() => onOpen(milestone.id, "milestone")}>{milestone.title}</button>{" "}
            · <a href={`/workbench/${encodeURIComponent(item.workOrderId)}`}>打开任务</a></p>
        </article>;
      })}
      {shown.length > STRIP_TICKS && <p className="mt-focus-meta">同一处另有 {shown.length - STRIP_TICKS} 个刻度，放大窗口或在里程碑详情里查看。</p>}
    </>;
  }
  return <div ref={ref} className="mt-focus" data-line={line} data-pinned={pinned || undefined} aria-live="polite">{body}</div>;
}

const mdOf = (day?: string) => day ? md(day) : "—";
const amountOf = (relation: BoardRelation) => relation.transfer ? `${relation.transfer.expected} ${relation.transfer.unit}${relation.transfer.metric}` : "";
const flowSummary = (relation: BoardRelation) => [relation.artifact ? `产物「${relation.artifact.title}」` : "", amountOf(relation) ? `预期 ${amountOf(relation)}` : "",
  relation.checkOn ? `核对日 ${md(relation.checkOn)}` : "", relation.broken ? "时间顺序不成立" : ""].filter(Boolean).join("，");

/** What a cross-line edge carries, on hover or focus: the artifact, the transfer expected and measured, the check day and the counterfactual. */
function FlowCard({ relation, from, labels }: { relation: BoardRelation; from: BoardMilestone; labels: Record<string, string> }) {
  return <div className="mt-flow-card" role="tooltip">
    <b>{labels[from.identityId] ?? from.identityId} → {labels[relation.otherLine] ?? relation.otherLine}</b>
    <dl>
      <dt>产物</dt><dd className="gen">{relation.artifact?.title}{relation.artifact?.kind ? ` · ${relation.artifact.kind}` : ""}</dd>
      <dt>传递量</dt><dd><span className="mono">预期 {amountOf(relation)}</span>{" / "}<span className="mono">实测 {relation.transfer?.measured === null || relation.transfer?.measured === undefined ? "—" : `${relation.transfer.measured} ${relation.transfer.unit}`}</span></dd>
      <dt>核对日</dt><dd className="mono">{mdOf(relation.checkOn)}{relation.transfer?.lagDays ? ` · 传递 ${relation.transfer.lagDays} 天` : ""}</dd>
      <dt>反事实</dt><dd className="gen">{relation.counterfactual}{relation.transfer?.hoursSaved ? `（约 ${relation.transfer.hoursSaved} 小时）` : ""}</dd>
    </dl>
    {relation.broken && <p className="mt-flow-broken">时间顺序不成立：{relation.broken}</p>}
    {relation.pending && <small>随下游里程碑「{relation.otherTitle}」一起批准</small>}
  </div>;
}

/** How many of these milestones carry a highest risk of each level, and how many none; the kinds with their counts. */
export function riskTally(milestones: Array<{ risks: MilestoneRisk[] }>) {
  const levels = { high: 0, medium: 0, low: 0, none: 0 };
  const kinds = new Map<MilestoneRisk["kind"], number>();
  for (const item of milestones) {
    levels[riskLevelOf(item.risks) ?? "none"] += 1;
    for (const risk of item.risks) kinds.set(risk.kind, (kinds.get(risk.kind) ?? 0) + 1);
  }
  return { levels, kinds: [...kinds].sort((a, b) => b[1] - a[1]) };
}

/**
 * 「一键批准」: every draft at once, after their risks are shown together — how many carry a high, medium, low or no risk as bars, the
 * kinds as tags with counts, and each draft with its glyph and kinds, line by line. The approval is the existing batch route.
 */
function BatchApprove({ drafts, labels, lineOrder, label, title }: { drafts: BoardMilestone[]; labels: Record<string, string>; lineOrder: string[];
  label?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("");
  const tally = riskTally(drafts);
  const lines = [...new Set(drafts.map((item) => item.identityId))].sort((a, b) => lineOrder.indexOf(a) - lineOrder.indexOf(b));
  const approve = async () => {
    setState("批准中…");
    const response = await fetch("/api/milestones/approve-batch", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: drafts.map((item) => item.id), decision: "approved" }) }).catch(() => undefined);
    const result = await response?.json().catch(() => null) as { skipped?: unknown[] } | null;
    if (!response?.ok || !result) { setState("未完成，请刷新后重试"); return; }
    if (result.skipped?.length) { setState(`${result.skipped.length} 个已变化，其余已批准；刷新后查看`); return; }
    location.reload();
  };
  const rows: Array<[MilestoneRiskLevel | "none", string]> = [["high", "高"], ["medium", "中"], ["low", "低"], ["none", "无"]];
  return <Sheet title={title ?? `批准 ${drafts.length} 个里程碑草稿`} open={open} onOpenChange={(value) => { setOpen(value); if (!value) setState(""); }}
    trigger={<button type="button" className="primary-button">{label ?? `一键批准 ${drafts.length} 个`}</button>}
    footer={<div className="md-actions">
      <button type="button" className="primary-button" disabled={Boolean(state)} onClick={() => void approve()}>批准全部 {drafts.length} 个</button>
      <button type="button" disabled={state === "批准中…"} onClick={() => setOpen(false)}>取消</button>
      {state && <span role="status">{state}</span>}
    </div>}>
    <div className="ba">
      <section className="ba-levels" aria-label="风险等级分布">
        {rows.map(([level, label]) => <div key={level} className="ba-level">
          <RiskGlyph level={level === "none" ? null : level} /><span>{label}</span>
          <span className="ba-bar" aria-hidden="true"><i data-level={level} style={{ width: `${(tally.levels[level] / drafts.length) * 100}%` }} /></span>
          <b className="mono">{tally.levels[level]}</b></div>)}
      </section>
      {tally.kinds.length > 0 && <p className="ba-kinds">{tally.kinds.map(([kind, count]) => <span key={kind} className="risk-kind">{MILESTONE_RISK_KIND_LABEL[kind]} × {count}</span>)}</p>}
      <p className="muted ba-note">批准后，审查出的中、高风险会在今日页单独询问：接受才让它们的任务提前 1–2 天排完。</p>
      {lines.map((line) => <section key={line} className="ba-line" data-line={line} aria-label={labels[line] ?? line}>
        <h3>{labels[line] ?? line}</h3>
        <ul>{drafts.filter((item) => item.identityId === line).sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9")).map((item) =>
          <li key={item.id}><RiskGlyph level={riskLevelOf(item.risks)} /><span className="mono">{item.deadline ? md(item.deadline) : "未定"}</span>
            <span className="ba-title">{item.title}</span>
            <span className="ba-tags">{item.risks.map((risk) => <span key={risk.kind} className="risk-kind" data-level={risk.level} title={risk.note}>{MILESTONE_RISK_KIND_LABEL[risk.kind]}</span>)}</span>
          </li>)}</ul>
      </section>)}
    </div>
  </Sheet>;
}

/**
 * 「按主线」: each line with drafts on one row — its name, how many drafts, how many carry a high, medium or low risk (glyph and count) —
 * and 「批准这条主线」, which shows that line's risks first, as 「一键批准」 does for all of them, then approves the line's drafts.
 */
export function LineApprovals({ id, drafts, labels, lineOrder }: { id: string; drafts: BoardMilestone[]; labels: Record<string, string>; lineOrder: string[] }) {
  const lines = [...new Set(drafts.map((item) => item.identityId))].sort((a, b) => lineOrder.indexOf(a) - lineOrder.indexOf(b));
  return <ul id={id} className="ba-lines" aria-label="按主线批准">
    {lines.map((line) => {
      const own = drafts.filter((item) => item.identityId === line);
      const { levels } = riskTally(own);
      const name = labels[line] ?? line;
      return <li key={line} data-line={line}>
        <b className="ba-lines-name">{name}</b>
        <span className="mono">{own.length} 个</span>
        <span className="ba-lines-risks" aria-label={`高风险 ${levels.high}、中风险 ${levels.medium}、低风险 ${levels.low}`}>
          {(["high", "medium", "low"] as const).filter((level) => levels[level]).map((level) =>
            <span key={level} className="ba-lines-risk"><RiskGlyph level={level} /><span className="mono">{levels[level]}</span></span>)}
          {!levels.high && !levels.medium && !levels.low && <span className="muted">无风险</span>}
        </span>
        <BatchApprove drafts={own} labels={labels} lineOrder={lineOrder} label="批准这条主线" title={`批准「${name}」的 ${own.length} 个里程碑草稿`} />
      </li>;
    })}
  </ul>;
}

/** The week in figures, from the ledger: ticks reached against planned, outputs reused by another line, and the nearest deadline. */
export function MilestoneStats({ board }: { board: MilestoneBoard }) {
  const { ticksDone, ticksPlanned, reuse, nearest } = board.stats;
  const share = ticksPlanned ? Math.min(1, ticksDone / ticksPlanned) : 0;
  return <section className="mt-stats" aria-label="本周进展">
    <span className="mt-stat"><b className="mono">{ticksDone}<small> / {ticksPlanned}</small></b><span>本周刻度</span>
      <span className="mt-stat-bar" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span></span>
    <span className="mt-stat"><b className="mono">{reuse}</b><span>跨主线复用</span></span>
    {nearest && <span className="mt-stat" data-line={nearest.line}><b className="mono hl-line">{nearest.days} 天</b><span className="mt-stat-title">距 {nearest.title}</span></span>}
  </section>;
}

/**
 * What the last design run says beyond the drafts (W-26/W-27): lines it has not reached yet — drafts arrive one line at a time, and a
 * page that stopped saying 「还在设计」 after the first line looked finished — and lines it left without drafts, with why and what to do.
 */
export function DraftingNotes({ board }: { board: Pick<MilestoneBoard, "drafting" | "labels"> }) {
  const pending = board.drafting?.pending ?? [];
  const missing = Object.entries(board.drafting?.missing ?? {});
  if (!pending.length && !missing.length) return null;
  const name = (line: string) => board.labels[line] ?? line;
  return <div className="mt-drafting" role="status">
    {pending.length > 0 && <p>还在设计其余 {pending.length} 条线的草稿：{pending.map(name).join("、")}（每条几分钟），全部出来后再一起批准。</p>}
    {missing.map(([line, why]) => <p key={line} data-line={line}>
      <b className="hl-line">{name(line)}</b> 没有草稿：{why} 可以在这条线卡片的「访谈」里补几句，再点「让 AI 重新提议草稿」。</p>)}
  </div>;
}
