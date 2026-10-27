import { monthDay, tFor, weekdayShort, type Locale } from "./i18n";

/**
 * Fixed events: the person's own commitments with a time — a class every Monday and Friday, an exam on one day, a meeting they told the
 * input box about (decided 2026-10-08). Two kinds, kept apart because a calendar treats them differently: a **recurring** event is one
 * series (weekdays, a first and a last day, skipped days), a **one-off** is one day. Either kind is busy time the scheduler plans around,
 * and — when the person agrees — an event on their Crossline calendar: a recurring one as a single repeating series, never a pile of
 * copies.
 */
export const FIXED_EVENTS = "schedule.events";
/** The person's answer per proposed event (`create` | `exists` | `skip`), keyed by `FixedEvent.id`. */
export const EVENT_DECISIONS = "schedule.events.decisions";

export type FixedEvent = {
  id: string;
  title: string;
  lineId: string;
  /** Recurring: weekdays (0 = Sunday), first and last day, days skipped. Null for a one-off. */
  repeat: { weekdays: number[]; from: string; until: string; exceptions: string[] } | null;
  /** A one-off's day (a recurring event's first day is `repeat.from`). */
  date: string;
  start: string; end: string;
  location: string;
  /** Where it came from: typed into the input box, said in the interview, read from a file, or heard in a recording. */
  source: "input" | "interview" | "file" | "recording";
};

const md = (day: string, locale?: Locale) => locale === "en" ? monthDay(locale, day) : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** How long an appointment heard in a recording is taken to last when nothing says. */
export const HEARD_EVENT_MINUTES = 60;
const HEARD_SLOT = "date_heard_";

/**
 * A day heard in a recording (the digest's `date_heard_*` fact, value 「2026-10-28 15:00 组会」) as a one-off event to offer the person
 * (docs/phone-recording.md). Only one that names a time: a day alone is a fact to confirm, not an appointment. The fact is never
 * changed by the answer.
 */
export function heardEventFromFact(fact: { slot: string; value: string; identityId: string; sourceRef: string }): FixedEvent | undefined {
  if (!fact.slot.startsWith(HEARD_SLOT)) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+)$/.exec(fact.value.trim());
  if (!match || !DAY.test(match[1]!) || !TIME.test(match[2]!)) return undefined;
  const [hours, minutes] = match[2]!.split(":").map(Number) as [number, number];
  const endMinutes = Math.min(hours * 60 + minutes + HEARD_EVENT_MINUTES, 23 * 60 + 59);
  const end = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;
  const recording = fact.sourceRef.replace(/^recording:/, "");
  return { id: `heard:${recording}:${fact.slot.slice(HEARD_SLOT.length)}`, title: match[3]!.trim(), lineId: fact.identityId === "person" ? "" : fact.identityId,
    repeat: null, date: match[1]!, start: match[2]!, end, location: "", source: "recording" };
}

/** The days among `days` on which the event happens. */
export function occurrences(event: FixedEvent, days: string[]): string[] {
  if (!event.repeat) return days.includes(event.date) ? [event.date] : [];
  const { weekdays, from, until, exceptions } = event.repeat;
  return days.filter((day) => day >= from && day <= until && !exceptions.includes(day) && weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay()));
}

/** 「每周一、五 14:30–15:45（9/4–12/7）」 or 「10/27 周二 14:30–15:45」; in English "Every Mon, Fri 14:30–15:45 (Sep 4–Dec 7)", "Tue Oct 27 14:30–15:45". */
export function describeEvent(event: FixedEvent, locale?: Locale): string {
  const t = tFor(locale);
  const time = `${event.start}–${event.end}`;
  if (!event.repeat) {
    const date = md(event.date, locale), weekday = weekdayShort(locale, weekdayOf(event.date));
    return locale === "en" ? `${weekday} ${date} ${time}` : `${date} ${weekday} ${time}`;
  }
  const sorted = [...event.repeat.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const days = locale === "en" ? sorted.map((day) => weekdayShort(locale, day)).join(", ") : sorted.map((day) => weekdayShort(locale, day).slice(1)).join("、");
  return t("每周{{days}} {{time}}（{{from}}–{{until}}）", { days, time, from: md(event.repeat.from, locale), until: md(event.repeat.until, locale) });
}

/** An event that is whole: a title, times in order, and either a valid day or a valid series. */
export function validFixedEvent(event: FixedEvent): boolean {
  if (!event.title.trim() || !TIME.test(event.start) || !TIME.test(event.end) || event.end <= event.start) return false;
  if (!event.repeat) return DAY.test(event.date);
  return event.repeat.weekdays.length > 0 && event.repeat.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && DAY.test(event.repeat.from) && DAY.test(event.repeat.until) && event.repeat.from <= event.repeat.until;
}

const squash = (text: string) => text.replace(/[\s·:：,，。（）()\-_]+/g, "").toLowerCase();
const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
/** Two titles name the same thing: one contains the other, or they share a course code or four characters in a row. */
function sameTitle(a: string, b: string): boolean {
  const x = squash(a), y = squash(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const code = /[a-z]{2,5}\d{3,4}/;
  const cx = x.match(code)?.[0], cy = y.match(code)?.[0];
  if (cx && cx === cy) return true;
  for (let i = 0; i + 4 <= x.length; i += 1) if (y.includes(x.slice(i, i + 4))) return true;
  return false;
}

/**
 * Whether the person's own calendar already has this event: some occurrence in `days` meets a calendar block that starts within fifteen
 * minutes of it and names the same thing. A calendar that already holds a class is not offered a second copy of it.
 */
export function inCalendar(event: FixedEvent, calendar: Array<{ title: string; day: string; start: string; end: string }>, days: string[]): boolean {
  return occurrences(event, days).some((day) => calendar.some((block) => block.day === day
    && Math.abs(minutes(block.start) - minutes(event.start)) <= 15 && sameTitle(block.title, event.title)));
}

const GRAPH_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
/** The weekly pattern as Microsoft Graph names it. */
export const graphWeekdays = (weekdays: number[]) => weekdays.map((day) => GRAPH_DAYS[day]!);

/** The events' occurrences on these days, as busy plan blocks (`event:<id>:<day>`). */
export function fixedEventBlocks(events: FixedEvent[], days: string[], locale?: Locale) {
  const t = tFor(locale);
  return events.filter(validFixedEvent).flatMap((event) => occurrences(event, days).map((day) => ({ id: `event:${event.id}:${day}`, lane: "human" as const,
    title: event.title, day, start: event.start, end: event.end, source: event.repeat ? t("日程·每周") : t("日程", { context: "source" }), readOnly: true,
    ...(event.location ? { location: event.location } : {}) })));
}
