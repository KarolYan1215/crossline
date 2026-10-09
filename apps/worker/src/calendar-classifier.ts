import { CALENDAR_CLASSIFICATION_SCHEMA, CALENDAR_LINES, calendarEventKey, calendarLinesBasis, currentFiling, importedProjects, importedTitle, itemProjectResolver, validateCalendarClassification,
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
  let stored: CalendarLines | null = null;
  try { stored = JSON.parse(store.getSetting(workspaceId, CALENDAR_LINES) ?? "null") as CalendarLines | null; } catch { /* unreadable: refile */ }
  return currentFiling(stored, identityLines(store, workspaceId));
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
  // Filed under the name the calendar shows: a file date with its course in front (`importedTitle`).
  const projects = store.listProjects(workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  const imported = importedProjects(store.listEvents(workspaceId, { type: "dates.extracted" }), itemProjectResolver(projects, store.listSourceDocuments(workspaceId)));
  for (const raw of blocks) {
    const block = { ...raw, title: importedTitle(raw.id, raw.title, imported) };
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
    // Everything on record that can place an event: the files by name and project, and what the person confirmed (「每周二组会」).
    const projectName = new Map(store.listProjects(workspaceId).map((project) => [project.id, project.name]));
    const files = store.listSourceDocuments(workspaceId).map((doc) => ({ name: doc.fileName, project: doc.projectId ? projectName.get(doc.projectId) ?? "" : "" }));
    const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed").slice(0, 80)
      .map((fact) => ({ lineId: fact.identityId, project: fact.projectId ? projectName.get(fact.projectId) ?? fact.projectId : "", statement: fact.value.slice(0, 160) }));
    const context = { version: "crossline.calendar-lines.v2", lines, projects, files, facts, events };
    const result = await runCodexSkill<CalendarClassification>(client, context, { skillName: CALENDAR_CLASSIFIER, cwd,
      developerInstructions: "File each calendar event under a line as the Skill describes. Return raw JSON only.", outputSchema: CALENDAR_CLASSIFICATION_SCHEMA,
      prepareInput: () => context, validateOutput: (output) => validateCalendarClassification(output, events.map((event) => event.key), lines.map((line) => line.id)),
      onAudit: () => {}, timeoutMs: 20 * 60_000 });
    if (!result.ok) return { blocked: result.blocker.code };
    // Read again: the lines may have changed while the model ran, in which case this answer is filed against the old ones and dropped.
    const filing = readCalendarLines(store, workspaceId);
    if (filing.basis !== calendarLinesBasis(lines)) return { filed: 0 };
    const at = new Date().toISOString();
    for (const item of result.output.items) {
      // The person's own answer is never overwritten by a model's.
      if (filing.entries[item.key]?.by === "person") continue;
      filing.entries[item.key] = { lineId: item.lineId, why: item.why, at, by: "model", ...(item.unclear ? { unclear: true } : {}) };
    }
    store.setSetting(workspaceId, CALENDAR_LINES, JSON.stringify(filing));
    return { filed: result.output.items.length };
  };
}
