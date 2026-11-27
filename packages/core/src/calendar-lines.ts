
/**
 * Which line a calendar event belongs to (decided 2026-10-08: the person does not sort their synced calendar by hand — the model reads it
 * and files each event). Events are filed by their title, normalised, because a recurring class or meeting repeats one title, and one
 * answer then covers every occurrence. An event that belongs to no line (a dentist appointment, a birthday) is filed under "" and stays
 * uncoloured. The answers live in the `CALENDAR_LINES` setting, so a backup carries them.
 */
export const CALENDAR_LINES = "calendar.lines";

/**
 * `unclear`: nothing on record tells which line the event serves (as opposed to an event that plainly serves none, such as a dentist
 * appointment); the person is asked (`calendar_line_unclear` on 待确认), and their answer replaces it with `by: "person"`.
 */
export type CalendarLineEntry = { lineId: string; why: string; at: string; unclear?: boolean; by?: "model" | "person";
  /**
   * The classifier's marks (2026-11-22, replacing the title word lists): `rest` — rest, a meal, sleep or 「不排工作」, not a commitment
   * (it still keeps work off its hours); `cancelled` — a meeting its organiser cancelled (「Canceled: …」), no commitment at all. Absent
   * on entries filed before them: such an entry is read once more for the marks (`needsMarks`), its line kept.
   */
  rest?: boolean; cancelled?: boolean };
/** The stored filing: entries by event key, and the lines they were filed against (a renamed or new line refiles everything). */
export type CalendarLines = { basis: string; entries: Record<string, CalendarLineEntry> };

/** One title for every occurrence: whitespace collapsed, case folded. */
export const calendarEventKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);

/** What the filing was made against: the lines' ids and names. When it changes, earlier answers are no longer trusted. */
export const calendarLinesBasis = (lines: Array<{ id: string; label: string }>) => lines.map((line) => `${line.id}=${line.label}`).sort().join("|");

/** The classifier's answer (Skill `crossline-line-filer:calendar`). */
export type CalendarClassification = { items: Array<{ key: string; lineId: string; why: string; unclear: boolean; rest: boolean; cancelled: boolean }> };
export const CALENDAR_CLASSIFICATION_SCHEMA = { type: "object", additionalProperties: false, required: ["items"], properties: {
  items: { type: "array", maxItems: 60, items: { type: "object", additionalProperties: false, required: ["key", "lineId", "why", "unclear", "rest", "cancelled"], properties: {
    key: { type: "string", minLength: 1, maxLength: 200 }, lineId: { type: "string", maxLength: 80 }, why: { type: "string", maxLength: 200 },
    unclear: { type: "boolean" }, rest: { type: "boolean" }, cancelled: { type: "boolean" } } } } } } as const;

/**
 * Keeps an answer for each event it was asked about: a line that exists, or "" for none. An unknown key is dropped; a line id that does
 * not exist is filed as "" rather than refused — an uncoloured event is harmless, a wrong colour is not.
 */
export function validateCalendarClassification(value: unknown, keys: string[], lineIds: string[]): CalendarClassification {
  const answer = value as CalendarClassification | undefined;
  if (!answer || !Array.isArray(answer.items)) throw new Error("CALENDAR_CLASSIFICATION_INVALID");
  const asked = new Set(keys), lines = new Set(lineIds), seen = new Set<string>();
  const items = answer.items.filter((item) => item && asked.has(item.key) && !seen.has(item.key) && Boolean(seen.add(item.key)))
    .map((item) => { const known = lines.has(item.lineId);
      // A line that does not exist is not a decision: the event is asked about rather than silently left uncoloured.
      return { key: item.key, lineId: known ? item.lineId : "", why: String(item.why ?? "").trim().slice(0, 200), unclear: !known && (item.unclear === true || Boolean(item.lineId)),
        rest: item.rest === true, cancelled: item.cancelled === true }; });
  return { items };
}

/** An entry filed before the classifier marked rest and cancellations: read once more for the marks (its line is kept). */
export const needsMarks = (entry: CalendarLineEntry | undefined) => Boolean(entry) && (entry!.rest === undefined || entry!.cancelled === undefined);

/**
 * A meeting its organiser cancelled, by the classifier's mark (Outlook keeps it on an attendee's calendar as 「Canceled: …」; Graph's own
 * `isCancelled` already drops it at sync, so this covers what was carried from before). Not a commitment: the plan must not block it.
 */
export function isCancelledEvent(filing: CalendarLines | null | undefined, title: string): boolean {
  return filing?.entries[calendarEventKey(title)]?.cancelled === true;
}

/** The line a calendar event is filed under, if any. */
export function calendarLineOf(filing: CalendarLines | null | undefined, title: string): string | undefined {
  const lineId = filing?.entries[calendarEventKey(title)]?.lineId;
  return lineId || undefined;
}

/**
 * The filing as it stands against the current lines: as stored when made against them; otherwise only the person's own answers that
 * still name an existing line (or none) — the model's are refiled.
 */
export function currentFiling(stored: CalendarLines | null | undefined, lines: Array<{ id: string; label: string }>): CalendarLines {
  const basis = calendarLinesBasis(lines);
  if (!stored?.entries) return { basis, entries: {} };
  if (stored.basis === basis) return stored;
  const ids = new Set(lines.map((line) => line.id));
  return { basis, entries: Object.fromEntries(Object.entries(stored.entries).filter(([, entry]) => entry.by === "person" && (!entry.lineId || ids.has(entry.lineId)))) };
}
