import { CALENDAR_CLASSIFICATION_SCHEMA, CALENDAR_LINES, calendarEventKey, calendarLinesBasis, validateCalendarClassification,
  type CalendarClassification, type CalendarLines } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";

export const CALENDAR_CLASSIFIER = "crossline:crossline-calendar-classifier";
const BATCH = 40;
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

type Block = { id: string; title: string; day?: string; start: string; end: string };

/** The filing as stored, emptied when the lines it was made against have changed (a renamed or new line refiles every event). */
export function readCalendarLines(store: CrosslineStore, workspaceId: string): CalendarLines {
  const basis = calendarLinesBasis(identityLines(store, workspaceId));
  try {
    const stored = JSON.parse(store.getSetting(workspaceId, CALENDAR_LINES) ?? "null") as CalendarLines | null;
    if (stored && stored.basis === basis && stored.entries) return stored;
  } catch { /* unreadable: refile */ }
  return { basis, entries: {} };
}

/**
 * Events on the current plan that come from the person's synced calendars or confirmed file dates and have not been filed yet, one per
 * title, with how often and when they occur (a weekly 10:00 slot reads differently from a one-off).
 */
export function unfiledCalendarEvents(store: CrosslineStore, workspaceId: string): Array<{ key: string; title: string; source: "calendar" | "file"; count: number; when: string[] }> {
  const filing = readCalendarLines(store, workspaceId);
  const blocks = (((store.listPlanVersions(workspaceId)[0]?.payload as { blocks?: Block[] } | undefined)?.blocks) ?? [])
    .filter((block) => block.id.startsWith("graph_calendar:") || block.id.startsWith("import:"));
  const byKey = new Map<string, { key: string; title: string; source: "calendar" | "file"; count: number; when: string[] }>();
  for (const block of blocks) {
    const key = calendarEventKey(block.title);
    if (!key || key in filing.entries) continue;
    const entry = byKey.get(key) ?? { key, title: block.title.slice(0, 200), source: block.id.startsWith("import:") ? "file" as const : "calendar" as const, count: 0, when: [] };
    entry.count += 1;
    if (entry.when.length < 3 && block.day) entry.when.push(`${block.day} ${WEEKDAY[new Date(`${block.day}T12:00:00Z`).getUTCDay()]} ${block.start}–${block.end}`);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * Files calendar events under the person's lines (decided 2026-10-08: never by hand). Reads the lines with what the interview learned about
 * each, and the projects under them, so 「ECE 555 Lecture」 lands on the line that holds the course. Up to forty titles a run.
 */
export function createCalendarClassifier(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function classify(): Promise<{ filed: number } | { blocked: string }> {
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const events = unfiledCalendarEvents(store, workspaceId).slice(0, BATCH);
    if (!events.length) return { filed: 0 };
    let profiles: Record<string, { description?: string }> = {};
    try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") ?? {}; } catch { /* none yet */ }
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label, hard: Boolean(line.hard), goals: line.goals ?? [],
      description: profiles[line.id]?.description ?? "" }));
    if (!lines.length) return { filed: 0 };
    const projects = store.listProjects(workspaceId).map((project) => ({ name: project.name, lineId: project.identityId }));
    const context = { version: "crossline.calendar-lines.v1", lines, projects, events };
    const result = await runCodexSkill<CalendarClassification>(client, context, { skillName: CALENDAR_CLASSIFIER, cwd,
      developerInstructions: "File each calendar event under a line as the Skill describes. Return raw JSON only.", outputSchema: CALENDAR_CLASSIFICATION_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateCalendarClassification(output, events.map((event) => event.key), lines.map((line) => line.id)),
      onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    // Read again: the lines may have changed while the model ran, in which case this answer is filed against the old ones and dropped.
    const filing = readCalendarLines(store, workspaceId);
    if (filing.basis !== calendarLinesBasis(lines)) return { filed: 0 };
    const at = new Date().toISOString();
    for (const item of result.output.items) filing.entries[item.key] = { lineId: item.lineId, why: item.why, at };
    store.setSetting(workspaceId, CALENDAR_LINES, JSON.stringify(filing));
    return { filed: result.output.items.length };
  };
}
