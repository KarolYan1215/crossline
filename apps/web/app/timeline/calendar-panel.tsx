"use client";

import { useEffect, useState } from "react";
import { minuteInZone, monthOf, shiftDay, shiftMonth, weekDays, weekdayOf, type TimelineDeadline, type TimelineItem } from "./model";
import { DayTimeline, MonthView, WeekView, type LineLabels } from "./views";
import { ImpactCard, useImpact } from "../task/impact";
import { DayQuickActions, type QuickProposal } from "./quick-actions";
import { useReturnState } from "../ui/return-state";
import type { TaskDetail } from "../../lib/task-detail";

export type CalendarView = "day" | "week" | "month";
const VIEWS: Array<[CalendarView, string]> = [["day", "日"], ["week", "周"], ["month", "月"]];

/**
 * Day, week and month over one list of items. The three views are the same data at three scales, with one selection: pick a block
 * and the panel beside the day shows its task and what can be done with it (a pick in the week opens that day).
 */
export function CalendarPanel({ items, deadlines, today, nowIso, timeZone, labels, quietByWeekday, proposals, initialView = "day", taskDetails }: {
  items: TimelineItem[]; deadlines: TimelineDeadline[]; today: string; nowIso: string; timeZone: string; labels: LineLabels;
  /** Unavailable stretches by weekday (0 is Sunday), from the person's availability. */
  quietByWeekday?: Record<number, Array<[string, string]>>; initialView?: CalendarView;
  /** Waiting proposals, for the day view's quick actions. */
  proposals?: QuickProposal[] | undefined;
  /** Details of the tasks behind the blocks, read with the page (Today); a task not here is read when its block is picked. */
  taskDetails?: Record<string, TaskDetail> | undefined;
}) {
  const [view, setView] = useState<CalendarView>(initialView);
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState<TimelineItem | undefined>();
  const impact = useImpact();
  const nowMinute = minuteInZone(nowIso, timeZone);
  // Back from a task's page, the calendar opens on the view, day and block it was left on.
  useReturnState("calendar", { view, anchor, picked: selected?.id }, (saved) => {
    if (saved.view) setView(saved.view);
    if (saved.anchor) setAnchor(saved.anchor);
    const picked = saved.picked ? items.find((item) => item.id === saved.picked) : undefined;
    if (picked) setSelected(picked);
  });

  // The week opens at the start of the working day rather than at midnight.
  useEffect(() => {
    const body = document.querySelector<HTMLElement>("[data-scroll-to-morning]");
    if (view === "week" && body) body.scrollTop = 7 * 44;
  }, [view, anchor]);

  const step = (direction: -1 | 1) => setAnchor((current) =>
    view === "day" ? shiftDay(current, direction) : view === "week" ? shiftDay(current, direction * 7) : shiftMonth(current, direction));
  const openDay = (day: string) => { setAnchor(day); setView("day"); setSelected(undefined); };
  // A pick shows in the panel beside the day. Where that panel sits under the timeline (a phone), it is brought into view.
  const pick = (item: TimelineItem) => {
    setSelected(item);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 820px)").matches)
      requestAnimationFrame(() => document.querySelector(".dv-aside")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  // The week has no panel of its own: picking a block there opens its day with the block picked.
  const pickInWeek = (item: TimelineItem) => { setAnchor(item.day); setView("day"); pick(item); };
  const title = view === "day" ? `${anchor}（周${"日一二三四五六"[weekdayOf(anchor)]}）`
    : view === "week" ? `${weekDays(anchor)[0]} 至 ${weekDays(anchor)[6]}` : `${monthOf(anchor).replace("-", " 年 ")} 月`;

  return <section className="cal" aria-label="日历">
    <header className="cal-head">
      <div className="cal-tabs" role="tablist" aria-label="日历视图">
        {VIEWS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => { setView(id); setSelected(undefined); }}>{label}</button>)}
      </div>
      <div className="cal-nav">
        <button type="button" onClick={() => step(-1)} aria-label="上一个">←</button>
        <button type="button" onClick={() => setAnchor(today)} disabled={anchor === today}>今天</button>
        <button type="button" onClick={() => step(1)} aria-label="下一个">→</button>
        <b>{title}</b>
      </div>
      <div className="cal-legend" aria-label="图例">
        {Object.entries(labels).map(([id, label]) => <span key={id} data-line={id}>{label}</span>)}
      </div>
    </header>
    {view === "day" && <DayTimeline day={anchor} items={items} deadlines={deadlines} labels={labels} selectedId={selected?.id} onSelect={pick}
      nowMinute={anchor === today ? nowMinute : undefined} quiet={quietByWeekday?.[weekdayOf(anchor)]}
      aside={<DayQuickActions day={anchor} today={today} items={items} proposals={proposals ?? []} nowMinute={anchor === today ? nowMinute : undefined}
        selected={selected} onDeselect={() => setSelected(undefined)} labels={labels} details={taskDetails} />}
      onResize={(item, deltaMinutes) => {
        // `scheduled:<task>[:<step>][:<n>]` — a step id is `v<version>s<n>`, which tells it from a block index.
        const [, workOrderId, segment] = item.id.split(":");
        if (!workOrderId) return;
        void impact.propose({ kind: "estimate_delta", workOrderId, deltaMinutes, ...(segment && /^v\d+s\d+$/.test(segment) ? { stepId: segment } : {}) });
      }} />}
    {impact.pending && <ImpactCard impact={impact.pending.impact} busy={impact.busy} onApply={() => void impact.apply()} onCancel={impact.cancel} />}
    {impact.error && <small role="status">{impact.error}</small>}
    {view === "week" && <WeekView anchor={anchor} today={today} items={items} deadlines={deadlines} labels={labels} selectedId={selected?.id} onSelect={pickInWeek} onOpenDay={openDay} />}
    {view === "month" && <MonthView anchor={anchor} today={today} items={items} deadlines={deadlines} labels={labels} onOpenDay={openDay} />}
  </section>;
}
