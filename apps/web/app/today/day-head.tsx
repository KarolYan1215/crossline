"use client";

import { useEffect, useState } from "react";
import { AnalogClock, DigitalClock } from "../analog-clock";
import { useLocale, useT } from "../locale-context";
import { monthDay, weekdayShort } from "../../lib/i18n";
import { weekdayOf } from "../timeline/model";
import { CALENDAR_ANCHOR, CALENDAR_DAY } from "./calendar-events";
import type { WeekDayLoad } from "./week-load";
import { Flag } from "lucide-react";
import { hoursLabel } from "../timeline/panel-model";

/**
 * Today's head band (2026-10-28 redesign): the day's number large, the month and weekday beside it, the dial and the time in digits,
 * and the week as a strip — today filled, the day the calendar shows outlined, and under each day a thin bar of how full its work is
 * and a flag on a day something is due (2026-10-29, scenarios.md §4.11). Pressing a day opens it on the calendar below.
 */
export function DayHead({ nowIso, timeZone, fixed, dateLabel, monthLabel, today, week }: {
  nowIso: string; timeZone: string; fixed: boolean; dateLabel: string; monthLabel: string; today: string;
  /** Each day of this week: how full its work is and whether something is due on it (`weekLoad`). */
  week: WeekDayLoad[];
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
      {week.map(({ day, work, load, deadline }) => <button key={day} type="button" data-today={day === today || undefined} aria-pressed={day === shown}
        aria-label={t("在日历中打开 {{day}}", { day: `${monthDay(locale, day)} ${weekdayShort(locale, weekdayOf(day))}` })}
        title={[work ? t("已排 {{hours}}", { hours: hoursLabel(work, locale) }) : "", deadline ? t("有截止") : ""].filter(Boolean).join(" · ") || undefined}
        onClick={() => open(day)}>
        <small>{weekdayShort(locale, weekdayOf(day))}</small>
        <b>{Number(day.slice(8, 10))}</b>
        <i className="td-load" aria-hidden="true"><i style={{ width: `${Math.round(load * 100)}%` }} data-full={load >= 0.9 || undefined} /></i>
        <span className="td-due" aria-hidden="true">{deadline && <Flag size={12} strokeWidth={1.6} />}</span>
      </button>)}
    </nav>
  </section>;
}
