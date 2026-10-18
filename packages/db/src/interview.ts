import { interviewChecklist, lineAttributes, profileGaps, PROFILE_CONFIRMED, portraitStillConfirmed, type ChecklistItem, type ProfileGap, type ProfileModel, type QuestionScreenInput, type StoredLineProfile } from "@crossline/core";
import { unfiledFilesIn } from "./file-belonging";
import { latestFileDates } from "./index";
import type { CrosslineStore } from "./index";

type DateRow = { id: string; project?: string; kind?: string; sourceRef?: string; date?: string; to?: string };

/**
 * Every dated item read from files or replies, pending or confirmed (an excluded one does not count; a pending one already over is
 * history, never offered, so it waits for nobody), with its project, kind and whether it repeats weekly.
 */
function datedItems(store: CrosslineStore, workspaceId: string, today: string) {
  const decided = new Map(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => [event.entityId,
    event.payload as { superseded?: boolean; included?: string[] }]));
  return store.listEvents(workspaceId, { type: "dates.extracted" }).flatMap((event) => {
    const decision = decided.get(event.entityId);
    if (decision?.superseded) return [];
    const payload = event.payload as { dates?: DateRow[]; recurring?: DateRow[] };
    const keep = (row: DateRow) => decision ? (decision.included ?? []).includes(row.id) : (row.date ?? row.to ?? today) >= today;
    return [...(payload.dates ?? []).filter(keep).map((row) => ({ row, recurring: false })), ...(payload.recurring ?? []).filter(keep).map((row) => ({ row, recurring: true }))]
      .map(({ row, recurring }) => ({ project: row.project ?? "", kind: row.kind ?? (recurring ? "class" : "other"), recurring, pending: !decision, sourceRef: row.sourceRef ?? "" }));
  });
}

/** The projects (by id or name) a one-off dated item is on record for: their deadline is known. */
const datedProjects = (store: CrosslineStore, workspaceId: string, today: string) =>
  [...new Set(datedItems(store, workspaceId, today).filter((entry) => !entry.recurring && entry.project).map((entry) => entry.project))];

/**
 * The interview's completion list (`interviewChecklist`) built from what the ledger holds: the lines and their goals (given by the caller,
 * who knows the installed packs), the interview's line descriptions and working profile, the facts and projects, every dated item read
 * from files or replies (pending or confirmed; an excluded one does not count), the availability, and the person's confirmation of the
 * portrait — which holds only while the portrait is the one they confirmed.
 */
export function interviewChecklistFor(store: CrosslineStore, workspaceId: string,
  lines: Array<{ id: string; label: string; hard: boolean; goals: string[] }>, extras: { unfiledFiles: number | null; today?: string }): ChecklistItem[] {
  const today = extras.today ?? new Date().toISOString().slice(0, 10);
  const json = <T,>(key: string, fallback: T): T => { try { return JSON.parse(store.getSetting(workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; } };
  const profiles = json<Record<string, StoredLineProfile>>("lines.profiles", {});
  const profile = json<Partial<ProfileModel>>("profile.model", {});
  const dates = datedItems(store, workspaceId, today);
  const confirmed = json<{ fingerprint?: string } | null>(PROFILE_CONFIRMED, null);
  return interviewChecklist({
    lines,
    descriptions: Object.fromEntries(Object.entries(profiles).map(([id, value]) => [id, { description: value.description ?? "", candidates: (value.attributes ?? []).length || (value.goalCandidates ?? []).length }])),
    profile,
    facts: store.listProfileFacts(workspaceId).map(({ identityId, projectId, slot, status, sourceRef, value }) => ({ identityId, projectId, slot, status, sourceRef, value })),
    projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
    dates,
    availability: Boolean(store.getSetting(workspaceId, "schedule.availability.proposed") || store.getSetting(workspaceId, "schedule.availability")),
    unfiledFiles: extras.unfiledFiles,
    portraitConfirmed: portraitStillConfirmed(confirmed?.fingerprint, profile)
  });
}

/** The projects (by id or name) a weekly meeting is on record for, from every date batch not superseded, pending or confirmed. */
export function meetingProjects(store: CrosslineStore, workspaceId: string): string[] {
  const decided = new Map(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => [event.entityId,
    event.payload as { superseded?: boolean; included?: string[] }]));
  return store.listEvents(workspaceId, { type: "dates.extracted" }).flatMap((event) => {
    const decision = decided.get(event.entityId);
    if (decision?.superseded) return [];
    return ((event.payload as { recurring?: DateRow[] }).recurring ?? [])
      .filter((row) => !decision || (decision.included ?? []).includes(row.id)).map((row) => row.project ?? "").filter(Boolean);
  });
}

type LineInput = { id: string; label: string; hard: boolean; goals: string[] };

/**
 * The questions the app itself puts to the person during the interview (`profileGaps`), from what the ledger holds now: lines resting
 * on guesses, TBD dates, courses with no class times, files only the person can file, a written portrait not yet confirmed. The worker
 * adds them to each round; while the person uses the app with the interview unfinished, 待决事项 asks them instead.
 */
export function interviewGapsFor(store: CrosslineStore, workspaceId: string, lines: LineInput[], today: string): ProfileGap[] {
  const unfiled = unfiledFilesIn(store, workspaceId, { today, lineNames: lines.flatMap((line) => [line.id, line.label]) });
  const items = interviewChecklistFor(store, workspaceId, lines, { unfiledFiles: unfiled.length, today });
  return profileGaps({
    identities: lines.map(({ id, label }) => ({ id, label })),
    projects: store.listProjects(workspaceId).map(({ id, identityId, name }) => ({ id, identityId, name })),
    facts: store.listProfileFacts(workspaceId),
    undated: latestFileDates(store, workspaceId).undated,
    meetings: meetingProjects(store, workspaceId),
    dated: datedProjects(store, workspaceId, today),
    datedItems: latestFileDates(store, workspaceId).dates.map(({ project, title }) => ({ project, title })),
    calendarRecurring: calendarRecurringTitles(store, workspaceId),
    unfiled,
    portrait: { written: Boolean(items.find((item) => item.id === "portrait_fields")?.done), confirmed: Boolean(items.find((item) => item.id === "portrait_confirmed")?.done) }
  });
}

/**
 * Titles the connected calendars hold on more than one day of the current plan (`graph_calendar:` blocks, every provider): a weekly class
 * or meeting. What repeats is read from the calendar, never asked.
 */
export function calendarRecurringTitles(store: CrosslineStore, workspaceId: string): string[] {
  const blocks = ((store.listPlanVersions(workspaceId)[0]?.payload as { blocks?: Array<{ id: string; title?: string; day?: string }> } | undefined)?.blocks ?? []);
  const days = new Map<string, { title: string; days: Set<string> }>();
  for (const block of blocks) {
    if (!block.id.startsWith("graph_calendar:") || !block.title || !block.day) continue;
    const key = block.title.replace(/\s+/g, "").toLowerCase();
    const entry = days.get(key) ?? { title: block.title, days: new Set<string>() };
    entry.days.add(block.day);
    days.set(key, entry);
  }
  return [...days.values()].filter((entry) => entry.days.size >= 2).map((entry) => entry.title);
}

/** What the app needs to keep from the person the interview's questions that are not theirs to answer (`screenQuestions`). */
export function questionScreenFor(store: CrosslineStore, workspaceId: string): QuestionScreenInput {
  const meetingFacts = store.listProfileFacts(workspaceId).filter((fact) => fact.projectId && /^(meeting|class)_?times?$|^no_meetings$/.test(fact.slot)
    && fact.status === "confirmed").map((fact) => fact.projectId);
  let profiles: Record<string, StoredLineProfile> = {};
  try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") as Record<string, StoredLineProfile>; } catch { /* none */ }
  return {
    projects: store.listProjects(workspaceId).map(({ id, name }) => ({ id, name })),
    meetings: [...new Set([...meetingProjects(store, workspaceId), ...meetingFacts])],
    calendarRecurring: calendarRecurringTitles(store, workspaceId),
    goalPickerLines: Object.entries(profiles).filter(([, profile]) => lineAttributes(profile, "").length > 0).map(([id]) => id)
  };
}
