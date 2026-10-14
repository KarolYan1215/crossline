"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { availabilityGrid, type CapacityWeek, type EstimatePoint, type GoalRow, type Investment } from "../../lib/plan-stats";
import { Ring } from "../ui/charts";
import { LineTag, Tag } from "../ui/tag";
import { bands, dayAt, dayTicks, heatLevel, hours, labelEvery, linear, linearTicks, logDomain, logScale, md, minuteLabel } from "./chart-geometry";
import { usePlanPreview } from "./preview-context";

/**
 * The plan page's four long-range charts (decided 2026-10-10): capacity against demand, milestone finish ranges, planned against timed
 * hours per line, and estimate accuracy with the weekly rhythm. Hand-drawn SVG like `app/ui/charts.tsx`; every mark has its exact value
 * on hover. While a change is previewed below, the charts it moves draw the after-state with the current values as dashed ghosts.
 */

/** The width a chart has, so it is drawn at that width and its 12px labels stay 12px on a phone. */
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
  const H = 230, top = 24, bottom = 26, left = 34, right = 6;
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

/* ── 2. milestone finish ranges ── */

export function MilestoneForecast({ rows, today, spanDays, weeks, labels, inferredRegularBlocks }: { rows: GoalRow[]; today: string; spanDays: number; weeks: number;
  labels: Record<string, string>; inferredRegularBlocks: number }) {
  const preview = usePlanPreview();
  const shown = preview?.after.goals ?? rows;
  const before = new Map((preview?.before.goals ?? []).map((row) => [row.id, row]));
  const ticks = dayTicks(today, spanDays);
  const pct = (day: string) => dayAt(day, today, spanDays).at * 100;
  const groups = [...new Set(shown.map((row) => row.line))];
  const anyMoved = shown.some((row) => { const ghost = before.get(row.id); return ghost && (ghost.p50Day !== row.p50Day || ghost.p85Day !== row.p85Day); });
  return <Card title="里程碑完成预测" label="里程碑完成预测" note="按当前估时与容量推算的情景">
    {preview && (anyMoved ? <PreviewNote /> : <p className="pl-preview-note" role="status">预览中的改动不改变各里程碑的完成区间</p>)}
    {!shown.length ? <p className="pl-chart-foot">尚无已批准的里程碑。</p> : <div className="pl-gantt">
      <div className="pl-gantt-axis" aria-hidden="true">{ticks.map((tick, index) => <span key={tick} style={{ left: `${pct(tick)}%` }}
        data-edge={index === 0 ? "start" : index === ticks.length - 1 && pct(tick) > 92 ? "end" : undefined}>{md(tick)}</span>)}</div>
      {groups.map((line) => <div key={line} className="pl-gantt-group" data-line={line}>
        <div className="pl-gantt-head"><LineTag line={line}>{labels[line] ?? line}</LineTag></div>
        {shown.filter((row) => row.line === line).map((row) => {
          const ghost = before.get(row.id);
          const moved = ghost && (ghost.p50Day !== row.p50Day || ghost.p85Day !== row.p85Day);
          const deadline = row.deadline ? dayAt(row.deadline, today, spanDays) : null;
          const library = row.libraryDay ? dayAt(row.libraryDay, today, spanDays) : null;
          return <a key={row.id} className="pl-gantt-row" href={`/milestones?open=${encodeURIComponent(row.id)}`} data-risk={row.atRisk || undefined}
            aria-label={`${row.title}：${row.p50Day ? `通常 ${md(row.p50Day)} 完成` : "无法推算通常完成日"}${row.p85Day ? `，保守 ${md(row.p85Day)}` : ""}${row.deadline ? `，截止 ${md(row.deadline)}` : ""}，剩余 ${hours(row.remainingP50Minutes)} 小时`}>
            <span className="pl-gantt-title" title={row.title}>{row.title}</span>
            <span className="pl-gantt-track">
              {row.p50Day && <i className="pl-gantt-bar" style={{ left: `${pct(row.p50Day)}%`, width: `${Math.max(0.8, (row.p85Day ? pct(row.p85Day) : 100) - pct(row.p50Day))}%` }}
                data-open={row.p85Day ? undefined : ""} title={`通常完成 ${row.p50Day}${row.p85Day ? ` · 保守完成 ${row.p85Day}` : ` · 保守情景在 ${weeks} 周内未完成`}`} />}
              {moved && ghost.p50Day && <i className="pl-gantt-ghost" style={{ left: `${pct(ghost.p50Day)}%`, width: `${Math.max(0.8, (ghost.p85Day ? pct(ghost.p85Day) : 100) - pct(ghost.p50Day))}%` }}
                title={`改动前：通常 ${ghost.p50Day}${ghost.p85Day ? ` · 保守 ${ghost.p85Day}` : ""}`} />}
              {library && library.clipped !== "before" && <i className="pl-gantt-library" style={{ left: `${library.at * 100}%` }} data-library={row.libraryDay}
                title={`${row.libraryDay} 起离开任务库、排入日程`} />}
              {deadline && <i className="pl-gantt-deadline" style={{ left: `${deadline.at * 100}%` }} data-deadline={row.deadline} data-clipped={deadline.clipped ?? undefined}
                title={`截止 ${row.deadline}${deadline.clipped === "after" ? "（超出视图）" : deadline.clipped === "before" ? "（已过）" : ""}${row.slackDays !== null ? ` · 余量 ${row.slackDays} 天` : ""}`} />}
            </span>
            <span className="pl-gantt-end">
              <small className="mono" title={`剩余工作：通常 ${hours(row.remainingP50Minutes)} 小时，保守 ${hours(row.remainingP85Minutes)} 小时`}>剩 {h1(row.remainingP50Minutes)}</small>
              {row.status === "no_tasks" && (row.proposals ? <Tag title="在「待确认」批准后排入日程">{row.proposals} 项提案待批准</Tag>
                : <Tag title="该里程碑下尚无可排程的任务">尚无任务</Tag>)}
              {row.status === "unforecast" && <Tag title="重要性低于 60 且无截止日的里程碑不参与预测">无截止日</Tag>}
              {row.status === "unfinished" && <Tag tone="warn" title={row.bottleneck ?? `按当前容量 ${weeks} 周内排不完`}>{weeks} 周内未完成</Tag>}
              {row.atRisk ? <Tag tone="risk" title={`保守完成日距截止 ${row.slackDays} 天，不足 2 天`}>余量 {row.slackDays} 天</Tag>
                : row.slackDays !== null && <small className="mono" title="保守完成日到截止日的天数">余量 {row.slackDays} 天</small>}
            </span>
          </a>;
        })}
      </div>)}
      <p className="pl-legend"><span className="pl-key" data-k="range" />通常 → 保守完成　<span className="pl-key" data-k="deadline" />截止　<span className="pl-key" data-k="library" />任务库进入日</p>
    </div>}
    {inferredRegularBlocks > 0 && <small className="pl-chart-foot">第 2 周起按日历中的 {inferredRegularBlocks} 个重复日程预留时间。</small>}
  </Card>;
}

/* ── 3. planned against timed hours ── */

export function InvestmentChart({ data, labels }: { data: Investment; labels: Record<string, string> }) {
  const preview = usePlanPreview();
  const next7 = preview?.after.next7 ?? data.next7;
  const ghost = preview?.before.next7 ?? null;
  const [box, width] = useWidth(640);
  const wide = width >= 560;
  const plotW = Math.max(160, wide ? width - 96 - 132 - 24 : width);
  const lines = data.lines.filter((line) => line.stated || data.weeks.some((week) => week.planned[line.line] || week.actual[line.line]) || next7[line.line] || ghost?.[line.line]);
  const peak = Math.max(1, ...data.weeks.flatMap((week) => [...Object.values(week.planned), ...Object.values(week.actual)]), ...Object.values(next7), ...Object.values(ghost ?? {})) / 60;
  const ticks = linearTicks(peak, 2);
  const H = 62;
  const y = linear(ticks.at(-1)!, H - 8, 8);
  const layout = bands(5, plotW);
  const columns = [...data.weeks.map((week) => `${md(week.start)} 起`), "未来 7 天"];
  const empty = !data.hasActual && !data.hasPlanned && !Object.values(next7).some(Boolean);
  const next7Moved = Boolean(ghost && Object.keys({ ...ghost, ...next7 }).some((line) => (ghost[line] ?? 0) !== (next7[line] ?? 0)));
  return <Card title="主线投入：计划 vs 实际" label="主线投入：计划与实际" note={`近 4 周 · 纵轴 0–${ticks.at(-1)} 小时`}>
    {next7Moved && <PreviewNote />}
    {empty ? <p className="pl-empty">尚无实测</p> : <div ref={box} className="pl-inv" data-wide={wide || undefined}>
      <div className="pl-inv-row pl-inv-cols" aria-hidden="true"><span />
        <svg width={plotW} height={18} viewBox={`0 0 ${plotW} 18`}>{columns.map((label, index) => <text key={label} x={layout.centre(index)} y={13} textAnchor="middle" className="pl-axis-text">{label}</text>)}</svg>
        {wide && <span />}</div>
      {lines.map((line) => {
        const name = labels[line.line] ?? line.line;
        return <div key={line.line} className="pl-inv-row" data-line={line.line}>
          <b className="pl-inv-name">{name}</b>
          <svg width={plotW} height={H} viewBox={`0 0 ${plotW} ${H}`} role="img" className="pl-svg"
            aria-label={`${name}：${data.weeks.map((week) => `${md(week.start)} 起计划 ${week.recordedDays ? `${hours(week.planned[line.line] ?? 0)} 小时` : "未记录"}，实际 ${hours(week.actual[line.line] ?? 0)} 小时`).join("；")}；未来 7 天计划 ${hours(next7[line.line] ?? 0)} 小时`}>
            <line x1={0} x2={plotW} y1={y(0)} y2={y(0)} className="pl-grid-line" />
            {data.weeks.map((week, index) => {
              const cx = layout.centre(index);
              const planned = week.recordedDays ? week.planned[line.line] ?? 0 : null;
              // With nothing ever timed, a row of zeros would read as a measurement; the legend says 「尚无实测」 instead.
              const actual = data.hasActual ? week.actual[line.line] ?? 0 : null;
              return <g key={week.start}>
                {planned !== null && actual !== null && <line x1={cx} x2={cx} y1={y(planned / 60)} y2={y(actual / 60)} className="pl-dumbbell" />}
                {planned !== null && <circle cx={cx} cy={y(planned / 60)} r={5} className="pl-dot-planned">
                  <title>{`${name} · ${md(week.start)}–${md(week.end)} 计划 ${h1(planned)}（记录 ${week.recordedDays} 天）`}</title></circle>}
                {actual !== null && <circle cx={cx} cy={y(actual / 60)} r={4.5} className="pl-dot-actual">
                  <title>{`${name} · ${md(week.start)}–${md(week.end)} 实际计时 ${h1(actual)}${planned === null ? "；计划时长未记录" : ""}`}</title></circle>}
              </g>;
            })}
            {ghost && (ghost[line.line] ?? 0) !== (next7[line.line] ?? 0) && <circle cx={layout.centre(4)} cy={y((ghost[line.line] ?? 0) / 60)} r={5} className="pl-dot-ghost">
              <title>{`改动前未来 7 天计划 ${h1(ghost[line.line] ?? 0)}`}</title></circle>}
            <circle cx={layout.centre(4)} cy={y((next7[line.line] ?? 0) / 60)} r={5} className="pl-dot-next"><title>{`${name} · 未来 7 天计划 ${h1(next7[line.line] ?? 0)}`}</title></circle>
          </svg>
          <span className="pl-inv-share mono">
            {line.stated !== null && <span title="访谈中本人所述的投入比例">所述 {line.stated}%</span>}
            {line.actualShare !== null && <span title="近 4 周计时小时中的占比">实际 {line.actualShare}%</span>}
            {line.plannedShare !== null && <span title="近 4 周有记录的计划小时中的占比">计划 {line.plannedShare}%</span>}
          </span>
        </div>;
      })}
      <p className="pl-legend"><span className="pl-key" data-k="planned" />计划　<span className="pl-key" data-k="actual" />实际计时　<span className="pl-key" data-k="next" />未来 7 天计划
        {!data.hasActual && <>　· 尚无实测</>}{!data.hasPlanned && <>　· 近 4 周计划时长尚未记录</>}</p>
    </div>}
  </Card>;
}

/* ── 4. estimates and rhythm ── */

export function EstimateRhythm({ estimates, rhythm, labels }: { estimates: { points: EstimatePoint[]; covered: number; coverage: number | null };
  rhythm: { worked: number[][]; available: number[][] }; labels: Record<string, string> }) {
  const preview = usePlanPreview();
  const available = preview ? availabilityGrid(preview.after.windows) : rhythm.available;
  const ghost = preview ? availabilityGrid(preview.before.windows) : null;
  const changed = Boolean(ghost && JSON.stringify(ghost) !== JSON.stringify(available));
  return <Card title="估时准确度与节律" label="估时准确度与节律">
    {preview && changed && <PreviewNote />}
    <div className="pl-er">
      <Scatter estimates={estimates} labels={labels} />
      <Heatmap worked={rhythm.worked} available={available} ghost={changed ? ghost : null} />
    </div>
  </Card>;
}

function Scatter({ estimates, labels }: { estimates: { points: EstimatePoint[]; covered: number; coverage: number | null }; labels: Record<string, string> }) {
  const [box, width] = useWidth(340);
  if (!estimates.points.length) return <div className="pl-er-part"><h3>估时 vs 实际</h3><p className="pl-empty">尚无实测</p></div>;
  const size = Math.min(width, 360), left = 44, bottom = 30, top = 8, right = 8;
  const domain = logDomain(estimates.points.flatMap((point) => [point.estimate, point.actual]));
  const x = logScale(domain.min, domain.max, left, size - right), y = logScale(domain.min, domain.max, size - bottom, top);
  return <div className="pl-er-part" ref={box}>
    <h3>估时 vs 实际</h3>
    <svg className="pl-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
      aria-label={`估时与实际：${estimates.points.length} 项，${estimates.covered} 项在保守估时内`}>
      {domain.ticks.map((tick) => <g key={tick}>
        <line x1={x(tick)} x2={x(tick)} y1={top} y2={size - bottom} className="pl-grid-line" />
        <line x1={left} x2={size - right} y1={y(tick)} y2={y(tick)} className="pl-grid-line" />
        <text x={x(tick)} y={size - bottom + 14} textAnchor="middle" className="pl-axis-text">{minuteLabel(tick)}</text>
        <text x={left - 4} y={y(tick)} dy="0.32em" textAnchor="end" className="pl-axis-text">{minuteLabel(tick)}</text>
      </g>)}
      <line x1={x(domain.min)} y1={y(domain.min)} x2={x(domain.max)} y2={y(domain.max)} className="pl-diagonal"><title>对角线：实际等于估时</title></line>
      {estimates.points.map((point) => <circle key={point.id} cx={x(point.estimate)} cy={y(point.actual)} r={4.5} data-line={point.line} data-covered={point.covered || undefined}
        className="pl-point"><title>{`${labels[point.line] ?? point.line} · 估时 ${point.estimate} 分 · 实际 ${point.actual} 分 · 保守估时 ${point.p85} 分${point.covered ? "以内" : "以外"}`}</title></circle>)}
      <text x={size - right} y={size - 4} textAnchor="end" className="pl-axis-text">估时（通常）</text>
      <text x={2} y={top + 4} dy="0.6em" className="pl-axis-text">实际</text>
    </svg>
    <p className="pl-legend"><span className="pl-key" data-k="actual" />在保守估时以内　<span className="pl-key" data-k="outside" />超出保守估时</p>
    <div className="pl-coverage">
      <Ring value={estimates.coverage ?? 0} label="保守估时覆盖率" size={52} />
      <span><b className="mono">{estimates.covered}/{estimates.points.length}</b> 项实际用时在保守估时以内<br /><small>对角线上方为超出通常估时</small></span>
    </div>
  </div>;
}

const ORDER = [1, 2, 3, 4, 5, 6, 0];
function Heatmap({ worked, available, ghost }: { worked: number[][]; available: number[][]; ghost: number[][] | null }) {
  const [box, width] = useWidth(360);
  const total = worked.flat().reduce((sum, value) => sum + value, 0);
  if (!total) return <div className="pl-er-part" ref={box}><h3>近 8 周工作节律</h3><p className="pl-empty">尚无实测</p></div>;
  const left = 34, top = 18, cell = Math.max(8, (Math.min(width, 520) - left) / 24), row = 18;
  const W = left + cell * 24, H = top + row * 7;
  const max = Math.max(...worked.flat());
  return <div className="pl-er-part" ref={box}>
    <h3>近 8 周工作节律</h3>
    <svg className="pl-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`星期与小时的实际工作分布，共 ${hours(total)} 小时，外框为可用时段`}>
      {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => <text key={hour} x={left + hour * cell} y={12} className="pl-axis-text">{hour}</text>)}
      {ORDER.map((day, index) => <g key={day}>
        <text x={left - 4} y={top + index * row + row / 2} dy="0.32em" textAnchor="end" className="pl-axis-text">{WEEKDAY[day]!.slice(1)}</text>
        {worked[day]!.map((minutes, hour) => {
          const cx = left + hour * cell, cy = top + index * row;
          const inside = (available[day]?.[hour] ?? 0) >= 0.5, before = ghost ? (ghost[day]?.[hour] ?? 0) >= 0.5 : inside;
          return <g key={hour}>
            <rect x={cx + 0.5} y={cy + 0.5} width={cell - 1} height={row - 1} className="pl-heat" data-level={heatLevel(minutes, max)}>
              <title>{`${WEEKDAY[day]} ${hour}–${hour + 1} 时 · 实际 ${Math.round(minutes)} 分${inside ? " · 可用时段内" : ""}${ghost && before !== inside ? (inside ? " · 改动后新增" : " · 改动后移除") : ""}`}</title></rect>
            {inside && <rect x={cx + 1.5} y={cy + 1.5} width={cell - 3} height={row - 3} className="pl-heat-avail" />}
            {ghost && before && !inside && <rect x={cx + 1.5} y={cy + 1.5} width={cell - 3} height={row - 3} className="pl-heat-avail pl-heat-ghost" />}
          </g>;
        })}
      </g>)}
    </svg>
    <p className="pl-legend"><span className="pl-key" data-k="heat" />实际工作分钟（越深越多）　<span className="pl-key" data-k="avail" />可用时段</p>
  </div>;
}
