/**
 * Turning "when am I free" into the concrete slots the scheduler needs.
 *
 * `planSchedule` has never had a production caller, and the reason was this: nothing anywhere knew
 * when the person was available, so the AI lane on the plan was seed data wearing a scheduler's
 * clothes. A weekly pattern is what someone can actually state and keep true; concrete slots are what
 * the scheduler consumes; and the calendar is what has already taken the time away.
 */

/** One recurring band of time the person declared. `days` is 0–6 with Sunday at 0, as `Date` uses. */
export type AvailabilityWindow = {
  days: number[];
  /** Local wall clock, `HH:MM`. */
  start: string;
  end: string;
  energy: "low" | "medium" | "high";
};

export type BusyBlock = { day: string; start: string; end: string };

const minutes = (clock: string): number => {
  const [hour, minute] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
};
const clock = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

/**
 * The free slots left on `days` once the calendar has taken its share.
 *
 * ponytail: everything here is wall-clock arithmetic inside one declared time zone, so the ISO strings
 * are built by pinning the local time to `Z`. That is not the real instant, and it must not be shown
 * or stored as one — it is a common origin so that interval maths comes out right. Upgrade path: if
 * slots ever have to cross a DST boundary or two zones, convert properly here and nowhere else.
 */
export function availableSlots(
  windows: AvailabilityWindow[],
  days: string[],
  busy: BusyBlock[]
): Array<{ day: string; start: string; end: string; energy: "low" | "medium" | "high" }> {
  const slots: Array<{ day: string; start: string; end: string; energy: "low" | "medium" | "high" }> = [];
  for (const day of days) {
    // `T00:00` keeps this the day the caller named; a bare date string is parsed as UTC midnight and
    // can land on the day before in a negative-offset zone.
    const weekday = new Date(`${day}T00:00:00`).getDay();
    const taken = busy.filter((block) => block.day === day)
      .map((block) => ({ from: minutes(block.start), to: minutes(block.end) }))
      .sort((a, b) => a.from - b.from);

    for (const window of windows.filter((item) => item.days.includes(weekday))) {
      let cursor = minutes(window.start);
      const closes = minutes(window.end);
      for (const block of taken) {
        if (block.to <= cursor || block.from >= closes) continue;
        if (block.from > cursor) slots.push({ day, start: clock(cursor), end: clock(block.from), energy: window.energy });
        cursor = Math.max(cursor, block.to);
      }
      if (cursor < closes) slots.push({ day, start: clock(cursor), end: clock(closes), energy: window.energy });
    }
  }
  // A slot shorter than this is not time anyone starts work in; leaving them in only produced blocks
  // nobody could use and made the plan look busier than the day really is.
  return slots.filter((slot) => minutes(slot.end) - minutes(slot.start) >= 15)
    .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start));
}

/** The default a new database starts with: weekday mornings and afternoons, stated so it can be edited. */
export const DEFAULT_AVAILABILITY: AvailabilityWindow[] = [
  { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" },
  { days: [1, 2, 3, 4, 5], start: "14:00", end: "18:00", energy: "medium" },
  { days: [0, 6], start: "10:00", end: "12:00", energy: "low" }
];

/** Rejects a window that cannot mean anything, so a typo cannot silently empty the plan. */
export function validateAvailability(value: unknown): AvailabilityWindow[] {
  if (!Array.isArray(value)) throw new Error("AVAILABILITY_INVALID");
  return value.map((entry) => {
    const window = entry as AvailabilityWindow;
    const shaped = Array.isArray(window?.days) && window.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      && /^\d{2}:\d{2}$/.test(window?.start ?? "") && /^\d{2}:\d{2}$/.test(window?.end ?? "")
      && ["low", "medium", "high"].includes(window?.energy);
    if (!shaped) throw new Error("AVAILABILITY_INVALID");
    if (minutes(window.end) <= minutes(window.start)) throw new Error("AVAILABILITY_ENDS_BEFORE_IT_STARTS");
    return { days: [...window.days], start: window.start, end: window.end, energy: window.energy };
  });
}

/**
 * A proposed weekly pattern, read off when the person was actually at the machine over the last weeks.
 *
 * It is a suggestion to be edited, never a setting: it only knows when someone was active, not how good their energy was,
 * so every window comes back as `medium` and says nothing about it. A half hour counts as "usually active" on a weekday
 * when, on at least half of that weekday's observed days, at least ten of its minutes had input. Runs of such half hours
 * become windows when they last an hour or more; weekdays with the same window share one entry. Too little data (under
 * seven distinct days observed) returns nothing rather than a pattern built from a week's accident.
 */
export function suggestAvailability(input: {
  segments: Array<{ start: string; end: string; idle: boolean }>;
  timeZone: string;
}): AvailabilityWindow[] {
  const zone = new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Active minutes per (local day, half hour slot), counted minute by minute so a long segment spreads over the slots it covers.
  const perDay = new Map<string, { weekday: number; slots: Map<number, number> }>();
  for (const segment of input.segments) {
    if (segment.idle) continue;
    for (let at = Date.parse(segment.start); at < Date.parse(segment.end); at += 60_000) {
      const parts = Object.fromEntries(zone.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      const slot = Math.floor((Number(parts.hour) * 60 + Number(parts.minute)) / 30);
      const entry = perDay.get(day) ?? { weekday: WEEKDAYS[parts.weekday!] ?? 0, slots: new Map<number, number>() };
      entry.slots.set(slot, (entry.slots.get(slot) ?? 0) + 1);
      perDay.set(day, entry);
    }
  }
  if (perDay.size < 7) return [];

  const windows = new Map<string, AvailabilityWindow>();
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const days = [...perDay.values()].filter((entry) => entry.weekday === weekday);
    // A weekday seen once says nothing about a habit.
    if (days.length < 2) continue;
    const usual = Array.from({ length: 48 }, (_, slot) => days.filter((entry) => (entry.slots.get(slot) ?? 0) >= 10).length * 2 >= days.length);
    for (let slot = 0; slot < 48;) {
      if (!usual[slot]) { slot += 1; continue; }
      let end = slot;
      while (end < 48 && usual[end]) end += 1;
      if ((end - slot) * 30 >= 60) {
        const start = clock(slot * 30), stop = clock(Math.min(end * 30, 1439));
        const key = `${start}-${stop}`;
        const existing = windows.get(key);
        if (existing) existing.days.push(weekday); else windows.set(key, { days: [weekday], start, end: stop, energy: "medium" });
      }
      slot = end;
    }
  }
  return [...windows.values()].sort((a, b) => a.start.localeCompare(b.start));
}
