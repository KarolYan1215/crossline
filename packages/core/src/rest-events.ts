import { calendarEventKey, type CalendarLines } from "./calendar-lines";

/**
 * Calendar events that are rest, not a commitment (walkthrough W-156, 2026-10-29): 「今晚 9 点以后不要再排工作了」 became a 21:00–23:59
 * 「休息」 event, and the day panel then read 「固定日程 7.5 小时」 — rest counted with the classes and meetings. Rest still keeps work
 * off those hours (it stays a busy block for the scheduler); it is only not counted as fixed schedule, and the evening wrap-up takes the
 * person's last working hour as ending where it begins.
 *
 * By the calendar classifier's `rest` mark (2026-11-22: the title word lists are gone — telling a lunch seminar or a dinner meeting from a
 * meal is the model's), and by free/busy where the calendar says it (`showAs: free`, iCal `TRANSPARENT`, which the iCal reader already
 * leaves out).
 */
export function isRestEvent(event: { title: string; showAs?: string | undefined }, filing: CalendarLines | null | undefined): boolean {
  if (event.showAs && /^(free|transparent)$/i.test(event.showAs)) return true;
  return filing?.entries[calendarEventKey(event.title)]?.rest === true;
}
