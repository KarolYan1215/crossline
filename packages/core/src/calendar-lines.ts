import { withCourse } from "./task-title";

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
export type CalendarLineEntry = { lineId: string; why: string; at: string; unclear?: boolean; by?: "model" | "person" };
/** The stored filing: entries by event key, and the lines they were filed against (a renamed or new line refiles everything). */
export type CalendarLines = { basis: string; entries: Record<string, CalendarLineEntry> };

/** One title for every occurrence: whitespace collapsed, case folded. */
/**
 * A meeting the organiser cancelled: Outlook keeps it on an attendee's calendar with its title prefixed 「Canceled:」 (and Graph may also
 * say `isCancelled`). It is not a commitment — the plan must not block that time for it.
 */
export const isCancelledEvent = (title: string) => /^\s*(canceled|cancelled|已取消|取消)\s*[:：]/i.test(title);
export const calendarEventKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);

/** What the filing was made against: the lines' ids and names. When it changes, earlier answers are no longer trusted. */
export const calendarLinesBasis = (lines: Array<{ id: string; label: string }>) => lines.map((line) => `${line.id}=${line.label}`).sort().join("|");

/** The classifier's answer (Skill `crossline-calendar-classifier`). */
export type CalendarClassification = { items: Array<{ key: string; lineId: string; why: string; unclear: boolean }> };
export const CALENDAR_CLASSIFICATION_SCHEMA = { type: "object", additionalProperties: false, required: ["items"], properties: {
  items: { type: "array", maxItems: 60, items: { type: "object", additionalProperties: false, required: ["key", "lineId", "why", "unclear"], properties: {
    key: { type: "string", minLength: 1, maxLength: 200 }, lineId: { type: "string", maxLength: 80 }, why: { type: "string", maxLength: 200 },
    unclear: { type: "boolean" } } } } } } as const;

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
      return { key: item.key, lineId: known ? item.lineId : "", why: String(item.why ?? "").trim().slice(0, 200), unclear: !known && (item.unclear === true || Boolean(item.lineId)) }; });
  return { items };
}

/** The line a calendar event is filed under, if any. */
export function calendarLineOf(filing: CalendarLines | null | undefined, title: string): string | undefined {
  const lineId = filing?.entries[calendarEventKey(title)]?.lineId;
  return lineId || undefined;
}

/**
 * The project of each confirmed file date, by `<batch>:<item>`, read from the `dates.extracted` events. A block imported before dates
 * named their course (`import:<batch>:<item>[:<day>]`) is shown — and filed — under a name that carries it (`withCourse`), without
 * rewriting a plan the person approved.
 */
export function importedProjects(events: Array<{ entityId: string; payload: unknown }>,
  projectOf: (item: { project?: string; sourceRef?: string }) => string | undefined = (item) => item.project): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload as { dates?: Array<{ id: string; project?: string; sourceRef?: string }>; recurring?: Array<{ id: string; project?: string; sourceRef?: string }> } | undefined;
    for (const item of [...(payload?.dates ?? []), ...(payload?.recurring ?? [])]) {
      const project = projectOf(item);
      if (project) out.set(`${event.entityId}:${item.id}`, project);
    }
  }
  return out;
}

/** The name an imported block is shown under: its own, with its course in front when its batch item names one. */
export function importedTitle(blockId: string, title: string, projects: Map<string, string>): string {
  if (!blockId.startsWith("import:")) return title;
  const [, batch, item] = blockId.split(":");
  return withCourse(title, projects.get(`${batch}:${item}`));
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
