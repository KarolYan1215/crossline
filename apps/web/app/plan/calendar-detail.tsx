"use client";

import FullCalendar from "@fullcalendar/react";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { ScheduleBlockData } from "./plan-view";

export function CalendarDetail({ blocks, today }: { blocks: ScheduleBlockData[]; today: string }) {
  return <div className="calendar-detail">
    <FullCalendar
      plugins={[timeGridPlugin, interactionPlugin]}
      initialView="timeGridWeek"
      headerToolbar={{ left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek" }}
      allDaySlot={false}
      nowIndicator
      height="auto"
      slotMinTime="07:00:00"
      slotMaxTime="23:00:00"
      events={blocks.map((block) => ({
        id: block.id,
        title: block.title,
        // Each block sits on its own day; an example block with no day follows the day being viewed.
        start: `${block.day ?? today}T${block.start}:00`,
        end: `${block.day ?? today}T${block.end}:00`,
        editable: !block.readOnly,
        // Lane and provenance are separate facts: an imported block is reality, a seeded one is an
        // example, and the week view has to keep saying so as plainly as the B lens does.
        classNames: [
          block.lane === "ai" ? "calendar-ai" : "calendar-human",
          block.id.startsWith("graph_calendar:") ? "calendar-real" : "calendar-example"
        ]
      }))}
    />
  </div>;
}
