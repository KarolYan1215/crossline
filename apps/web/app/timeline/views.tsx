import type { CSSProperties } from "react";
import {
  MINUTES_PER_DAY, axisSpan, conflictingIds, itemsOn, monthGrid, packColumns, toMinutes, weekDays,
  type TimelineDeadline, type TimelineItem
} from "./model";

export type LineLabels = Record<string, string>;
const WEEKDAY = ["一", "二", "三", "四", "五", "六", "日"];
const KIND_LABEL: Record<TimelineItem["kind"], string> = { calendar: "日历", scheduled: "排程", import: "文件", activity: "实际" };

const lineOf = (identityId?: string) => identityId ?? "none";
const timeText = (item: { start: string; end: string }) => `${item.start}–${item.end}`;

/** One row per item along a 24 hour axis. The time axis is the point: where in the day each thing sits. */
export function DayTimeline({ day, items, deadlines, nowMinute, labels, quiet, selectedId, onSelect }: {
  day: string; items: TimelineItem[]; deadlines: TimelineDeadline[]; nowMinute: number | undefined; labels: LineLabels;
  /** Stretches of the day that are not available (sleep, meals), drawn pale. */
  quiet?: Array<[string, string]> | undefined; selectedId?: string | undefined; onSelect?: ((item: TimelineItem) => void) | undefined;
}) {
  const rows = itemsOn(items, day);
  const clashes = conflictingIds(rows);
  const flags = deadlines.filter((deadline) => deadline.day === day);
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return <div className="dt" role="group" aria-label={`${day} 的时间轴`}>
    <div className="dt-scroll">
      <div className="dt-grid">
        {/* The hour grid and the unavailable hours sit behind every row and run the full height, so an empty or
            nearly empty day is still a day you can read, not a thin strip. */}
        <div className="dt-lines" aria-hidden="true">
          {quiet?.map(([from, to], index) => { const q = axisSpan(from, to); return <u key={index} className="dt-quiet" style={{ left: `${q.left}%`, width: `${q.width}%` }} />; })}
        </div>
        <div className="dt-axis" aria-hidden="true">
          <span className="dt-label-col" />
          <span className="dt-track">{hours.map((hour) => <i key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{hour % 2 === 0 ? String(hour).padStart(2, "0") : ""}</i>)}</span>
        </div>
        {flags.map((flag) => <div className="dt-row dt-flag" key={flag.id} data-line={lineOf(flag.identityId)}>
          <span className="dt-label-col"><b>◆ {flag.title}</b><small>截止</small></span><span className="dt-track" />
        </div>)}
        {rows.map((item) => {
          const span = axisSpan(item.start, item.end);
          return <button type="button" className="dt-row" key={item.id} data-line={lineOf(item.identityId)} data-kind={item.kind}
            data-clash={clashes.has(item.id) || undefined} aria-pressed={selectedId === item.id} onClick={() => onSelect?.(item)}>
            <span className="dt-label-col"><b>{item.title}</b><small>{timeText(item)}{item.identityId ? ` · ${labels[item.identityId] ?? item.identityId}` : ""}</small></span>
            <span className="dt-track"><em className="dt-block" style={{ left: `${span.left}%`, width: `${span.width}%` }}>{timeText(item)}</em></span>
          </button>;
        })}
        {rows.length === 0 && flags.length === 0 && <p className="dt-empty">这一天没有安排。灰色是你标为不可用的时段，其余时间可以排任务。</p>}
        {nowMinute !== undefined && <span className="dt-now" style={{ "--p": nowMinute / MINUTES_PER_DAY } as CSSProperties}><i>现在</i></span>}
      </div>
    </div>
  </div>;
}

const HOUR_PX = 44;

/** Seven days side by side, each with the same vertical hour axis, so the shape of the week reads at a glance. */
export function WeekView({ anchor, today, items, deadlines, labels, selectedId, onSelect, onOpenDay }: {
  anchor: string; today: string; items: TimelineItem[]; deadlines: TimelineDeadline[]; labels: LineLabels;
  selectedId?: string | undefined; onSelect?: ((item: TimelineItem) => void) | undefined; onOpenDay?: ((day: string) => void) | undefined;
}) {
  const days = weekDays(anchor);
  return <div className="wk" role="group" aria-label="一周">
    <div className="wk-scroll">
      <div className="wk-head">
        <span className="wk-gutter" />
        {days.map((day, index) => <div key={day} className="wk-day" data-today={day === today || undefined}>
          <button type="button" onClick={() => onOpenDay?.(day)}>周{WEEKDAY[index]} <b>{Number(day.slice(8))}</b></button>
          {deadlines.filter((deadline) => deadline.day === day).map((deadline) => <span key={deadline.id} className="wk-flag" data-line={lineOf(deadline.identityId)} title={deadline.title}>◆ {deadline.title}</span>)}
        </div>)}
      </div>
      <div className="wk-body" data-scroll-to-morning style={{ "--hour": `${HOUR_PX}px` } as CSSProperties}>
        <div className="wk-gutter">{Array.from({ length: 24 }, (_, hour) => <i key={hour} style={{ top: hour * HOUR_PX }}>{String(hour).padStart(2, "0")}</i>)}</div>
        {days.map((day) => {
          const packed = packColumns(itemsOn(items, day));
          return <div className="wk-col" key={day} data-today={day === today || undefined}>
            {packed.map(({ item, column, columns }) => {
              const top = (toMinutes(item.start) / 60) * HOUR_PX;
              const height = Math.max(((toMinutes(item.end) - toMinutes(item.start)) / 60) * HOUR_PX, 14);
              return <button type="button" key={item.id} className="wk-block" data-line={lineOf(item.identityId)} data-kind={item.kind} aria-pressed={selectedId === item.id}
                style={{ top, height, left: `${(column / columns) * 100}%`, width: `${100 / columns}%` }} onClick={() => onSelect?.(item)}
                title={`${item.title} ${timeText(item)}${item.identityId ? ` · ${labels[item.identityId] ?? item.identityId}` : ""}`}>
                <b>{item.title}</b><small>{item.start}</small>
              </button>;
            })}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

const MAX_CHIPS = 3;

/** One cell per day. Things are tags: the colour is the line, the outline says whether it is scheduled, from the calendar or from a file. */
export function MonthView({ anchor, today, items, deadlines, labels, onOpenDay }: {
  anchor: string; today: string; items: TimelineItem[]; deadlines: TimelineDeadline[]; labels: LineLabels; onOpenDay?: ((day: string) => void) | undefined;
}) {
  const grid = monthGrid(anchor);
  return <div className="mo" role="grid" aria-label="一个月">
    <div className="mo-head" role="row">{WEEKDAY.map((name) => <span key={name} role="columnheader">周{name}</span>)}</div>
    {grid.map((week, row) => <div className="mo-week" role="row" key={row}>
      {week.map(({ day, inMonth }) => {
        const flags = deadlines.filter((deadline) => deadline.day === day);
        const things = itemsOn(items, day);
        const shown = [...flags.map((flag) => ({ key: flag.id, text: `◆ ${flag.title}`, line: lineOf(flag.identityId), kind: "deadline", title: `截止：${flag.title}` })),
          ...things.map((item) => ({ key: item.id, text: `${item.start} ${item.title}`, line: lineOf(item.identityId), kind: item.kind,
            title: `${item.title} ${timeText(item)}${item.identityId ? ` · ${labels[item.identityId] ?? item.identityId}` : ""} · ${KIND_LABEL[item.kind]}` }))];
        return <div className="mo-cell" role="gridcell" key={day} data-out={!inMonth || undefined} data-today={day === today || undefined}>
          <button type="button" className="mo-date" onClick={() => onOpenDay?.(day)} aria-label={`打开 ${day}`}>{Number(day.slice(8))}</button>
          {shown.slice(0, MAX_CHIPS).map((chip) => <span key={chip.key} className="mo-chip" data-line={chip.line} data-kind={chip.kind} title={chip.title}>{chip.text}</span>)}
          {shown.length > MAX_CHIPS && <button type="button" className="mo-more" onClick={() => onOpenDay?.(day)}>+{shown.length - MAX_CHIPS}</button>}
        </div>;
      })}
    </div>)}
  </div>;
}
