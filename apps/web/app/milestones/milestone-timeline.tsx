"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MILESTONE_RISK_KIND_LABEL, MILESTONE_RISK_LEVEL_LABEL, RELATION_KIND_LABEL, riskLevelOf, type MilestoneRisk, type MilestoneRiskLevel } from "@crossline/core";
import { RiskGlyph } from "./risk-glyph";
import type { BoardMilestone, BoardRelation, BoardTick, MilestoneBoard } from "../../lib/milestone-board";
import { Sheet } from "../ui/overlay";
import { useReturnState } from "../ui/return-state";
import { TL, edgeLabelSize, labelObstacles, layoutTimeline, placeEdgeLabels, riskBox, riskGlyphsShown } from "./timeline-model";

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
 */
export function MilestoneTimeline({ board, actions }: { board: MilestoneBoard; actions?: ReactNode }) {
  const [selected, setSelected] = useState<{ kind: "milestone"; id: string } | { kind: "course"; id: string } | null>(null);
  const [tick, setTick] = useState<BoardTick | null>(null);
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
  </header>;
  if (!layout.nodes.length) return <div className="mt">{head}<p className="flow-empty">{board.firstDrafts === "running"
    ? "系统正在按访谈为每条主线设计里程碑草稿（每条主线几分钟），好了会出现在这里等待批准。"
    : board.firstDrafts === "stalled" ? "里程碑草稿没有生成，点上方「让 AI 重新提议草稿」再试一次。" : "尚无里程碑。访谈结束（或达到开始标准后停下 20 分钟）时系统自动设计草稿；也可以点上方「让 AI 重新提议草稿」。"}</p></div>;
  const milestone = selected?.kind === "milestone" ? board.milestones.find((item) => item.id === selected.id) : undefined;
  const course = selected?.kind === "course" ? board.courses.find((item) => `course:${item.projectId}` === selected.id) : undefined;
  const byId = new Map(board.milestones.map((item) => [item.id, item]));
  const ticksById = new Map(board.milestones.flatMap((item) => item.ticks.map((t) => [t.id, t] as const)));
  const outgoing = new Map<string, { relation: BoardRelation; from: BoardMilestone }>(board.milestones.flatMap((item) => item.relations.filter((relation) => relation.direction === "out")
    .map((relation) => [`relation:${relation.id}`, { relation, from: item }] as const)));
  const hot = hover ? new Set(layout.edges.filter((edge) => edge.from === hover || edge.to === hover).flatMap((edge) => [edge.id, edge.from, edge.to]).concat(hover))
    : edgeHover ? new Set(layout.edges.filter((edge) => edge.id === edgeHover).flatMap((edge) => [edge.id, edge.from, edge.to])) : null;
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

  return <div className="mt" role="group" aria-label="里程碑时间轴" data-hover={hover || edgeHover ? "" : undefined}>
    {head}
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
            {item.plannedX !== null && <circle cx={item.plannedX} cy={item.axisY} r={3} className="mt-tick-ghost" />}
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
        {layout.ticks.map((item) => {
          const data = ticksById.get(item.id)!;
          return <button key={item.id} type="button" className="mt-tick" data-line={item.line} data-state={item.state}
            style={{ left: item.x - 6, top: item.axisY - 6 }} aria-label={`${data.outcome} · ${item.state === "done" ? "已达成" : item.state === "postponed" ? "已顺延" : "计划中"}`}
            title={`${data.outcome}${data.day ? ` · ${md(data.day)}` : ""}${item.state === "postponed" ? " · 已顺延" : ""}`} onClick={() => setTick(data)} />;
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
            {item.labelW > 0 && <button type="button" className="mt-node" data-line={item.line} data-kind={item.kind} data-status={item.status}
              data-hot={hot?.has(item.id) || undefined} {...focus(item.id)} tabIndex={-1} title={name}
              style={{ left: item.labelX, top: item.labelY, width: item.labelW }} onClick={() => open(item.id, item.kind)}>{item.title}</button>}
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
      {layout.edges.some((edge) => edge.kind === "chain") && <span><span className="mt-key" data-k="chain" />前后依赖</span>}
      {/* A relation's kind is its line style; its name shows when the curve or one of its milestones is hovered. */}
      {kinds.map((kind) => <span key={kind}><svg className="mt-kind-svg" width={26} height={6} aria-hidden="true">
        <line x1={1} x2={25} y1={3} y2={3} className="mt-kind-key" data-kind={kind} /></svg>{RELATION_KIND_LABEL[kind]}</span>)}
      {layout.edges.some((edge) => edge.kind === "relation" && !edge.relationKind) && <span><span className="mt-key" data-k="relation" />飞轮关系</span>}
      {layout.edges.some((edge) => edge.kind === "relation" && edge.pending) && <span><svg className="mt-kind-svg" width={26} height={6} aria-hidden="true">
        <line x1={1} x2={25} y1={3} y2={3} className="mt-kind-key" data-pending="" /></svg>候选关系</span>}
      {layout.edges.some((edge) => edge.broken) && <span><span className="mt-key" data-k="broken" />时间顺序不成立</span>}</p>
    {tick && <div className="mt-result" role="dialog" aria-label="刻度结果">
      <header><b>{tick.state === "done" ? "已达成" : tick.state === "postponed" ? "已顺延" : "计划中"}</b>
        <button type="button" className="ui-icon-button" aria-label="关闭" onClick={() => setTick(null)}>×</button></header>
      <p className="gen">{tick.outcome}</p>
      <small>{tick.taskTitle}{tick.day ? ` · ${tick.state === "done" ? "完成于" : "排在"} ${md(tick.day)}` : ""}{tick.state === "postponed" && tick.plannedDay ? ` · 原计划 ${md(tick.plannedDay)}` : ""}</small>
      <a href={`/workbench/${encodeURIComponent(tick.workOrderId)}`}>打开任务</a>
    </div>}
    {milestone && <MilestoneDrawer milestone={milestone} labels={board.labels} onClose={closeDrawer} />}
    {course && <CourseDrawer course={course} milestones={board.milestones.filter((item) => item.projectId === course.projectId)} onClose={() => setSelected(null)} />}
  </div>;
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
