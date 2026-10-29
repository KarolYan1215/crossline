"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Layers, Target } from "lucide-react";
import { MILESTONE_RISK_KIND_LABEL, RELATION_KIND_LABEL, riskLevelOf, type MilestoneRisk, type MilestoneRiskLevel } from "@crossline/core";
import { RiskGlyph } from "./risk-glyph";
import { ICON } from "../ui/icon-button";
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
import { MilestoneDrawer, CourseDrawer, PLAN_STATE_LABEL } from "./milestone-drawer";
import { useLocale, useT } from "../locale-context";
import type { Translate } from "../../lib/i18n";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/** A milestone's highest risk in words; the keys are Chinese and translated where shown. */
const RISK_NAME: Record<MilestoneRiskLevel, string> = { low: "低风险", medium: "中风险", high: "高风险" };
/** A tick's state as the strip tags it (keys, translated where shown). */
const TICK_TAG = { done: "已达成刻度", postponed: "已顺延刻度", planned: "计划中刻度" } as const;
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
export function MilestoneTimeline({ board }: { board: MilestoneBoard }) {
  const t = useT();
  const locale = useLocale();
  // ≥1360px the drawer stays beside the timeline, showing the current focus until a milestone is picked (2026-10-28 redesign).
  const docked = useWide("(min-width: 1360px)");
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
      .map((relation) => ({ id: relation.id, from: milestone.id, to: relation.otherId, pending: relation.pending, label: t(relation.kindLabel),
        ...(KIND_OF_LABEL.has(relation.kindLabel) ? { kind: KIND_OF_LABEL.get(relation.kindLabel)! } : {}), broken: Boolean(relation.broken) }))),
    lineOrder: board.lineOrder, today: board.today, width, locale
  });
  // The drafts waiting, as one banner above the timeline (dashed, like a draft): how many on each line, their risks, and the approvals.
  const draftTally = riskTally(drafts);
  const banner = <>
    {drafts.length > 0 && <section className="ms-drafts" aria-label={t("里程碑草稿")}>
      <Layers {...ICON} />
      <b>{t("{{count}} 份里程碑草稿待批准", { count: drafts.length })}</b>
      <span className="ms-drafts-lines">{board.lineOrder.filter((line) => drafts.some((item) => item.identityId === line))
        .map((line) => `${board.labels[line] ?? line} ${drafts.filter((item) => item.identityId === line).length}`).join(" · ")}</span>
      <span className="ms-drafts-risk">{(["high", "medium", "low"] as const).filter((level) => draftTally.levels[level]).map((level) =>
        <span key={level} className="ba-lines-risk"><RiskGlyph level={level} /><span className="mono">{draftTally.levels[level]}</span></span>)}</span>
      <span className="ms-drafts-actions">
        <button type="button" className="secondary-button ba-toggle" aria-expanded={byLine} aria-controls="ba-by-line"
          onClick={() => setByLine(!byLine)}>{t("按主线")}<span aria-hidden="true">{byLine ? " ▴" : " ▾"}</span></button>
        <BatchApprove drafts={drafts} labels={board.labels} lineOrder={board.lineOrder} />
      </span>
      {byLine && <LineApprovals id="ba-by-line" drafts={drafts} labels={board.labels} lineOrder={board.lineOrder} />}
    </section>}
    <DraftingNotes board={board} />
  </>;
  if (!layout.nodes.length) return <div className="mt">{banner}<section className="ms-card"><p className="flow-empty">{board.drafting?.pending.length ? t("里程碑草稿一条线一条线出来，好了会出现在这里等待批准。") : board.firstDrafts === "running"
    ? t("系统正在按访谈为每条主线设计里程碑草稿（每条主线几分钟），好了会出现在这里等待批准。")
    : board.firstDrafts === "stalled" ? t("里程碑草稿没有生成，点上方「让 AI 重新提议草稿」再试一次。") : t("尚无里程碑。访谈结束（或达到开始标准后停下 20 分钟）时系统自动设计草稿；也可以点上方「让 AI 重新提议草稿」。")}</p></section></div>;
  const milestone = selected?.kind === "milestone" ? board.milestones.find((item) => item.id === selected.id) : undefined;
  const course = selected?.kind === "course" ? board.courses.find((item) => `course:${item.projectId}` === selected.id) : undefined;
  const byId = new Map(board.milestones.map((item) => [item.id, item]));
  const current = currentFocus(board);
  const docMilestone = milestone ?? (!course && current ? byId.get(current) : undefined);
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
    return [t("{{kind}}：{{from}} → {{to}}", { kind: edge.label ?? t("飞轮关系"), from: titleOf.get(edge.from) ?? edge.from, to: titleOf.get(edge.to) ?? edge.to }),
      relation ? flowSummary(relation, t) : "", edge.pending ? t("随下游里程碑一起批准") : ""].filter(Boolean).join(t("，"));
  };
  const kinds = Object.keys(RELATION_KIND_LABEL).filter((kind) => layout.edges.some((edge) => edge.relationKind === kind));
  const open = (id: string, kind: "milestone" | "course") => setSelected(kind === "course" ? { kind: "course", id } : { kind: "milestone", id });
  const nameOf = (id: string, kind: "milestone" | "course", title: string) => {
    const data = kind === "milestone" ? byId.get(id) : undefined;
    const level = data ? riskLevelOf(data.risks) : null;
    return [title, data?.deadline ? t("截止 {{day}}", { day: md(data.deadline) }) : kind === "course" ? t("课程分数线") : t("未定日期"), data?.status === "draft" ? t("待批准") : "",
      data?.retrospective ? t("已达成") : "", level ? t(RISK_NAME[level]) : "", ...(data?.planStates ?? []).map((state) => t(PLAN_STATE_LABEL[state]))].filter(Boolean).join(" · ");
  };
  const todayLabelX = layout.years.some((year) => Math.abs(year.x - layout.todayX) < 40) ? layout.todayX + 40 : layout.todayX + 3;

  const undatedHeading = layout.datedEnd < layout.width - 30 && layout.nodes.some((node) => node.undated);
  return <div className="mt" role="group" aria-label={t("里程碑时间轴")} data-hover={hot ? "" : undefined}
    onKeyDown={(event) => { if (event.key === "Escape" && picked) setPicked(null); }}>
    {banner}
    <div className="ms-main" data-docked={docked || undefined}>
    <section className="ms-card ms-timeline-card" aria-labelledby="ms-timeline-title">
    <header className="ms-card-head"><h2 id="ms-timeline-title" className="ds-serif">{t("时间轴")}</h2>
      <small>{t("实心为已批准 · 虚线为草稿 · 圆点为刻度 · 外圈为排程状态")}</small></header>
    <FocusStrip ref={strip} layout={layout} board={board} milestoneId={hover} ticks={tickSubject} pinned={Boolean(picked) && !hover && (!tickHover || tickHover.join() === picked!.join())}
      current={current} onClose={() => setPicked(null)} onOpen={open} />
    <div className="mt-scroll" ref={frame}>
      <div className="mt-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg width={layout.width} height={layout.height} aria-hidden="true" className="mt-svg">
          {layout.axis.map((mark) => <g key={`${mark.kind}${mark.x}`}><line x1={mark.x} x2={mark.x} y1={TL.headH - 4} y2={layout.height} className={mark.kind === "month" ? "mt-grid-month" : "mt-grid"} />
            {/* A date mark too close to the 「未定日期」 zone's heading would run into it; the grid line stays. */}
            {!(undatedHeading && mark.x + 40 > layout.datedEnd + 14) && <text x={mark.x + 3} y={28} className={mark.kind === "month" ? "mt-axis-month" : "mt-axis"}>{mark.label}</text>}</g>)}
          {layout.years.map((year) => <g key={year.label}>
            {year.boundary && <line x1={year.x} x2={year.x} y1={2} y2={layout.height} className="mt-year-line" />}
            <text x={year.x + (year.boundary ? 4 : 0)} y={12} className="mt-year">{year.label}</text></g>)}
          {undatedHeading && <text x={layout.datedEnd + 14} y={28} className="mt-axis">{t("未定日期")}</text>}
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
          <text x={todayLabelX} y={12} className="mt-today-label">{t("今天")}</text>
          {layout.ticks.map((item) => <g key={item.id} data-line={item.line}>
            {item.plannedX !== null && <circle cx={item.plannedX} cy={item.axisY} r={3} className="mt-tick-ghost" data-hot={hotTick(item.id) || undefined} />}
          </g>)}
        </svg>
        {asked.filter((edge) => placed.get(edge.id) && outgoing.get(edge.id)?.relation.artifact).map((edge) => {
          const { relation, from } = outgoing.get(edge.id)!;
          const box = placed.get(edge.id)!;
          return <div key={edge.id} className="mt-flow" style={{ left: box.x, top: box.y }} data-line={edge.line} data-hot={hot?.has(edge.id) || undefined}>
            <button type="button" className="mt-flow-chip" data-pending={edge.pending || undefined} data-broken={edge.broken || undefined}
              aria-label={t("{{kind}}：{{summary}}", { kind: edge.label ?? t("飞轮关系"), summary: flowSummary(relation, t) })} aria-expanded={flow === edge.id}
              onMouseEnter={() => { holdLabels(); setFlow(edge.id); }} onMouseLeave={() => { setFlow(null); hideLabels(); }}
              onFocus={() => { holdLabels(); setFlow(edge.id); }} onBlur={() => { setFlow(null); hideLabels(); }}
              onClick={() => setFlow(flow === edge.id ? null : edge.id)}>{edge.label}</button>
            {flow === edge.id && <FlowCard relation={relation} from={from} labels={board.labels} />}
          </div>;
        })}
        {layout.rows.map((row) => {
          const waiting = drafts.filter((item) => item.identityId === row.line).length;
          return <div key={row.line} className="mt-line" data-line={row.line} style={{ top: row.y, height: row.height, width: TL.labelW - 6 }}>
            <b>{board.labels[row.line] ?? row.line}</b>{waiting > 0 && <small className="mt-line-waiting">{t("{{n}} 待批准", { n: waiting })}</small>}</div>;
        })}
        {/* Each dot and each dashed ghost is a target as wide as its neighbours allow; the dots are drawn inside it. */}
        {targets.map((target) => {
          const name = target.ticks.map((id) => {
            const data = ticksById.get(id);
            return data ? `${data.outcome} · ${tickStory(data, locale).status}${target.points.some((point) => point.id === id && point.ghost) ? ` · ${t("原定日")}` : ""}` : "";
          }).filter(Boolean).join(t("；"));
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
              data-reached={data?.retrospective ? "" : undefined} data-plan={data?.planStates?.[0]} data-current={item.id === current || undefined}
              data-hot={hot?.has(item.id) || undefined} {...focus(item.id)}
              style={{ left: item.x - 11, top: item.axisY - 11 }} aria-label={name} title={name} onClick={() => open(item.id, item.kind)}><i /></button>
            {level && risky.has(item.id) && <span className="mt-risk" style={{ left: riskBox(item).x, top: riskBox(item).y }} title={data!.risks.map((risk) => t(MILESTONE_RISK_KIND_LABEL[risk.kind])).join(t("、"))}>
              <RiskGlyph level={level} /></span>}
            {(fullNames.has(item.id) || item.labelW > 0) && <button type="button" className="mt-node" data-line={item.line} data-kind={item.kind} data-status={item.status}
              data-hot={hot?.has(item.id) || undefined} data-full={fullNames.has(item.id) || undefined} {...focus(item.id)} tabIndex={-1} title={name}
              style={fullNames.has(item.id) ? { left: fullNames.get(item.id)!.x, top: fullNames.get(item.id)!.y, width: fullNames.get(item.id)!.w }
                : { left: item.labelX, top: item.labelY, width: item.labelW }} onClick={() => open(item.id, item.kind)}>{item.title}</button>}
          </div>;
        })}
      </div>
    </div>
    <p className="mt-legend"><span><span className="mt-key" data-k="milestone" />{t("已批准")}</span>
      {drafts.length > 0 && <span><span className="mt-key" data-k="draft" />{t("待批准")}</span>}
      {board.milestones.some((item) => item.retrospective) && <span><span className="mt-key" data-k="reached" />{t("已达成")}</span>}
      {board.milestones.some((item) => item.risks.length) && <span><RiskGlyph level="medium" />{t("风险等级")}</span>}
      {board.courses.length > 0 && <span><span className="mt-key" data-k="course" />{t("课程分数线")}</span>}
      {layout.ticks.length > 0 && <span><span className="mt-key" data-k="done" />{t("已达成刻度")}</span>}
      {layout.ticks.length > 0 && <span><span className="mt-key" data-k="planned" />{t("计划刻度")}</span>}
      {layout.ticks.some((item) => item.state === "postponed") && <span><span className="mt-key" data-k="postponed" />{t("已顺延")}</span>}
      {layout.ticks.some((item) => item.plannedX !== null) && <span><span className="mt-key" data-k="ghost" />{t("顺延前的原定日")}</span>}
      {layout.edges.some((edge) => edge.kind === "chain") && <span><span className="mt-key" data-k="chain" />{t("前后依赖")}</span>}
      {/* A relation's kind is its line style; its name shows when the curve or one of its milestones is hovered. */}
      {kinds.map((kind) => <span key={kind}><svg className="mt-kind-svg" width={26} height={6} aria-hidden="true">
        <line x1={1} x2={25} y1={3} y2={3} className="mt-kind-key" data-kind={kind} /></svg>{t(RELATION_KIND_LABEL[kind]!)}</span>)}
      {layout.edges.some((edge) => edge.kind === "relation" && !edge.relationKind) && <span><span className="mt-key" data-k="relation" />{t("飞轮关系")}</span>}
      {layout.edges.some((edge) => edge.kind === "relation" && edge.pending) && <span><svg className="mt-kind-svg" width={26} height={6} aria-hidden="true">
        <line x1={1} x2={25} y1={3} y2={3} className="mt-kind-key" data-pending="" /></svg>{t("候选关系")}</span>}
      {layout.edges.some((edge) => edge.broken) && <span><span className="mt-key" data-k="broken" />{t("时间顺序不成立")}</span>}
      {/* The schedule's word on approved milestones, as the marker's outer ring (moved here from the plan page, 2026-10-28). */}
      {(["risk", "unprepared", "library"] as const).filter((state) => board.milestones.some((item) => item.planStates?.includes(state))).map((state) =>
        <span key={state}><span className="mt-key" data-k={`plan-${state}`} />{t(PLAN_STATE_LABEL[state])}</span>)}</p>
    </section>
    {docked && (course ? <CourseDrawer key={course.projectId} docked course={course} milestones={board.milestones.filter((item) => item.projectId === course.projectId)}
        onClose={() => setSelected(null)} />
      : docMilestone ? <MilestoneDrawer key={`${docMilestone.id}:${docMilestone.version}`} docked milestone={docMilestone} labels={board.labels}
        onClose={milestone && milestone.id !== current ? closeDrawer : undefined} /> : null)}
    </div>
    {!docked && milestone && <MilestoneDrawer milestone={milestone} labels={board.labels} onClose={closeDrawer} />}
    {!docked && course && <CourseDrawer course={course} milestones={board.milestones.filter((item) => item.projectId === course.projectId)} onClose={() => setSelected(null)} />}
  </div>;
}

/** Whether the window is at least as wide as `query` says; false until mounted, so the server and the first paint agree. */
function useWide(query: string): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const follow = () => setWide(media.matches);
    follow();
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [query]);
  return wide;
}

/**
 * 「当前焦点」 (Linear's next unfinished milestone as the focus): the nearest approved milestone not yet past and not reached, else the
 * nearest draft, else any open milestone without a date (approved first). What the strip names and the dock shows while nothing else is
 * pointed at or picked, so neither is ever an empty box while there is a milestone at all.
 */
export function currentFocus(board: Pick<MilestoneBoard, "milestones">): string | null {
  const open = board.milestones.filter((item) => !item.retrospective);
  const ahead = (status: "approved" | "draft") => open.filter((item) => item.status === status && item.daysLeft !== undefined && item.daysLeft >= 0)
    .sort((a, b) => a.daysLeft! - b.daysLeft! || a.title.localeCompare(b.title))[0];
  const undated = (status: "approved" | "draft") => open.find((item) => item.status === status && item.daysLeft === undefined);
  return (ahead("approved") ?? ahead("draft") ?? undated("approved") ?? undated("draft"))?.id ?? null;
}

/** At most this many ticks are explained at once in the strip; the rest are counted. */
const STRIP_TICKS = 4;

/**
 * The strip above the timeline, of fixed height so the canvas never moves under the pointer: the milestone in focus in full (title, line,
 * deadline and days left, state, risk with its kinds, and the milestones it is joined to), or the ticks under the pointer or picked (what
 * the tick is, its state and day, for a postponed one the day it was due and why it moved, its step, task and milestone, and a link to the
 * task). A picked tick stays until closed.
 */
export function FocusStrip({ ref, layout, board, milestoneId: pointed, ticks, pinned, current = null, onClose, onOpen }: { ref?: Ref<HTMLDivElement>; layout: TimelineLayout; board: MilestoneBoard;
  milestoneId: string | null; ticks: string[] | null; pinned: boolean;
  /** 「当前焦点」 (`currentFocus`): named while nothing is pointed at or picked, so the strip is never an empty instruction box. */
  current?: string | null;
  onClose: () => void; onOpen: (id: string, kind: "milestone" | "course") => void }) {
  const t = useT();
  const locale = useLocale();
  // 「」 in Chinese; English quotes, set off by a space, in English.
  const quote = (node: ReactNode) => locale === "en" ? <> “{node}”</> : <>「{node}」</>;
  const byId = new Map(board.milestones.map((item) => [item.id, item]));
  const titleOf = (id: string) => byId.get(id)?.title ?? layout.nodes.find((node) => node.id === id)?.title ?? id;
  const lineName = (line: string) => board.labels[line] ?? line;
  const resting = !pointed && !ticks?.length && Boolean(current && byId.has(current));
  const milestoneId = resting ? current : pointed;
  let body: ReactNode = <p className="mt-focus-hint">{t("指向或点选里程碑、刻度，这里显示全名、日期、状态与关联；点刻度后说明会保留到关闭。")}</p>;
  let line: string | undefined;
  if (milestoneId?.startsWith("course:")) {
    const course = board.courses.find((item) => `course:${item.projectId}` === milestoneId);
    if (course) {
      line = course.identityId;
      body = <>
        <p className="mt-focus-title"><b>{course.name} · {course.value}</b> <Tag>{t("课程分数线")}</Tag>{course.proposed && <Tag tone="warn">{t("待批准")}</Tag>}</p>
        <p className="mt-focus-meta">{lineName(course.identityId)}{course.endDay ? <> · <span className="mono">{t("课程结束 {{day}}", { day: md(course.endDay) })}</span></> : null}</p>
        {course.why && <p className="mt-focus-meta gen">{course.why}</p>}
      </>;
    }
  } else if (milestoneId) {
    const milestone = byId.get(milestoneId);
    if (milestone) {
      line = milestone.identityId;
      const level = riskLevelOf(milestone.risks);
      const joined = connectionsOf(layout, milestone.id);
      const names = (ids: string[]) => ids.map((id) => t("「{{title}}」", { title: titleOf(id) })).join(t("、"));
      body = <>
        <p className="mt-focus-title">{resting && <span className="mt-focus-current"><Target {...ICON} />{t("当前焦点")}</span>}
          {resting ? <button type="button" className="text-button mt-focus-open" onClick={() => onOpen(milestone.id, "milestone")}><b>{milestone.title}</b></button>
            : <b>{milestone.title}</b>}{" "}
          {milestone.status === "draft" ? <Tag tone="warn">{t("待批准")}</Tag> : <Tag>{t("已批准")}</Tag>}
          {milestone.retrospective && <Tag tone="ok">{t("已达成")}</Tag>}
          {milestone.planStates?.map((state) => <Tag key={state} tone={state === "risk" ? "risk" : "neutral"}>{t(PLAN_STATE_LABEL[state])}</Tag>)}
          {level && <Tag tone={level === "high" ? "risk" : "warn"} title={milestone.risks.map((risk) => risk.note).join(t("；"))}>
            {t(RISK_NAME[level])} · {[...new Set(milestone.risks.map((risk) => t(MILESTONE_RISK_KIND_LABEL[risk.kind])))].join(t("、"))}</Tag>}</p>
        <p className="mt-focus-meta">{lineName(milestone.identityId)}{milestone.projectName ? ` · ${milestone.projectName}` : ""} · {milestone.deadline
          ? <span className="mono">{milestone.daysLeft === undefined ? t("截止 {{day}}", { day: md(milestone.deadline) })
            : milestone.daysLeft >= 0 ? t("截止 {{day}}，还有 {{count}} 天", { day: md(milestone.deadline), count: milestone.daysLeft })
            : t("截止 {{day}}，已过 {{count}} 天", { day: md(milestone.deadline), count: -milestone.daysLeft })}</span>
          : t("未定日期")}{milestone.ticks.length > 0 ? <> · <span className="mono">{t("刻度 {{done}}/{{total}}", { done: milestone.ticks.filter((item) => item.state === "done").length, total: milestone.ticks.length })}</span></> : null}</p>
        {(joined.before.length > 0 || joined.after.length > 0 || joined.relations.length > 0) && <p className="mt-focus-meta">
          {[joined.before.length ? t("前置 {{names}}", { names: names(joined.before) }) : "", joined.after.length ? t("后续 {{names}}", { names: names(joined.after) }) : "",
            ...joined.relations.map((relation) => `${relation.label ?? t("飞轮关系")}${relation.pending ? ` · ${t("候选")}` : ""} ${relation.direction === "out" ? "→" : "←"} ${t("「{{title}}」", { title: titleOf(relation.other) })}`)]
            .filter(Boolean).join(t("；"))}</p>}
      </>;
    }
  } else if (ticks?.length) {
    const all = board.milestones.flatMap((milestone) => milestone.ticks.map((item) => ({ item, milestone })));
    const shown = ticks.flatMap((id) => all.find((entry) => entry.item.id === id) ?? []);
    line = shown[0]?.milestone.identityId;
    body = <>
      {pinned && <button type="button" className="ui-icon-button mt-focus-close" aria-label={t("关闭刻度说明")} onClick={onClose}>×</button>}
      {shown.slice(0, STRIP_TICKS).map(({ item, milestone }) => {
        const story = tickStory(item, locale);
        return <article key={item.id} className="mt-focus-tick">
          <p className="mt-focus-title"><Tag tone={item.state === "done" ? "ok" : item.state === "postponed" ? "warn" : "neutral"}>{t(TICK_TAG[item.state])}</Tag>{" "}
            <b className="gen">{item.outcome}</b> <span className="mono">{story.when}</span></p>
          {story.why && <p className="mt-focus-meta">{story.why}</p>}
          <p className="mt-focus-meta">{t("步骤")}{quote(<span className="gen">{item.stepTitle}</span>)} · {t("任务")}{quote(<span className="gen">{item.taskTitle}</span>)} · {t("里程碑")}{" "}
            <button type="button" className="text-button" onClick={() => onOpen(milestone.id, "milestone")}>{milestone.title}</button>{" "}
            · <a href={`/workbench/${encodeURIComponent(item.workOrderId)}`}>{t("打开任务")}</a></p>
        </article>;
      })}
      {shown.length > STRIP_TICKS && <p className="mt-focus-meta">{t("同一处另有 {{count}} 个刻度，放大窗口或在里程碑详情里查看。", { count: shown.length - STRIP_TICKS })}</p>}
    </>;
  }
  return <div ref={ref} className="mt-focus" data-line={line} data-pinned={pinned || undefined} data-resting={resting || undefined} aria-live="polite">{body}</div>;
}

const mdOf = (day?: string) => day ? md(day) : "—";
const amountOf = (relation: BoardRelation) => relation.transfer ? `${relation.transfer.expected} ${relation.transfer.unit}${relation.transfer.metric}` : "";
const flowSummary = (relation: BoardRelation, t: Translate) => [relation.artifact ? t("产物「{{title}}」", { title: relation.artifact.title }) : "",
  amountOf(relation) ? t("预期 {{amount}}", { amount: amountOf(relation) }) : "", relation.checkOn ? t("核对日 {{day}}", { day: md(relation.checkOn) }) : "",
  relation.broken ? t("时间顺序不成立") : ""].filter(Boolean).join(t("，"));

/** What a cross-line edge carries, on hover or focus: the artifact, the transfer expected and measured, the check day and the counterfactual. */
function FlowCard({ relation, from, labels }: { relation: BoardRelation; from: BoardMilestone; labels: Record<string, string> }) {
  const t = useT();
  return <div className="mt-flow-card" role="tooltip">
    <b>{labels[from.identityId] ?? from.identityId} → {labels[relation.otherLine] ?? relation.otherLine}</b>
    <dl>
      <dt>{t("产物")}</dt><dd className="gen">{relation.artifact?.title}{relation.artifact?.kind ? ` · ${relation.artifact.kind}` : ""}</dd>
      <dt>{t("传递量")}</dt><dd><span className="mono">{t("预期 {{amount}}", { amount: amountOf(relation) })}</span>{" / "}<span className="mono">{t("实测 {{amount}}", { amount: relation.transfer?.measured === null || relation.transfer?.measured === undefined ? "—" : `${relation.transfer.measured} ${relation.transfer.unit}` })}</span></dd>
      <dt>{t("核对日")}</dt><dd className="mono">{mdOf(relation.checkOn)}{relation.transfer?.lagDays ? ` · ${t("传递 {{count}} 天", { count: relation.transfer.lagDays })}` : ""}</dd>
      <dt>{t("反事实")}</dt><dd className="gen">{relation.counterfactual}{relation.transfer?.hoursSaved ? t("（约 {{n}} 小时）", { n: relation.transfer.hoursSaved }) : ""}</dd>
    </dl>
    {relation.broken && <p className="mt-flow-broken">{t("时间顺序不成立：")}{relation.broken}</p>}
    {relation.pending && <small>{t("随下游里程碑「{{title}}」一起批准", { title: relation.otherTitle })}</small>}
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState("");
  const tally = riskTally(drafts);
  const lines = [...new Set(drafts.map((item) => item.identityId))].sort((a, b) => lineOrder.indexOf(a) - lineOrder.indexOf(b));
  const approve = async () => {
    setState(t("批准中…"));
    const response = await fetch("/api/milestones/approve-batch", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: drafts.map((item) => item.id), decision: "approved" }) }).catch(() => undefined);
    const result = await response?.json().catch(() => null) as { skipped?: unknown[] } | null;
    if (!response?.ok || !result) { setState(t("未完成，请刷新后重试")); return; }
    if (result.skipped?.length) { setState(t("{{n}} 个已变化，其余已批准；刷新后查看", { n: result.skipped.length })); return; }
    location.reload();
  };
  /** Level names are keys, translated where shown. */
  const rows: Array<[MilestoneRiskLevel | "none", string]> = [["high", "高"], ["medium", "中"], ["low", "低"], ["none", "无"]];
  return <Sheet title={title ?? t("批准 {{count}} 个里程碑草稿", { count: drafts.length })} open={open} onOpenChange={(value) => { setOpen(value); if (!value) setState(""); }}
    trigger={<button type="button" className="primary-button">{label ?? t("一键批准 {{n}} 个", { n: drafts.length })}</button>}
    footer={<div className="md-actions">
      <button type="button" className="primary-button" disabled={Boolean(state)} onClick={() => void approve()}>{t("批准全部 {{n}} 个", { n: drafts.length })}</button>
      <button type="button" disabled={state === t("批准中…")} onClick={() => setOpen(false)}>{t("取消")}</button>
      {state && <span role="status">{state}</span>}
    </div>}>
    <div className="ba">
      <section className="ba-levels" aria-label={t("风险等级分布")}>
        {rows.map(([level, label]) => <div key={level} className="ba-level">
          <RiskGlyph level={level === "none" ? null : level} /><span>{t(label)}</span>
          <span className="ba-bar" aria-hidden="true"><i data-level={level} style={{ width: `${(tally.levels[level] / drafts.length) * 100}%` }} /></span>
          <b className="mono">{tally.levels[level]}</b></div>)}
      </section>
      {tally.kinds.length > 0 && <p className="ba-kinds">{tally.kinds.map(([kind, count]) => <span key={kind} className="risk-kind">{t(MILESTONE_RISK_KIND_LABEL[kind])} × {count}</span>)}</p>}
      <p className="muted ba-note">{t("批准后，审查出的中、高风险会在今日页单独询问：接受才让它们的任务提前 1–2 天排完。")}</p>
      {lines.map((line) => <section key={line} className="ba-line" data-line={line} aria-label={labels[line] ?? line}>
        <h3>{labels[line] ?? line}</h3>
        <ul>{drafts.filter((item) => item.identityId === line).sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9")).map((item) =>
          <li key={item.id}><RiskGlyph level={riskLevelOf(item.risks)} /><span className="mono">{item.deadline ? md(item.deadline) : t("未定")}</span>
            <span className="ba-title">{item.title}</span>
            <span className="ba-tags">{item.risks.map((risk) => <span key={risk.kind} className="risk-kind" data-level={risk.level} title={risk.note}>{t(MILESTONE_RISK_KIND_LABEL[risk.kind])}</span>)}</span>
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
  const t = useT();
  const lines = [...new Set(drafts.map((item) => item.identityId))].sort((a, b) => lineOrder.indexOf(a) - lineOrder.indexOf(b));
  return <ul id={id} className="ba-lines" aria-label={t("按主线批准")}>
    {lines.map((line) => {
      const own = drafts.filter((item) => item.identityId === line);
      const { levels } = riskTally(own);
      const name = labels[line] ?? line;
      return <li key={line} data-line={line}>
        <b className="ba-lines-name">{name}</b>
        <span className="mono">{t("{{n}} 个", { n: own.length })}</span>
        <span className="ba-lines-risks" aria-label={t("高风险 {{high}}、中风险 {{medium}}、低风险 {{low}}", { high: levels.high, medium: levels.medium, low: levels.low })}>
          {(["high", "medium", "low"] as const).filter((level) => levels[level]).map((level) =>
            <span key={level} className="ba-lines-risk"><RiskGlyph level={level} /><span className="mono">{levels[level]}</span></span>)}
          {!levels.high && !levels.medium && !levels.low && <span className="muted">{t("无风险")}</span>}
        </span>
        <BatchApprove drafts={own} labels={labels} lineOrder={lineOrder} label={t("批准这条主线")} title={t("批准「{{name}}」的 {{count}} 个里程碑草稿", { name, count: own.length })} />
      </li>;
    })}
  </ul>;
}

/** The week in figures, from the ledger: ticks reached against planned, outputs reused by another line, and the nearest deadline. */
export function MilestoneStats({ board }: { board: MilestoneBoard }) {
  const { ticksDone, ticksPlanned, reuse, nearest } = board.stats;
  const t = useT();
  const share = ticksPlanned ? Math.min(1, ticksDone / ticksPlanned) : 0;
  return <section className="mt-stats" aria-label={t("本周进展")}>
    <span className="mt-stat"><b className="ds-serif">{ticksDone}<small> / {ticksPlanned}</small></b><span>{t("本周刻度")}</span>
      <span className="mt-stat-bar" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span></span>
    <span className="mt-stat"><b className="ds-serif">{reuse}</b><span>{t("跨主线复用")}</span></span>
    {nearest && <span className="mt-stat" data-line={nearest.line}><b className="ds-serif">{t("{{count}} 天", { count: nearest.days })}</b><span className="mt-stat-title" title={nearest.title}>{t("距 {{title}}", { title: nearest.title })}</span></span>}
  </section>;
}

/**
 * What the last design run says beyond the drafts (W-26/W-27): lines it has not reached yet — drafts arrive one line at a time, and a
 * page that stopped saying 「还在设计」 after the first line looked finished — and lines it left without drafts, with why and what to do.
 */
export function DraftingNotes({ board }: { board: Pick<MilestoneBoard, "drafting" | "labels"> }) {
  const pending = board.drafting?.pending ?? [];
  const missing = Object.entries(board.drafting?.missing ?? {});
  const t = useT();
  if (!pending.length && !missing.length) return null;
  const name = (line: string) => board.labels[line] ?? line;
  return <div className="mt-drafting" role="status">
    {pending.length > 0 && <p>{t("还在设计其余 {{count}} 条线的草稿：{{lines}}（每条几分钟），全部出来后再一起批准。", { count: pending.length, lines: pending.map(name).join(t("、")) })}</p>}
    {missing.map(([line, why]) => <p key={line} data-line={line}>
      <b className="hl-line">{name(line)}</b> {t("没有草稿：")}{why} {t("可以在这条线卡片的「访谈」里补几句，再点「让 AI 重新提议草稿」。")}</p>)}
  </div>;
}
