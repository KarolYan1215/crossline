import { withCourse } from "./task-title";

/**
 * Which line a calendar event belongs to (decided 2026-10-08: the person does not sort their synced calendar by hand — the model reads it
 * and files each event). Events are filed by their title, normalised, because a recurring class or meeting repeats one title, and one
 * answer then covers every occurrence. An event that belongs to no line (a dentist appointment, a birthday) is filed under "" and stays
 * uncoloured. The answers live in the `CALENDAR_LINES` setting, so a backup carries them.
 */
export const CALENDAR_LINES = "calendar.lines";

export type CalendarLineEntry = { lineId: string; why: string; at: string };
/** The stored filing: entries by event key, and the lines they were filed against (a renamed or new line refiles everything). */
export type CalendarLines = { basis: string; entries: Record<string, CalendarLineEntry> };

/** One title for every occurrence: whitespace collapsed, case folded. */
export const calendarEventKey = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);

/** What the filing was made against: the lines' ids and names. When it changes, earlier answers are no longer trusted. */
export const calendarLinesBasis = (lines: Array<{ id: string; label: string }>) => lines.map((line) => `${line.id}=${line.label}`).sort().join("|");

/** The classifier's answer (Skill `crossline-calendar-classifier`). */
export type CalendarClassification = { items: Array<{ key: string; lineId: string; why: string }> };
export const CALENDAR_CLASSIFICATION_SCHEMA = { type: "object", additionalProperties: false, required: ["items"], properties: {
  items: { type: "array", maxItems: 60, items: { type: "object", additionalProperties: false, required: ["key", "lineId", "why"], properties: {
    key: { type: "string", minLength: 1, maxLength: 200 }, lineId: { type: "string", maxLength: 80 }, why: { type: "string", maxLength: 200 } } } } } } as const;

/**
 * Keeps an answer for each event it was asked about: a line that exists, or "" for none. An unknown key is dropped; a line id that does
 * not exist is filed as "" rather than refused — an uncoloured event is harmless, a wrong colour is not.
 */
export function validateCalendarClassification(value: unknown, keys: string[], lineIds: string[]): CalendarClassification {
  const answer = value as CalendarClassification | undefined;
  if (!answer || !Array.isArray(answer.items)) throw new Error("CALENDAR_CLASSIFICATION_INVALID");
  const asked = new Set(keys), lines = new Set(lineIds), seen = new Set<string>();
  const items = answer.items.filter((item) => item && asked.has(item.key) && !seen.has(item.key) && Boolean(seen.add(item.key)))
    .map((item) => ({ key: item.key, lineId: lines.has(item.lineId) ? item.lineId : "", why: String(item.why ?? "").trim().slice(0, 200) }));
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
export function importedProjects(events: Array<{ entityId: string; payload: unknown }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload as { dates?: Array<{ id: string; project?: string }>; recurring?: Array<{ id: string; project?: string }> } | undefined;
    for (const item of [...(payload?.dates ?? []), ...(payload?.recurring ?? [])]) if (item.project) out.set(`${event.entityId}:${item.id}`, item.project);
  }
  return out;
}

/** The name an imported block is shown under: its own, with its course in front when its batch item names one. */
export function importedTitle(blockId: string, title: string, projects: Map<string, string>): string {
  if (!blockId.startsWith("import:")) return title;
  const [, batch, item] = blockId.split(":");
  return withCourse(title, projects.get(`${batch}:${item}`));
}
