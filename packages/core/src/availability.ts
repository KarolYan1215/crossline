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
