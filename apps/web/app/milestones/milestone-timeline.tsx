"use client";

import { useEffect, useState } from "react";
import type { BoardMilestone, BoardTick, MilestoneBoard } from "../../lib/milestone-board";
import { Bullet } from "../ui/charts";
import { TL, layoutTimeline } from "./timeline-model";
import { MilestoneDrawer, CourseDrawer } from "./milestone-drawer";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/**
 * The lines on one date axis. A milestone is a ◆ at its deadline (dashed while a draft), a course's score line is a ★ at the end of its
 * chain, and the dots before a milestone are its ticks: filled when reached, hollow when ahead, hollow and dashed with a faint mark at the
 * old date when moved. A reached tick opens its result card; a reused output's arc to another line moves. Clicking a marker opens the
 * drawer with everything about it.
 */
export function MilestoneTimeline({ board }: { board: MilestoneBoard }) {
  const [selected, setSelected] = useState<{ kind: "milestone"; id: string } | { kind: "course"; id: string } | null>(null);
  const [tick, setTick] = useState<BoardTick | null>(null);
  // `?open=<id>` (a link from another page, such as the weekly review) opens that milestone's drawer.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("open");
    if (id && board.milestones.some((item) => item.id === id)) setSelected({ kind: "milestone", id });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const courseNodes = board.courses.map((course) => ({ id: `course:${course.projectId}`, line: course.identityId, title: `${course.name} · ${course.value}`,
    status: "approved" as const, kind: "course" as const, day: course.endDay ? new Date(Date.parse(`${course.endDay}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10) : undefined, dependsOn: [] }));
  const layout = layoutTimeline({
    nodes: [...board.milestones.map((milestone) => ({ id: milestone.id, line: milestone.identityId, title: milestone.title, status: milestone.status,
      kind: "milestone" as const, day: milestone.deadline, dependsOn: milestone.dependsOn })), ...courseNodes],
    ticks: board.milestones.flatMap((milestone) => milestone.ticks.map((item) => ({ id: item.id, milestoneId: milestone.id, line: milestone.identityId,
      day: item.day, state: item.state, plannedDay: item.plannedDay }))),
    relations: board.milestones.flatMap((milestone) => milestone.relations.filter((relation) => relation.direction === "out")
      .map((relation) => ({ id: relation.id, from: milestone.id, to: relation.otherId, pending: relation.pending }))),
    lineOrder: board.lineOrder, today: board.today
  });
  if (!layout.nodes.length) return <p className="flow-empty">尚无里程碑。完成初始访谈后生成里程碑草稿。</p>;
  const milestone = selected?.kind === "milestone" ? board.milestones.find((item) => item.id === selected.id) : undefined;
  const course = selected?.kind === "course" ? board.courses.find((item) => `course:${item.projectId}` === selected.id) : undefined;
  const byId = new Map(board.milestones.map((item) => [item.id, item]));
  const ticksById = new Map(board.milestones.flatMap((item) => item.ticks.map((t) => [t.id, t] as const)));

  const drafts = board.milestones.filter((item) => item.status === "draft");
  return <div className="mt" role="group" aria-label="里程碑时间轴">
    {drafts.length > 0 && <DraftReview drafts={drafts} labels={board.labels} lineOrder={board.lineOrder} onOpen={(id) => setSelected({ kind: "milestone", id })} />}
    <div className="mt-scroll">
      <div className="mt-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true" className="mt-svg">
          {layout.axis.map((mark) => <g key={mark.x}><line x1={mark.x} x2={mark.x} y1={TL.headH - 6} y2={layout.height} className={mark.month ? "mt-grid-month" : "mt-grid"} />
            <text x={mark.x + 3} y={16} className={mark.month ? "mt-axis-month" : "mt-axis"}>{mark.label}</text></g>)}
          {layout.datedEnd < layout.width - 30 && <text x={layout.datedEnd + 12} y={16} className="mt-axis">未定日期</text>}
          {layout.rows.map((row) => <g key={row.line} data-line={row.line}>
            <line x1={TL.labelW} x2={layout.width - 12} y1={row.axisY} y2={row.axisY} className="mt-axisline" />
            <line x1={0} x2={layout.width} y1={row.y + row.height} y2={row.y + row.height} className="mt-rowrule" /></g>)}
          {layout.edges.filter((edge) => edge.kind === "chain").map((edge) => <path key={edge.id} d={edge.path} data-line={edge.line} className="mt-chain" />)}
          {layout.edges.filter((edge) => edge.kind === "relation").map((edge) => <path key={edge.id} d={edge.path} {...(edge.pending ? {} : { pathLength: 1 })} className="mt-relation" data-pending={edge.pending || undefined} />)}
          <line x1={layout.todayX} x2={layout.todayX} y1={TL.headH - 6} y2={layout.height} className="mt-today" />
          <text x={layout.todayX + 3} y={TL.headH - 8} className="mt-today-label">今天</text>
          {layout.ticks.map((item) => <g key={item.id} data-line={item.line}>
            {item.plannedX !== null && <circle cx={item.plannedX} cy={item.axisY} r={3} className="mt-tick-ghost" />}
          </g>)}
        </svg>
        {layout.rows.map((row) => <div key={row.line} className="mt-line" data-line={row.line} style={{ top: row.y, height: row.height, width: TL.labelW - 8 }}>
          <b>{board.labels[row.line] ?? row.line}</b></div>)}
        {layout.ticks.map((item) => {
          const data = ticksById.get(item.id)!;
          return <button key={item.id} type="button" className="mt-tick" data-line={item.line} data-state={item.state}
            style={{ left: item.x - 6, top: item.axisY - 6 }} aria-label={`${data.outcome} · ${item.state === "done" ? "已达成" : item.state === "postponed" ? "已顺延" : "计划中"}`}
            title={`${data.outcome}${data.day ? ` · ${md(data.day)}` : ""}${item.state === "postponed" ? " · 已顺延" : ""}`} onClick={() => setTick(data)} />;
        })}
        {layout.nodes.map((item) => {
          const data = item.kind === "milestone" ? byId.get(item.id) : undefined;
          const threshold = data?.criteria.find((criterion) => criterion.threshold)?.threshold;
          const met = data ? data.criteria.filter((criterion) => criterion.quarters === 4).length : 0;
          return <div key={item.id}>
            <span className="mt-marker" data-line={item.line} data-kind={item.kind} data-status={item.status} style={{ left: item.x - 8, top: item.axisY - 8 }} aria-hidden="true" />
            <button type="button" className="mt-node" data-line={item.line} data-kind={item.kind} data-status={item.status}
              style={{ left: item.undated ? item.x : item.x - 10, top: item.labelY, width: TL.nodeW }}
              onClick={() => setSelected(item.kind === "course" ? { kind: "course", id: item.id } : { kind: "milestone", id: item.id })}>
              <b>{item.title}</b>
              <small>{item.kind === "course" ? "课程分数线" : data?.deadline ? `${md(data.deadline)}${data.daysLeft !== undefined && data.daysLeft >= 0 ? ` · ${data.daysLeft} 天` : ""}` : "未定日期"}
                {item.status === "draft" ? " · 草稿" : ""}{data && data.criteria.length ? ` · ${met}/${data.criteria.length}` : ""}</small>
              {threshold && <Bullet label={item.title} target={threshold.value} max={Math.max(threshold.value, threshold.bare ?? 0) * 1.15 || 100}
                {...(threshold.bare !== undefined ? { bare: threshold.bare } : {})} unit={threshold.unit} />}
            </button>
          </div>;
        })}
      </div>
    </div>
    <p className="mt-legend"><span><span className="mt-key" data-k="milestone" />里程碑</span>
      {board.courses.length > 0 && <span><span className="mt-key" data-k="course" />课程分数线</span>}
      {layout.ticks.length > 0 && <span><span className="mt-key" data-k="done" />已达成刻度</span>}
      {layout.ticks.length > 0 && <span><span className="mt-key" data-k="planned" />计划刻度</span>}
      {layout.ticks.some((item) => item.state === "postponed") && <span><span className="mt-key" data-k="postponed" />已顺延</span>}
      {layout.edges.some((edge) => edge.kind === "relation") && <span><span className="mt-key" data-k="relation" />主线间复用</span>}</p>
    {tick && <div className="mt-result" role="dialog" aria-label="刻度结果">
      <header><b>{tick.state === "done" ? "已达成" : tick.state === "postponed" ? "已顺延" : "计划中"}</b>
        <button type="button" className="ui-icon-button" aria-label="关闭" onClick={() => setTick(null)}>×</button></header>
      <p className="gen">{tick.outcome}</p>
      <small>{tick.taskTitle}{tick.day ? ` · ${tick.state === "done" ? "完成于" : "排在"} ${md(tick.day)}` : ""}{tick.state === "postponed" && tick.plannedDay ? ` · 原计划 ${md(tick.plannedDay)}` : ""}</small>
      <a href={`/workbench/${encodeURIComponent(tick.workOrderId)}`}>打开任务</a>
    </div>}
    {milestone && <MilestoneDrawer milestone={milestone} labels={board.labels} onClose={() => setSelected(null)} />}
    {course && <CourseDrawer course={course} milestones={board.milestones.filter((item) => item.projectId === course.projectId)} onClose={() => setSelected(null)} />}
  </div>;
}

/**
 * What batch approval would add, line by line, before it is approved: each draft with its date and how many criteria it carries, opened
 * in the drawer on click, and one approve / undo pair per line. The same drafts are dashed on the timeline below.
 */
function DraftReview({ drafts, labels, lineOrder, onOpen }: { drafts: BoardMilestone[]; labels: Record<string, string>; lineOrder: string[];
  onOpen: (id: string) => void }) {
  const [state, setState] = useState<Record<string, string>>({});
  const lines = [...new Set(drafts.map((item) => item.identityId))].sort((a, b) => lineOrder.indexOf(a) - lineOrder.indexOf(b));
  const decide = async (line: string, decision: "approved" | "archived") => {
    const ids = drafts.filter((item) => item.identityId === line).map((item) => item.id);
    setState((current) => ({ ...current, [line]: decision === "approved" ? "批准中…" : "撤销中…" }));
    const response = await fetch("/api/milestones/approve-batch", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, decision }) }).catch(() => undefined);
    const result = await response?.json().catch(() => null) as { skipped?: unknown[] } | null;
    if (!response?.ok || !result) { setState((current) => ({ ...current, [line]: "未完成，请刷新后重试" })); return; }
    if (result.skipped?.length) { setState((current) => ({ ...current, [line]: `${result.skipped!.length} 个已变化，请刷新` })); return; }
    location.reload();
  };
  return <section className="mt-drafts" aria-label="待审阅草稿">
    {lines.map((line) => {
      const own = drafts.filter((item) => item.identityId === line).sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));
      return <div key={line} className="mt-draft-line" data-line={line}>
        <header><b className="hl-line">{labels[line] ?? line}</b><span className="mono">+{own.length}</span>
          <span className="mt-draft-buttons">
            <button type="button" className="primary-button" disabled={Boolean(state[line])} onClick={() => void decide(line, "approved")}>批准 {own.length} 个</button>
            <button type="button" disabled={Boolean(state[line])} onClick={() => void decide(line, "archived")}>撤销</button>
          </span></header>
        <ul>{own.map((item) => <li key={item.id}><button type="button" onClick={() => onOpen(item.id)}>
          <span className="mono">{item.deadline ? md(item.deadline) : "未定"}</span><span>{item.title}</span>
          <small>{item.criteria.length} 项标准{item.ticks.length ? ` · ${item.ticks.length} 个刻度` : ""}</small></button></li>)}</ul>
        {state[line] && <p role="status">{state[line]}</p>}
      </div>;
    })}
  </section>;
}

/** The week in figures, from the ledger: ticks reached against planned, outputs reused by another line, and the nearest deadline. */
export function MilestoneStats({ board }: { board: MilestoneBoard }) {
  const { ticksDone, ticksPlanned, reuse, nearest } = board.stats;
  const share = ticksPlanned ? Math.min(1, ticksDone / ticksPlanned) : 0;
  return <section className="mt-stats" aria-label="本周进展">
    <div className="ui-stat"><b>{ticksDone}<small> / {ticksPlanned}</small></b><span>本周达成刻度</span>
      <span className="mt-stat-bar" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span></div>
    <div className="ui-stat"><b>{reuse}</b><span>本周跨主线复用</span></div>
    {nearest && <div className="ui-stat" data-line={nearest.line}><b className="hl-line">{nearest.days} 天</b><span>距 {nearest.title}</span></div>}
  </section>;
}

