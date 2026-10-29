"use client";

import { useEffect, useState } from "react";
import { AnalogClock, DigitalClock } from "../analog-clock";
import { useLocale, useT } from "../locale-context";
import { monthDay, weekdayShort } from "../../lib/i18n";
import { weekDays, weekdayOf } from "../timeline/model";
import { CALENDAR_ANCHOR, CALENDAR_DAY } from "./calendar-events";

/**
 * Today's head band (2026-10-28 redesign): the day's number large, the month and weekday beside it, the dial and the time in digits,
 * and the week as a strip — today filled, a dot under each day that has something on the calendar, the day the calendar shows outlined.
 * Pressing a day opens it on the calendar below.
 */
export function DayHead({ nowIso, timeZone, fixed, dateLabel, monthLabel, today, busyDays }: {
  nowIso: string; timeZone: string; fixed: boolean; dateLabel: string; monthLabel: string; today: string;
  /** Days of this week with anything on the calendar. */
  busyDays: string[];
}) {
  const t = useT();
  const locale = useLocale();
  const [shown, setShown] = useState(today);
  useEffect(() => {
    const onAnchor = (event: Event) => { const day = (event as CustomEvent<string>).detail; if (typeof day === "string") setShown(day); };
    window.addEventListener(CALENDAR_ANCHOR, onAnchor);
    return () => window.removeEventListener(CALENDAR_ANCHOR, onAnchor);
  }, []);
  const open = (day: string) => {
    window.dispatchEvent(new CustomEvent(CALENDAR_DAY, { detail: day }));
    document.getElementById("calendar")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const busy = new Set(busyDays);
  return <section className="td-head" aria-label={t("今天")}>
    <h1 className="td-date">
      <span className="td-day ds-serif">{dateLabel}</span>
      <span className="td-date-side"><span className="td-month ds-serif">{monthLabel}</span><span className="td-weekday">{weekdayShort(locale, weekdayOf(today))}</span></span>
    </h1>
    <div className="td-clock">
      <AnalogClock nowIso={nowIso} timeZone={timeZone} fixed={fixed} />
      <span className="td-clock-text"><DigitalClock className="td-time ds-serif" nowIso={nowIso} timeZone={timeZone} fixed={fixed} />
        <small>{timeZone}</small></span>
    </div>
    <nav className="td-week" aria-label={t("本周")}>
      {weekDays(today).map((day) => <button key={day} type="button" data-today={day === today || undefined} aria-pressed={day === shown}
        aria-label={t("在日历中打开 {{day}}", { day: `${monthDay(locale, day)} ${weekdayShort(locale, weekdayOf(day))}` })} onClick={() => open(day)}>
        <small>{weekdayShort(locale, weekdayOf(day))}</small>
        <b>{Number(day.slice(8, 10))}</b>
        <i data-busy={busy.has(day) || undefined} aria-hidden="true" />
      </button>)}
    </nav>
  </section>;
}
