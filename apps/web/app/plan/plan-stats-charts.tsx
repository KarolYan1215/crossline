"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { MILESTONE_STATE_ORDER, milestoneMarks, timelineMarks, timelineSpan, type CapacityWeek, type EstimatePoint, type GoalRow, type Investment, type MilestoneMark, type MilestoneState } from "../../lib/plan-stats";
import { Ring } from "../ui/charts";
import { LineTag, Tag } from "../ui/tag";
import { bands, dayAt, heatLevel, hours, labelEvery, linear, linearTicks, logDomain, logScale, md, minuteLabel, monthTicks, packLabels, scatterMargins, textWidth } from "./chart-geometry";
import { usePlanPreview } from "./preview-context";

/**
 * The plan page's charts (decided 2026-10-10, redrawn 2026-10-15): one milestone timeline per line, capacity against demand, planned
 * against timed hours per line as a histogram, estimate accuracy, and the timed rhythm under an energy pattern. Hand-drawn SVG like `app/ui/charts.tsx`; every mark has its exact value
 * on hover. While a change is previewed below, the charts it moves draw the after-state with the current values as dashed ghosts.
 */

/**
 * The width a chart has, measured from the element the returned ref lands on. A callback ref, not an effect on mount: a chart that
 * first renders its empty state attaches the box later, and the mount-time effect never saw it — the width stayed at `initial` (640)
 * and a phone drew the wide layout 510px across a 375px screen.
 */
function useWidth(initial: number): [(node: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(initial);
  const observer = useRef<ResizeObserver | null>(null);
  const box = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => { const next = Math.round(entry?.contentRect.width ?? 0); if (next > 0) setWidth(next); });
    observer.current.observe(node);
  }, []);
  return [box, width];
}

const h1 = (minutes: number) => `${hours(minutes)} h`;
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function Card({ title, note, label, tags, children, data }: { title: string; note?: ReactNode; label: string; tags?: ReactNode; children: ReactNode;
  data?: Record<string, string | number> }) {
  return <section className="pl-card pl-stat" aria-label={label} {...Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value]))}>
    <header><h2>{title}</h2>{tags}{note && <small>{note}</small>}</header>
    {children}
  </section>;
}

function PreviewNote() {
  return <p className="pl-preview-note" role="status"><span className="pl-key" data-k="ghost" />虚线为改动前，实线为预览中的改动后</p>;
}

/* ── 1. capacity and demand ── */

const TIP_WIDTH = 220;
/** Beside the hovered bar, never over it: to its right when there is room, else to its left, else against the edge. */
function tipLeft(centre: number, band: number, width: number): number {
  const right = centre + band / 2 + 6, leftSide = centre - band / 2 - 6 - TIP_WIDTH;
  if (right + TIP_WIDTH <= width) return right;
  if (leftSide >= 0) return leftSide;
  return Math.max(0, width - TIP_WIDTH);
}

export function CapacityChart({ weeks, labels, statedWeekly, configuredWeekly, usingDefault, source = "saved" }: { weeks: CapacityWeek[]; labels: Record<string, string>;
  statedWeekly: number | null; configuredWeekly: number; usingDefault: boolean;
  /** Where the hours came from (`resolveAvailability`); anything but `saved` is said on the chart until the person paints their week. */
  source?: "saved" | "interview" | "stated_hours" | "default" }) {
  const preview = usePlanPreview();
  const shown = preview?.after.capacity ?? weeks;
  const ghost = preview?.before.capacity ?? null;
  const [box, width] = useWidth(640);
  const [active, setActive] = useState<number | null>(null);
  const H = 200, top = 22, bottom = 24, left = 34, right = 6;
  const plotW = Math.max(120, width - left - right), plotH = H - top - bottom;
  const peak = Math.max(1, ...shown.map((week) => Math.max(week.totalP85, week.usableMinutes)), ...(ghost ?? []).map((week) => Math.max(week.totalP50, week.usableMinutes))) / 60;
  const ticks = linearTicks(peak);
  const y = linear(ticks.at(-1)!, top + plotH, top);
  const layout = bands(shown.length, plotW);
  const every = labelEvery(layout.band, 38);
  const short = statedWeekly !== null && configuredWeekly < statedWeekly * 0.8;
  const overloaded = shown.filter((week) => week.overloadMinutes > 0);
  const scheduledFirst = shown[0]?.lines.reduce((sum, line) => sum + line.scheduled, 0) ?? 0;
  const point = (week: CapacityWeek, index: number) => `${left + layout.centre(index)},${y(week.usableMinutes / 60)}`;
  const tip = active !== null ? shown[active] : undefined;
  return <Card title="容量与需求" label="容量与需求" data={{ "scheduled-minutes": scheduledFirst }}
    note={<>{statedWeekly !== null && <span title={`画像所述每周投入 ${statedWeekly} 小时`}>所述每周 {statedWeekly} h · </span>}
      <span title={`可用时段每周 ${configuredWeekly} 小时（未扣除日历）`}>可用时段每周 {configuredWeekly} h</span></>}
    tags={<>{source === "interview" ? <Tag tone="warn" title="可用时段来自访谈中所述的作息，尚未确认；在下方「可用时段」中刷涂实际作息">推断时段（访谈）</Tag>
      : source === "stated_hours" ? <Tag tone="warn" title={`可用时段按所述每周 ${statedWeekly ?? ""} 小时平均分到每天，尚未确认；在下方「可用时段」中刷涂实际作息`}>推断时段（每周小时）</Tag>
      : (usingDefault || source === "default") && <Tag tone="warn" title="可用时段仍为默认值，在下方「可用时段」中刷涂实际作息">默认时段</Tag>}
      {short && <Tag tone="warn" title="可用时段少于画像所述的每周投入，排程只能使用可用时段">可用时段不足</Tag>}</>}>
    {preview && <PreviewNote />}
    <div ref={box} className="pl-chart-box">
      <svg className="pl-svg" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img"
        aria-label={`每周需求与可用小时：${shown.map((week) => `${md(week.start)} 起需求 ${hours(week.totalP50)} 小时，可用 ${hours(week.usableMinutes)} 小时`).join("；")}`}>
        <defs>
          <pattern id="pl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" className="pl-hatch-bg" /><line x1="0" y1="0" x2="0" y2="6" className="pl-hatch-line" />
          </pattern>
        </defs>
        {ticks.map((tick) => <g key={tick}>
          <line x1={left} x2={left + plotW} y1={y(tick)} y2={y(tick)} className="pl-grid-line" />
          <text x={left - 4} y={y(tick)} dy="0.32em" textAnchor="end" className="pl-axis-text">{tick}</text>
        </g>)}
        <text x={2} y={11} className="pl-axis-text">小时</text>
        {shown.map((week, index) => {
          const x = left + layout.x(index);
          let base = 0;
          const marks: ReactNode[] = [];
          for (const line of week.lines) {
            const name = labels[line.line] ?? line.line;
            if (line.scheduled > 0) { const from = base; base += line.scheduled;
              marks.push(<rect key={`${line.line}-s`} x={x} width={layout.bar} y={y(base / 60)} height={y(from / 60) - y(base / 60)} data-line={line.line} className="pl-seg">
                <title>{`${name} · 已排 ${h1(line.scheduled)}`}</title></rect>); }
            if (line.pending > 0) { const from = base; base += line.pending;
              marks.push(<g key={`${line.line}-p`} data-line={line.line}>
                <rect x={x} width={layout.bar} y={y(base / 60)} height={y(from / 60) - y(base / 60)} className="pl-seg pl-seg-pending" />
                <rect x={x} width={layout.bar} y={y(base / 60)} height={y(from / 60) - y(base / 60)} fill="url(#pl-hatch)"><title>{`${name} · 待排 ${h1(line.pending)}`}</title></rect>
              </g>); }
          }
          for (const line of week.lines) if (line.extra > 0) { const from = base; base += line.extra;
            marks.push(<rect key={`${line.line}-x`} x={x} width={layout.bar} y={y(base / 60)} height={y(from / 60) - y(base / 60)} data-line={line.line} className="pl-seg pl-seg-extra">
              <title>{`${labels[line.line] ?? line.line} · 保守估时多出 ${h1(line.extra)}`}</title></rect>); }
          const before = ghost?.[index];
          return <g key={week.week} className="pl-cd-week" tabIndex={0} data-active={active === index || undefined}
            aria-label={`${md(week.start)}–${md(week.end)}：需求 ${hours(week.totalP50)} 小时，保守 ${hours(week.totalP85)} 小时，可用 ${hours(week.usableMinutes)} 小时${week.overloadMinutes ? `，超载 ${hours(week.overloadMinutes)} 小时` : ""}`}
            onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>
            <rect x={left + index * layout.band} width={layout.band} y={top} height={plotH} className="pl-hit" />
            {marks}
            {before && before.totalP50 !== week.totalP50 && <rect x={x - 1.5} width={layout.bar + 3} y={y(before.totalP50 / 60)} height={Math.max(0, y(0) - y(before.totalP50 / 60))} className="pl-ghost">
              <title>{`改动前需求 ${h1(before.totalP50)}`}</title></rect>}
            {week.overloadMinutes > 0 && layout.band >= 30 && <text x={left + layout.centre(index)} y={Math.max(12, y(week.totalP85 / 60) - 5)} textAnchor="middle" className="pl-over-text">
              {layout.band >= 76 ? `超载 ${hours(week.overloadMinutes)} 小时` : `+${hours(week.overloadMinutes)}`}</text>}
            {index % every === 0 && <text x={left + layout.centre(index)} y={H - 8} textAnchor="middle" className="pl-axis-text">{md(week.start)}</text>}
          </g>;
        })}
        {ghost && ghost.some((week, index) => week.usableMinutes !== shown[index]?.usableMinutes) &&
          <polyline points={ghost.map((week, index) => point(week, index)).join(" ")} className="pl-usable pl-usable-ghost" />}
        <polyline points={shown.map((week, index) => point(week, index)).join(" ")} className="pl-usable" />
        {shown.map((week, index) => <circle key={week.week} cx={left + layout.centre(index)} cy={y(week.usableMinutes / 60)} r={3} className="pl-usable-dot">
          <title>{`${md(week.start)} 起可用 ${h1(week.usableMinutes)}（净可用 ${h1(week.netMinutes)}，扣除预留）`}</title></circle>)}
      </svg>
      {tip && <div className="pl-tip" role="tooltip" style={{ left: tipLeft(left + layout.centre(active!), layout.band, width) }}>
        <b>{md(tip.start)}–{md(tip.end)}</b>
        <span className="mono">需求 {h1(tip.totalP50)}（保守 {h1(tip.totalP85)}）· 可用 {h1(tip.usableMinutes)}</span>
        {tip.lines.map((line) => <span key={line.line} data-line={line.line} className="pl-tip-line">
          <i className="pl-swatch" />{labels[line.line] ?? line.line} {h1(line.scheduled + line.pending)}
          <small>已排 {h1(line.scheduled)} · 待排 {h1(line.pending)}{line.extra ? ` · 保守多 ${h1(line.extra)}` : ""}</small></span>)}
        {tip.top && <span>占用最多：{tip.top.title || "未命名里程碑"} {h1(tip.top.minutes)}</span>}
        {tip.overdueMinutes > 0 && <span>其中逾期 {h1(tip.overdueMinutes)}（截止在本周、未按时完成的工作）</span>}
        {tip.overloadMinutes > 0 && <strong className="pl-risk-text">超载 {hours(tip.overloadMinutes)} 小时</strong>}
      </div>}
    </div>
    <p className="pl-legend"><span className="pl-key" data-k="solid" />已排　<span className="pl-key" data-k="hatch" />待排　<span className="pl-key" data-k="extra" />保守估时多出
      <span className="pl-key" data-k="usable" />可用小时（扣除预留）</p>
    {overloaded.length > 0 ? <p className="pl-over-list">{overloaded.map((week) => <Tag key={week.week} tone="risk"
      {...(week.top ? { title: `占用最多：${week.top.title}` } : {})}>{md(week.start)} 起超载 {hours(week.overloadMinutes)} 小时</Tag>)}</p>
      : <p className="pl-chart-foot">各周需求均在可用小时内。</p>}
  </Card>;
}

/* ── 2. one timeline per line ── */

const STATE_LABEL: Record<MilestoneState, string> = { risk: "有完不成风险", unprepared: "待准备", library: "任务在任务库" };
const STATE_TITLE: Record<MilestoneState, string> = { risk: "保守完成日距截止不足 2 天，或在统计范围内排不完", unprepared: "尚无可排程的任务，或只有待批准的提案",
  library: "任务仍在任务库，里程碑三周内到期时排入日程" };

/** A milestone's mark: a dot in the line's colour when on track, a dot in its state's colour for one state, a split square for several. */
function Marker({ states, cx, cy, size = 11 }: { states: MilestoneState[]; cx: number; cy: number; size?: number }) {
  if (states.length < 2) return <circle cx={cx} cy={cy} r={size / 2} className="pl-ms-mark" data-state={states[0] ?? "on_track"} />;
  const part = size / states.length;
  return <g className="pl-ms-combo">
    {states.map((state, index) => <rect key={state} x={cx - size / 2 + index * part} y={cy - size / 2} width={part} height={size} className="pl-ms-mark" data-state={state} />)}
    <rect x={cx - size / 2} y={cy - size / 2} width={size} height={size} className="pl-ms-combo-frame" />
  </g>;
}

function markDetail(mark: MilestoneMark, weeks: number): string {
  const row = mark.row;
  return [mark.title, row.deadline ? `截止 ${row.deadline}` : "无截止日",
    row.p50Day ? `通常 ${row.p50Day} 完成${row.p85Day ? `，保守 ${row.p85Day}` : `，保守情景在 ${weeks} 周内未完成`}` : "",
    row.remainingP50Minutes ? `剩余 ${hours(row.remainingP50Minutes)} 小时` : "", row.slackDays !== null ? `余量 ${row.slackDays} 天` : "",
    row.status === "no_tasks" && row.proposals ? `${row.proposals} 项提案待批准` : "",
    row.libraryDay ? `${row.libraryDay} 起排入日程` : "", row.bottleneck ?? "",
    mark.states.length ? `状态：${mark.states.map((state) => STATE_LABEL[state]).join("、")}` : "状态：按计划"].filter(Boolean).join("\n");
}

/**
 * The plan page's head (decided 2026-10-15): one axis per line, a mark per approved milestone with its full name beside it, placed at
 * its deadline (else its cautious finish); state as colour — on track in the line's colour, at risk, not ready, waiting in the task
 * library — and a split square for a milestone in several states. Only unfinished milestones due inside the chosen horizon, and overdue
 * ones, are drawn, with at most three rows of names a line (a 「+N」 counts the marks left unnamed) so the charts below stay on the first
 * screen. The finish ranges are in each mark's hover text; the milestone page has the rest.
 */
export function MilestoneTimeline({ rows, today, weeks, spanDays, done = [], labels, lineOrder, aside }: { rows: GoalRow[]; today: string; weeks: number;
  /** The chosen horizon: only unfinished milestones due inside it (and overdue ones) are drawn. */ spanDays: number;
  /** Milestones whose work is all accepted. */ done?: string[];
  labels: Record<string, string>; lineOrder: string[]; aside?: ReactNode }) {
  const preview = usePlanPreview();
  const shown = preview?.after.goals ?? rows;
  const before = new Map(milestoneMarks(preview?.before.goals ?? [], today).map((mark) => [mark.id, mark]));
  const { shown: marks, outside } = timelineMarks(milestoneMarks(shown, today), today, spanDays, new Set(done));
  const [box, width] = useWidth(1100);
  const count = (state: MilestoneState) => marks.filter((mark) => mark.states.includes(state)).length;
  const rank = (line: string) => { const index = lineOrder.indexOf(line); return index < 0 ? lineOrder.length : index; };
  const lines = [...new Set(marks.map((mark) => mark.line))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const moved = marks.some((mark) => { const ghost = before.get(mark.id); return ghost && ghost.day !== mark.day; });
  // A mark sits at its deadline, so it stays put while the cautious finish moves: saying 「不移动任何里程碑」 then contradicted the
  // impact list beside it, which named milestones finishing days earlier (2026-10-18 walkthrough).
  const finishBefore = new Map((preview?.before.goals ?? []).map((goal) => [goal.id, goal.p85Day]));
  const finishMoved = shown.some((goal) => finishBefore.has(goal.id) && finishBefore.get(goal.id) !== goal.p85Day);
  return <section className="pl-card pl-stat pl-timeline" aria-label="里程碑时间轴">
    <header><h2>里程碑时间轴</h2>
      <small>范围内未完成 {marks.length} 个{outside ? ` · 范围外或已完成 ${outside} 个` : ""}{count("risk") ? ` · 有完不成风险 ${count("risk")}` : ""}{count("unprepared") ? ` · 待准备 ${count("unprepared")}` : ""}</small>
      {aside}</header>
    {preview && (moved ? <PreviewNote /> : <p className="pl-preview-note" role="status">{finishMoved
      ? "里程碑按截止日画，位置不变；预计完成日的变化见「改动影响」"
      : "预览中的改动不移动任何里程碑"}</p>)}
    <div ref={box} className="pl-chart-box">
      {!marks.length ? <p className="pl-empty">{outside ? "统计范围内没有未完成的里程碑。" : "尚无已批准的里程碑。"}</p>
        : width < 560 ? <TimelineList marks={marks} lines={lines} labels={labels} weeks={weeks} />
        : <TimelineAxis marks={marks} before={before} lines={lines} labels={labels} today={today} width={width} weeks={weeks} spanDays={spanDays} />}
    </div>
    <div className="pl-legend">
      <span><span className="pl-key" data-k="ms-on" />按计划（主线色）</span>
      {MILESTONE_STATE_ORDER.map((state) => <span key={state} title={STATE_TITLE[state]}><span className="pl-key" data-k={`ms-${state}`} />{STATE_LABEL[state]}</span>)}
      <span><span className="pl-key" data-k="ms-combo" />同时有多种状态</span>
      <span>点位为截止日，无截止时为保守完成日；只画统计范围内未完成的和已过期的</span>
    </div>
  </section>;
}

const GUTTER = 96, RIGHT = 8, AXIS_TOP = 20, LABEL_ROW = 15;
/** At most this many rows of names per line; a milestone whose name does not fit is drawn as a mark alone, its name on hover. */
export const MAX_LABEL_ROWS = 3;

function TimelineAxis({ marks, before, lines, labels, today, width, weeks, spanDays }: { marks: MilestoneMark[]; before: Map<string, MilestoneMark>; lines: string[];
  labels: Record<string, string>; today: string; width: number; weeks: number; spanDays: number }) {
  const span = timelineSpan(marks, today, spanDays);
  const plotW = Math.max(120, width - GUTTER - RIGHT);
  const xOf = (day: string) => GUTTER + dayAt(day, span.start, span.days).at * plotW;
  const ticks = monthTicks(span.start, span.end);
  const bands: ReactNode[] = [];
  let y = AXIS_TOP;
  for (const line of lines) {
    const own = marks.filter((mark) => mark.line === line);
    const xs = own.map((mark) => xOf(mark.day!));
    const packed = packLabels(own.map((mark, index) => ({ x: xs[index]! - GUTTER, width: textWidth(mark.title) })), width - GUTTER - RIGHT);
    const rows = Math.min(MAX_LABEL_ROWS, Math.max(1, ...packed.map((item) => item.row + 1)));
    const unnamed = packed.filter((item) => item.row >= MAX_LABEL_ROWS).length;
    const axisY = y + rows * LABEL_ROW + 12;
    const name = labels[line] ?? line;
    bands.push(<g key={line} data-line={line} className="pl-ms-band">
      <rect x={0} y={y + 4} width={3} height={axisY - y} className="pl-ms-bar" />
      <text x={10} y={axisY} dy="0.32em" className="pl-ms-line">{textWidth(name, 13) > GUTTER - 16 ? `${[...name].slice(0, 5).join("")}…` : name}<title>{name}</title></text>
      {unnamed > 0 && <text x={10} y={axisY - 17} className="pl-axis-text pl-ms-more">+{unnamed}<title>{`另有 ${unnamed} 个里程碑未标名称，悬停圆点可看全名`}</title></text>}
      <line x1={GUTTER} x2={GUTTER + plotW} y1={axisY} y2={axisY} className="pl-ms-track" />
      {own.map((mark, index) => {
        const x = xs[index]!, label = packed[index]!;
        const named = label.row < MAX_LABEL_ROWS;
        const labelY = axisY - 12 - label.row * LABEL_ROW;
        const ghost = before.get(mark.id);
        return <g key={mark.id}>
          {ghost && ghost.day !== mark.day && ghost.day && <circle cx={xOf(ghost.day)} cy={axisY} r={5.5} className="pl-ms-ghost"><title>{`改动前：${ghost.day}`}</title></circle>}
          <a href={`/milestones?open=${encodeURIComponent(mark.id)}`} className="pl-ms-point" data-deadline={mark.row.deadline ?? undefined}
            data-states={mark.states.join(" ") || "on_track"} aria-label={markDetail(mark, weeks).replace(/\n/g, "，")}>
            <title>{markDetail(mark, weeks)}</title>
            {named && <line x1={x} x2={x} y1={axisY - 6} y2={labelY + 3} className="pl-ms-leader" />}
            {named && <text x={GUTTER + label.left} y={labelY} className="pl-ms-label">{mark.title}</text>}
            <Marker states={mark.states} cx={x} cy={axisY} />
          </a>
        </g>;
      })}
    </g>);
    y = axisY + 14;
  }
  const height = y + 2;
  const todayX = xOf(today);
  return <svg className="pl-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label={`里程碑时间轴：${lines.map((line) => `${labels[line] ?? line} ${marks.filter((mark) => mark.line === line).length} 个`).join("，")}`}>
    {ticks.map((tick) => { const x = xOf(tick.day); return <g key={tick.day}>
      <line x1={x} x2={x} y1={AXIS_TOP - 4} y2={height} className="pl-grid-line" />
      <text x={x + 3} y={12} className="pl-axis-text">{tick.label}</text>
    </g>; })}
    <line x1={todayX} x2={todayX} y1={AXIS_TOP - 4} y2={height} className="pl-ms-today"><title>今天</title></line>
    {bands}
  </svg>;
}

/** On a phone the axis would be a few pixels a week: the same marks as a dated list per line. */
function TimelineList({ marks, lines, labels, weeks }: { marks: MilestoneMark[]; lines: string[]; labels: Record<string, string>; weeks: number }) {
  return <div className="pl-ms-list">{lines.map((line) => <section key={line} data-line={line}>
    <LineTag line={line}>{labels[line] ?? line}</LineTag>
    <ol>{marks.filter((mark) => mark.line === line).sort((a, b) => (a.day ?? "9999").localeCompare(b.day ?? "9999")).map((mark) =>
      <li key={mark.id}><a href={`/milestones?open=${encodeURIComponent(mark.id)}`} className="pl-ms-point" data-deadline={mark.row.deadline ?? undefined} title={markDetail(mark, weeks)}>
        <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true"><Marker states={mark.states} cx={7} cy={7} /></svg>
        <span className="mono">{mark.day ? md(mark.day) : "未定"}</span>
        <span className="pl-ms-name">{mark.title}</span>
        {mark.states.map((state) => <Tag key={state} tone={state === "risk" ? "risk" : "neutral"}>{STATE_LABEL[state]}</Tag>)}
      </a></li>)}</ol>
  </section>)}</div>;
}

/* ── 3. planned against timed hours, as a histogram ── */

/**
 * Hours a week per line (decided 2026-10-15): the plan's (light, outlined in the line's colour), the timer's (solid), and the next seven
 * days' plan (dashed), side by side so a line that is planned and not worked shows as a tall light bar beside a short dark one. Planned
 * is averaged over the days the plan was recorded, timed over the four weeks.
 */
export function InvestmentChart({ data, labels }: { data: Investment; labels: Record<string, string> }) {
  const preview = usePlanPreview();
  const next7 = preview?.after.next7 ?? data.next7;
  const ghost = preview?.before.next7 ?? null;
  const [box, width] = useWidth(420);
  const lines = data.lines.filter((line) => line.stated || data.weeks.some((week) => week.planned[line.line] || week.actual[line.line]) || next7[line.line] || ghost?.[line.line]);
  const recorded = data.weeks.reduce((sum, week) => sum + week.recordedDays, 0);
  const weekly = (line: string) => ({
    planned: recorded ? data.weeks.reduce((sum, week) => sum + (week.planned[line] ?? 0), 0) / recorded * 7 : null,
    actual: data.hasActual ? data.weeks.reduce((sum, week) => sum + (week.actual[line] ?? 0), 0) / 4 : null,
    next: next7[line] ?? 0, before: ghost ? ghost[line] ?? 0 : null });
  const values = lines.map((line) => weekly(line.line));
  const peak = Math.max(60, ...values.flatMap((value) => [value.planned ?? 0, value.actual ?? 0, value.next, value.before ?? 0])) / 60;
  const ticks = linearTicks(peak, 3);
  const H = 196, top = 14, bottom = 40, left = 30;
  const plotW = Math.max(160, width - left - 4), plotH = H - top - bottom;
  const y = linear(ticks.at(-1)!, top + plotH, top);
  const groups = bands(Math.max(1, lines.length), plotW, 0.82);
  const bar = Math.max(4, groups.bar / 3 - 2);
  const empty = !data.hasActual && !data.hasPlanned && !Object.values(next7).some(Boolean);
  const next7Moved = Boolean(ghost && Object.keys({ ...ghost, ...next7 }).some((line) => (ghost[line] ?? 0) !== (next7[line] ?? 0)));
  const say = (value: number | null, none: string) => value === null ? none : `${hours(value)} 小时`;
  return <Card title="主线投入：计划 vs 实际" label="主线投入：计划与实际" note="每周小时，近 4 周">
    {next7Moved && <PreviewNote />}
    {empty ? <p className="pl-empty">尚无实测</p> : <div ref={box} className="pl-chart-box">
      <svg className="pl-svg" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img"
        aria-label={`每周小时：${lines.map((line, index) => `${labels[line.line] ?? line.line} 计划 ${say(values[index]!.planned, "未记录")}，实际 ${say(values[index]!.actual, "尚无实测")}，未来 7 天 ${hours(values[index]!.next)} 小时`).join("；")}`}>
        {ticks.map((tick) => <g key={tick}>
          <line x1={left} x2={left + plotW} y1={y(tick)} y2={y(tick)} className="pl-grid-line" />
          <text x={left - 4} y={y(tick)} dy="0.32em" textAnchor="end" className="pl-axis-text">{tick}</text>
        </g>)}
        {lines.map((line, index) => {
          const value = values[index]!, name = labels[line.line] ?? line.line;
          const x0 = left + groups.x(index);
          const shares = [line.stated !== null ? `所述 ${line.stated}%` : "", line.actualShare !== null ? `实际 ${line.actualShare}%` : "", line.plannedShare !== null ? `计划 ${line.plannedShare}%` : ""].filter(Boolean).join(" · ");
          const rect = (slot: number, minutes: number, kind: string, title: string) => <rect key={kind} x={x0 + slot * (bar + 2)} width={bar} y={y(minutes / 60)}
            height={Math.max(minutes > 0 ? 1.5 : 0, y(0) - y(minutes / 60))} className={`pl-bar pl-bar-${kind}`}><title>{title}</title></rect>;
          return <g key={line.line} data-line={line.line}>
            {value.planned !== null && rect(0, value.planned, "planned", `${name} · 计划 ${h1(value.planned)}/周（按有记录的 ${recorded} 天折算）${shares ? ` · ${shares}` : ""}`)}
            {value.actual !== null && rect(1, value.actual, "actual", `${name} · 实际计时 ${h1(value.actual)}/周（近 4 周平均）${shares ? ` · ${shares}` : ""}`)}
            {rect(2, value.next, "next", `${name} · 未来 7 天计划 ${h1(value.next)}`)}
            {value.before !== null && value.before !== value.next && <rect x={x0 + 2 * (bar + 2) - 1.5} width={bar + 3} y={y(value.before / 60)}
              height={Math.max(0, y(0) - y(value.before / 60))} className="pl-ghost"><title>{`改动前未来 7 天计划 ${h1(value.before)}`}</title></rect>}
            <text x={left + groups.centre(index)} y={H - 24} textAnchor="middle" className="pl-axis-text pl-axis-strong">{textWidth(name) > groups.band - 4 ? `${[...name].slice(0, 4).join("")}…` : name}<title>{name}</title></text>
            {line.stated !== null && groups.band >= 56 && <text x={left + groups.centre(index)} y={H - 8} textAnchor="middle" className="pl-axis-text">所述 {line.stated}%</text>}
          </g>;
        })}
        <text x={2} y={10} className="pl-axis-text">h/周</text>
      </svg>
      <p className="pl-legend"><span><span className="pl-key" data-k="bar-planned" />计划</span><span><span className="pl-key" data-k="bar-actual" />实际计时</span>
        <span><span className="pl-key" data-k="bar-next" />未来 7 天计划</span>
        {!data.hasActual && <span>尚无实测</span>}{!data.hasPlanned && <span>计划时长尚未记录</span>}</p>
    </div>}
  </Card>;
}

/* ── 4. estimate accuracy ── */

export function EstimateChart({ estimates, labels }: { estimates: { points: EstimatePoint[]; covered: number; coverage: number | null }; labels: Record<string, string> }) {
  const [box, width] = useWidth(260);
  return <Card title="估时准确度" label="估时准确度" note={estimates.points.length ? `${estimates.points.length} 项实测` : undefined}>
    {!estimates.points.length ? <p className="pl-empty">尚无实测</p> : <div ref={box} className="pl-est">
      <Scatter estimates={estimates} labels={labels} size={Math.max(170, Math.min(width - 4, 230))} />
      <div className="pl-coverage">
        <Ring value={estimates.coverage ?? 0} label="保守估时覆盖率" size={48} />
        <span><b className="mono">{estimates.covered}/{estimates.points.length}</b> 项在保守估时以内</span>
      </div>
      <p className="pl-legend"><span><span className="pl-key" data-k="actual" />以内</span><span><span className="pl-key" data-k="outside" />超出</span><span>对角线上方为超出通常估时</span></p>
    </div>}
  </Card>;
}

function Scatter({ estimates, labels, size }: { estimates: { points: EstimatePoint[] }; labels: Record<string, string>; size: number }) {
  const domain = logDomain(estimates.points.flatMap((point) => [point.estimate, point.actual]));
  const { left, right, top, bottom, titleBaseline } = scatterMargins(domain.ticks);
  const x = logScale(domain.min, domain.max, left, size - right), y = logScale(domain.min, domain.max, size - bottom, top);
  return <svg className="pl-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
    aria-label={`估时与实际：${estimates.points.length} 项`}>
    {domain.ticks.map((tick) => <g key={tick}>
      <line x1={x(tick)} x2={x(tick)} y1={top} y2={size - bottom} className="pl-grid-line" />
      <line x1={left} x2={size - right} y1={y(tick)} y2={y(tick)} className="pl-grid-line" />
      <text x={x(tick)} y={size - bottom + 14} textAnchor="middle" className="pl-axis-text">{minuteLabel(tick)}</text>
      <text x={left - 4} y={y(tick)} dy="0.32em" textAnchor="end" className="pl-axis-text">{minuteLabel(tick)}</text>
    </g>)}
    <line x1={x(domain.min)} y1={y(domain.min)} x2={x(domain.max)} y2={y(domain.max)} className="pl-diagonal"><title>对角线：实际等于估时</title></line>
    {estimates.points.map((point) => <circle key={point.id} cx={x(point.estimate)} cy={y(point.actual)} r={4.5} data-line={point.line} data-covered={point.covered || undefined}
      className="pl-point"><title>{`${labels[point.line] ?? point.line} · 估时 ${point.estimate} 分 · 实际 ${point.actual} 分 · 保守估时 ${point.p85} 分${point.covered ? "以内" : "以外"}`}</title></circle>)}
    <text x={size - right} y={size - 2} textAnchor="end" className="pl-axis-text">估时</text>
    <text x={2} y={titleBaseline} className="pl-axis-text">实际</text>
  </svg>;
}

/* ── 5. the timed rhythm under an energy pattern ── */

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const LEVEL_WORD = ["不可用", "低精力", "中精力", "高精力"];

/**
 * Eight weeks of timed work per weekday × hour (grey, darker for more), each hour underlined in the colour of the energy the pattern gives
 * it — the hours the person said and the hours they worked, on one small grid. Two of them side by side are 「调整前 / 调整后」.
 */
export function RhythmMini({ worked, pattern, title }: { worked: number[][]; pattern: number[][]; title: string }) {
  const [box, width] = useWidth(300);
  const left = 22, top = 4, rowH = 14, cell = Math.max(5, (Math.min(width, 420) - left - 4) / 24);
  const W = left + cell * 24 + 4, H = top + rowH * 7 + 18;
  const max = Math.max(0, ...worked.flat());
  const total = worked.flat().reduce((sum, value) => sum + value, 0);
  const levelAt = (day: number, hour: number) => Math.max(pattern[day]?.[hour * 2] ?? 0, pattern[day]?.[hour * 2 + 1] ?? 0);
  return <figure className="pl-mini" ref={box}>
    <figcaption>{title}</figcaption>
    <svg className="pl-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}：近 8 周计时 ${hours(total)} 小时，色条为精力设置`}>
      {ORDER.map((day, index) => <g key={day}>
        <text x={left - 4} y={top + index * rowH + rowH / 2} dy="0.32em" textAnchor="end" className="pl-axis-text">{WEEKDAY[day]!.slice(1)}</text>
        {Array.from({ length: 24 }, (_, hour) => {
          const minutes = worked[day]?.[hour] ?? 0, level = levelAt(day, hour);
          const cx = left + hour * cell, cy = top + index * rowH;
          return <g key={hour}>
            <rect x={cx + 0.5} y={cy + 0.5} width={cell - 1} height={rowH - 1} className="pl-heat" data-level={heatLevel(minutes, max)}>
              <title>{`${WEEKDAY[day]} ${hour}–${hour + 1} 时 · 实际 ${Math.round(minutes)} 分 · ${LEVEL_WORD[level]}`}</title></rect>
            {level > 0 && <rect x={cx + 0.5} y={cy + rowH - 4} width={cell - 1} height={3.5} className="pl-lv" data-level={level} />}
          </g>;
        })}
      </g>)}
      {[0, 6, 12, 18, 24].map((hour) => <text key={hour} x={left + hour * cell} y={H - 4} textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"} className="pl-axis-text">{hour}</text>)}
    </svg>
  </figure>;
}
