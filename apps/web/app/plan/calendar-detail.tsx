"use client";

import FullCalendar from "@fullcalendar/react";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
import type { ScheduleBlockData } from "./plan-view";

export function CalendarDetail({ blocks, today, workOrderMilestones = {} }: {
  blocks: ScheduleBlockData[]; today: string; workOrderMilestones?: Record<string, string>;
}) {
  return <div className="calendar-detail">
    <FullCalendar
      plugins={[timeGridPlugin, dayGridPlugin, listPlugin, interactionPlugin]}
      initialView="timeGridWeek"
      // Day/week already existed as FullCalendar's own toolbar buttons — just easy to miss. Month
      // (dayGridMonth) and a Notion-style flat to-do list (listWeek) were genuinely absent.
      headerToolbar={{ left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek,dayGridMonth,listWeek" }}
      allDaySlot={false}
      nowIndicator
      height="auto"
      slotMinTime="07:00:00"
      slotMaxTime="23:00:00"
      events={blocks.map((block) => ({
        id: block.id,
        title: block.title,
        // Only a `scheduled:<workOrderId>` block traces back to one work order.
        extendedProps: { milestoneTitle: block.id.startsWith("scheduled:")
          ? workOrderMilestones[block.id.split(":")[1]!] : undefined },
        // Each block sits on its own day; an example block with no day follows the day being viewed.
        start: `${block.day ?? today}T${block.start}:00`,
        end: `${block.day ?? today}T${block.end}:00`,
        editable: !block.readOnly,
        // Lane and provenance are separate facts: an imported block is reality, a seeded one is an
        // example, and the week view has to keep saying so as plainly as the B lens does.
        classNames: [
          block.lane === "ai" ? "calendar-ai" : "calendar-human",
          block.id.startsWith("graph_calendar:") ? "calendar-real"
            : block.id.startsWith("scheduled:") ? "calendar-suggestion" : "calendar-example"
        ]
      }))}
      eventContent={(arg) => {
        const milestoneTitle = (arg.event.extendedProps as { milestoneTitle?: string }).milestoneTitle;
        return <div className="fc-event-body">
          <div className="fc-event-time">{arg.timeText}</div>
          <div className="fc-event-title">{arg.event.title}</div>
          {milestoneTitle && <div className="fc-event-milestone">→ {milestoneTitle}</div>}
        </div>;
      }}
    />
  </div>;
}
