"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  MINUTES_PER_DAY, dayRange, itemsOn, layoutDay, monthGrid, overlapStates, packColumns, toMinutes, weekDays,
  type TimelineDeadline, type TimelineItem
} from "./model";
import { useLocale, useT } from "../locale-context";
import { weekdayShort } from "../../lib/i18n";
import "./day-panel.css";

export type LineLabels = Record<string, string>;
/** Monday first: 0 (Sunday) to 6 for each column. */
const WEEKDAY = [1, 2, 3, 4, 5, 6, 0];
/** Kept in Chinese (it is the key); translated where shown. */
const KIND_LABEL: Record<TimelineItem["kind"], string> = { calendar: "日历", scheduled: "排程", proposed: "预览", optional: "预排", import: "文件", activity: "实际" };

const lineOf = (identityId?: string) => identityId ?? "none";
const WORK = new Set<TimelineItem["kind"]>(["scheduled", "optional", "proposed"]);
const timeText = (item: { start: string; end: string }) => `${item.start}–${item.end}`;
/** Kept in Chinese (it is the key); translated where shown. */
const OVERLAP_TEXT = { clash: "时间冲突", allowed: "已允许重叠" } as const;

const DAY_HOUR_PX = 72;
const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The day, read top to bottom: an hour axis down the left, every block as wide as the day allows and as tall as it is long, so the task's
 * title reads in full and the step sits under it. Blocks that share time sit side by side. A scheduled block's bottom edge is dragged to
 * change its duration; `aside` is the column beside it (the quick actions), which used to restate each block's title.
 */
export function DayTimeline({ day, items, deadlines, nowMinute, labels, quiet, selectedId, onSelect, onResize, aside }: {
  day: string; items: TimelineItem[]; deadlines: TimelineDeadline[]; nowMinute: number | undefined; labels: LineLabels;
  /** Stretches of the day that are not available (sleep, meals), drawn pale. */
  quiet?: Array<[string, string]> | undefined; selectedId?: string | undefined; onSelect?: ((item: TimelineItem) => void) | undefined;
  /** A scheduled block's bottom edge dragged: how many minutes longer (or shorter, negative) it should be. */
  onResize?: ((item: TimelineItem, deltaMinutes: number) => void) | undefined;
  aside?: ReactNode;
}) {
  const t = useT();
  const [resizing, setResizing] = useState<{ id: string; end: string } | null>(null);
  /** The 「+N 项」 run whose list is open, by its first item's id. */
  const [openRun, setOpenRun] = useState<string | null>(null);
  const gridRef = useRef<{ top: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = itemsOn(items, day);
  const overlapState = overlapStates(rows);
  const flags = deadlines.filter((deadline) => deadline.day === day);
  const range = dayRange(rows);
  const height = ((range.to - range.from) / 60) * DAY_HOUR_PX;
  const y = (minutes: number) => ((minutes - range.from) / 60) * DAY_HOUR_PX;
  const hours = Array.from({ length: (range.to - range.from) / 60 + 1 }, (_, index) => range.from / 60 + index);
  // Opens at the first block (or the current hour today) rather than at the top of the range.
  useEffect(() => {
    const first = nowMinute ?? (rows[0] ? toMinutes(rows[0].start) : range.from);
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, y(first) - DAY_HOUR_PX);
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="dv" data-has-aside={aside ? true : undefined}>
    {aside && <aside className="dv-aside" aria-label={t("快捷操作")}>{aside}</aside>}
    <div className="dv-main" role="group" aria-label={t("{{day}} 的时间轴", { day })}>
      {flags.length > 0 && <div className="dv-flags">{flags.map((flag) => <span key={flag.id} className="dv-flag" data-line={lineOf(flag.identityId)}
        title={flag.detail ? `${flag.title} · ${flag.detail}` : flag.title}>◆ {flag.title}<small>{flag.detail ?? t("截止")}</small></span>)}</div>}
      <div className="dv-scroll" ref={scrollRef}>
        <div className="dv-grid" style={{ height }}>
          {quiet?.map(([from, to], index) => {
            const top = Math.max(0, y(toMinutes(from))), bottom = Math.min(height, y(toMinutes(to) || MINUTES_PER_DAY));
            return bottom > top ? <u key={index} className="dv-quiet" style={{ top, height: bottom - top }} aria-hidden="true" /> : null;
          })}
          {hours.map((hour) => <i key={hour} className="dv-hour" style={{ top: y(hour * 60) }} aria-hidden="true"><span>{String(hour % 24).padStart(2, "0")}:00</span></i>)}
          <div className="dv-lane">
            {layoutDay(rows.map((item) => resizing?.id === item.id ? { ...item, end: resizing.end } : item), range.from, DAY_HOUR_PX).map((piece) => {
              const slot = { left: `${(piece.column / piece.columns) * 100}%`, width: `calc(${100 / piece.columns}% - 4px)` };
              if (piece.kind === "more") {
                const key = piece.items[0]!.id;
                return <div key={`more:${key}`} className="dv-more" data-open={openRun === key || undefined} style={{ top: piece.top, ...slot }}>
                  <button type="button" className="dv-more-label" aria-expanded={openRun === key}
                    onClick={() => setOpenRun(openRun === key ? null : key)}>{t("+{{n}} 项", { n: piece.items.length })}</button>
                  <ul className="dv-more-list" aria-label={t("{{start}} 起的 {{count}} 项", { start: piece.items[0]!.start, count: piece.items.length })}>
                    {piece.items.map((item) => <li key={item.id}><button type="button" data-line={lineOf(item.identityId)} aria-pressed={selectedId === item.id}
                      onClick={() => { setOpenRun(null); onSelect?.(item); }}><span className="mono">{timeText(item)}</span> {item.title}{item.step ? ` · ${item.step}` : ""}</button></li>)}
                  </ul>
                </div>;
              }
              // `piece.item` carries the end being dragged; `item` is the block as stored, which the resize handle measures from.
              const item = rows.find((row) => row.id === piece.item.id) ?? piece.item, end = piece.item.end;
              const state = overlapState.get(item.id);
              const title = `${item.title}${item.step ? ` · ${item.step}` : ""} ${timeText(item)}${item.identityId ? ` · ${labels[item.identityId] ?? item.identityId}` : ""}${state ? ` · ${t(OVERLAP_TEXT[state])}` : ""}`;
              const common = {
                "data-line": lineOf(item.identityId), "data-kind": item.kind, "data-missed": item.missed || undefined, "data-agent": item.agent, "data-work-order": item.workOrderId,
                "data-clash": state === "clash" || undefined, "data-overlap-ok": state === "allowed" || undefined, "aria-pressed": selectedId === item.id,
                title, onClick: () => onSelect?.(item)
              };
              // Too short for a line of text: a bare colour bar at its true time; what it is shows on hover, in the 「+N 项」 list and beside the day.
              if (piece.kind === "bar") return <button type="button" key={item.id} className="dv-bar" {...common} aria-label={title}
                style={{ top: piece.top, height: piece.height, ...slot }} />;
              const resizable = Boolean(onResize && item.kind === "scheduled" && !item.missed);
              const minutes = toMinutes(end) - toMinutes(item.start);
              return <button type="button" key={item.id} className="dv-block" {...common}
                data-short={piece.height - piece.textTop < 40 || undefined} data-tight={piece.height - piece.textTop < 24 || undefined}
                style={{ top: piece.top, height: piece.height, ...slot, ...(piece.textTop ? { paddingTop: piece.textTop + 1 } : {}) }}>
                <span className="dv-block-head"><b>{item.title}</b>{item.tag && <em className="dv-tag">{t(item.tag)}</em>}
                  {item.agent && <em className="dv-tag" data-agent={item.agent}>{item.agent === "running" ? t("Agent 执行中") : t("Agent 将执行")}</em>}
                  {state && WORK.has(item.kind) && <em className="dv-tag" data-overlap={state}>{t(OVERLAP_TEXT[state])}</em>}</span>
                <small>{item.step ? `${item.step} · ` : ""}<span className="mono">{timeText({ start: item.start, end })}</span>{minutes >= 60 ? ` · ${t("{{n}} 小时", { n: Math.round(minutes / 6) / 10 })}` : ` · ${t("{{n}} 分", { n: minutes })}`}</small>
                {resizable && <i className="dv-resize" aria-hidden="true" title={t("拖动调整时长")}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    const grid = (event.currentTarget.closest(".dv-grid") as HTMLElement).getBoundingClientRect();
                    gridRef.current = { top: grid.top };
                    setResizing({ id: item.id, end: item.end });
                  }}
                  onPointerMove={(event) => {
                    if (resizing?.id !== item.id || !gridRef.current) return;
                    const minute = range.from + Math.round((((event.clientY - gridRef.current.top) / DAY_HOUR_PX) * 60) / 5) * 5;
                    const next = Math.max(toMinutes(item.start) + 15, Math.min(range.to, minute));
                    setResizing({ id: item.id, end: clockOf(next) });
                  }}
                  onPointerUp={(event) => {
                    event.stopPropagation();
                    if (resizing?.id === item.id) { const delta = toMinutes(resizing.end) - toMinutes(item.end); if (delta) onResize?.(item, delta); }
                    setResizing(null);
                  }} />}
                {resizing?.id === item.id && <b className="dv-resize-live mono">{t("{{n}} 分钟", { n: minutes })}</b>}
              </button>;
            })}
          </div>
          {rows.length === 0 && <p className="dv-empty">{t("当日无安排。灰色为不可用时段，其余时段可排任务。")}</p>}
          {nowMinute !== undefined && nowMinute >= range.from && nowMinute <= range.to &&
            <span className="dv-now" style={{ top: y(nowMinute) }}><i>{t("现在")}</i></span>}
        </div>
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
  const t = useT();
  const locale = useLocale();
  const days = weekDays(anchor);
  return <div className="wk" role="group" aria-label={t("一周")}>
    <div className="wk-scroll">
      <div className="wk-head">
        <span className="wk-gutter" />
        {days.map((day, index) => <div key={day} className="wk-day" data-today={day === today || undefined}>
          <button type="button" onClick={() => onOpenDay?.(day)}>{weekdayShort(locale, WEEKDAY[index]!)} <b>{Number(day.slice(8))}</b></button>
          {deadlines.filter((deadline) => deadline.day === day).map((deadline) => <span key={deadline.id} className="wk-flag" data-line={lineOf(deadline.identityId)} title={deadline.detail ? `${deadline.title} · ${deadline.detail}` : deadline.title}>◆ {deadline.title}</span>)}
        </div>)}
      </div>
      <div className="wk-body" data-scroll-to-morning style={{ "--hour": `${HOUR_PX}px` } as CSSProperties}>
        <div className="wk-gutter">{Array.from({ length: 24 }, (_, hour) => <i key={hour} style={{ top: hour * HOUR_PX }}>{String(hour).padStart(2, "0")}</i>)}</div>
        {days.map((day) => {
          const ofDay = itemsOn(items, day);
          const packed = packColumns(ofDay);
          const overlapState = overlapStates(ofDay);
          return <div className="wk-col" key={day} data-today={day === today || undefined}>
            {packed.map(({ item, column, columns }) => {
              const top = (toMinutes(item.start) / 60) * HOUR_PX;
              const height = Math.max(((toMinutes(item.end) - toMinutes(item.start)) / 60) * HOUR_PX, 14);
              return <button type="button" key={item.id} className="wk-block" data-line={lineOf(item.identityId)} data-kind={item.kind} data-missed={item.missed || undefined} data-work-order={item.workOrderId} aria-pressed={selectedId === item.id}
                data-clash={overlapState.get(item.id) === "clash" || undefined} data-overlap-ok={overlapState.get(item.id) === "allowed" || undefined}
                style={{ top, height, left: `${(column / columns) * 100}%`, width: `${100 / columns}%` }} onClick={() => onSelect?.(item)}
                title={`${item.title} ${timeText(item)}${item.identityId ? ` · ${labels[item.identityId] ?? item.identityId}` : ""}${overlapState.get(item.id) ? ` · ${t(OVERLAP_TEXT[overlapState.get(item.id)!])}` : ""}`}>
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
  const t = useT();
  const locale = useLocale();
  const grid = monthGrid(anchor);
  return <div className="mo" role="grid" aria-label={t("一个月")}>
    <div className="mo-head" role="row">{WEEKDAY.map((weekday) => <span key={weekday} role="columnheader">{weekdayShort(locale, weekday)}</span>)}</div>
    {grid.map((week, row) => <div className="mo-week" role="row" key={row}>
      {week.map(({ day, inMonth }) => {
        const flags = deadlines.filter((deadline) => deadline.day === day);
        const things = itemsOn(items, day);
        const shown = [...flags.map((flag) => ({ key: flag.id, text: `◆ ${flag.title}`, line: lineOf(flag.identityId), kind: "deadline", title: flag.detail ? `${flag.title} · ${flag.detail}` : flag.title })),
          ...things.map((item) => ({ key: item.id, text: `${item.start} ${item.title}`, line: lineOf(item.identityId), kind: item.kind,
            title: `${item.title} ${timeText(item)}${item.identityId ? ` · ${labels[item.identityId] ?? item.identityId}` : ""} · ${t(KIND_LABEL[item.kind])}` }))];
        return <div className="mo-cell" role="gridcell" key={day} data-out={!inMonth || undefined} data-today={day === today || undefined}>
          <button type="button" className="mo-date" onClick={() => onOpenDay?.(day)} aria-label={t("打开 {{day}}", { day })}>{Number(day.slice(8))}</button>
          {shown.slice(0, MAX_CHIPS).map((chip) => <span key={chip.key} className="mo-chip" data-line={chip.line} data-kind={chip.kind} title={chip.title}>{chip.text}</span>)}
          {shown.length > MAX_CHIPS && <button type="button" className="mo-more" onClick={() => onOpenDay?.(day)}>+{shown.length - MAX_CHIPS}</button>}
        </div>;
      })}
    </div>)}
  </div>;
}
