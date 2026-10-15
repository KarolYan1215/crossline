import "server-only";
import { SOURCE_FOLDERS_SETTING, readSourceFolders, sourceFolderIndexSetting, calendarWeek, type AccessContext, type AvailabilityWindow, type DateCandidate, type RecurringMeeting, type WeekCalendarEvent } from "@crossline/core";
import { getStore, resolvedAvailability } from "./crossline";

/**
 * What the interview's right column draws besides the profile itself (docs/onboarding-v3.md): the week as it stands — the hours the
 * person works in and the fixed arrangements read from files or replies — and each project's dated items on one axis. Read from the same
 * date batches the confirmation card uses: an item the person turned down is left out, one waiting for them is drawn as pending.
 */
export type WeekFixed = { id: string; title: string; project: string; weekdays: number[]; start: string; end: string; status: "confirmed" | "pending" };
export type WeekSkeleton = { windows: AvailabilityWindow[]; source: string; fixed: WeekFixed[]; calendar: WeekCalendarEvent[] };
export type TimelineItem = { id: string; date: string; title: string; kind: string; status: "confirmed" | "pending" };
export type ProjectTimeline = Array<{ id: string; identityId: string; name: string; deadline: string; noDeadline: boolean; items: TimelineItem[] }>;

type Extracted = { dates?: DateCandidate[]; recurring?: RecurringMeeting[] };
type Decided = { included?: string[]; excluded?: string[] };

function batches(ctx: AccessContext): Array<{ payload: Extracted; included: Set<string> | null; excluded: Set<string> }> {
  const store = getStore();
  const decisions = new Map(store.listEvents(ctx.workspaceId, { type: "dates.decided" }).map((event) => [event.entityId, event.payload as Decided]));
  return store.listEvents(ctx.workspaceId, { type: "dates.extracted" }).map((event) => {
    const decision = decisions.get(event.entityId);
    return { payload: event.payload as Extracted, included: decision ? new Set(decision.included ?? []) : null, excluded: new Set(decision?.excluded ?? []) };
  });
}
const statusOf = (id: string, included: Set<string> | null, excluded: Set<string>): "confirmed" | "pending" | undefined =>
  included === null ? "pending" : included.has(id) ? "confirmed" : excluded.has(id) ? undefined : undefined;

export function weekSkeleton(ctx: AccessContext, today: string): WeekSkeleton {
  const { windows, source } = resolvedAvailability(ctx);
  const seen = new Set<string>();
  const fixed: WeekFixed[] = [];
  for (const batch of [...batches(ctx)].reverse()) for (const meeting of batch.payload.recurring ?? []) {
    const status = statusOf(meeting.id, batch.included, batch.excluded);
    // A newer batch re-reads the same class: the newest reading of a title and time is the one drawn.
    const key = `${meeting.title}|${meeting.weekdays.join()}|${meeting.startTime}`;
    if (!status || meeting.to < today || seen.has(key)) continue;
    seen.add(key);
    fixed.push({ id: meeting.id, title: meeting.title, project: meeting.project, weekdays: meeting.weekdays, start: meeting.startTime, end: meeting.endTime, status });
  }
  const plan = getStore().listPlanVersions(ctx.workspaceId)[0];
  return { windows, source, fixed, calendar: calendarWeek((plan?.payload as { blocks?: [] } | undefined)?.blocks ?? [], today) };
}



const DATED_KINDS = new Set(["exam", "project_due", "deadline", "homework_due", "quiz", "meeting", "other"]);

export function projectTimeline(ctx: AccessContext, today: string): ProjectTimeline {
  const store = getStore();
  const projects = store.listProjects(ctx.workspaceId).filter((project) => !/-default$/.test(project.id));
  const facts = store.listProfileFacts(ctx.workspaceId);
  const items = new Map<string, TimelineItem[]>();
  for (const batch of batches(ctx)) for (const item of batch.payload.dates ?? []) {
    const status = statusOf(item.id, batch.included, batch.excluded);
    if (!status || item.date < today || !DATED_KINDS.has(item.kind)) continue;
    const project = projects.find((entry) => entry.id === item.project || entry.name === item.project);
    if (!project) continue;
    const list = items.get(project.id) ?? [];
    if (!list.some((entry) => entry.date === item.date && entry.title === item.title)) list.push({ id: item.id, date: item.date, title: item.title, kind: item.kind, status });
    items.set(project.id, list);
  }
  return projects.map((project) => {
    const deadline = facts.find((fact) => fact.projectId === project.id && fact.slot === "deadline")?.value ?? "";
    return { id: project.id, identityId: project.identityId, name: project.name, deadline,
      noDeadline: facts.some((fact) => fact.projectId === project.id && fact.slot === "no_deadline"),
      items: (items.get(project.id) ?? []).sort((a, b) => a.date.localeCompare(b.date)) };
  });
}

/** Documents read from an authorized folder: shown in the folder's own card, not one by one among the uploads (a folder can hold hundreds). */
export function folderDocumentIds(ctx: AccessContext): Set<string> {
  const store = getStore();
  const ids = new Set<string>();
  for (const folder of readSourceFolders(store.getSetting(ctx.workspaceId, SOURCE_FOLDERS_SETTING))) {
    try { for (const entry of Object.values(JSON.parse(store.getSetting(ctx.workspaceId, sourceFolderIndexSetting(folder.id)) ?? "{}") as Record<string, { documentId: string }>)) ids.add(entry.documentId); }
    catch { /* unreadable index: nothing to hide */ }
  }
  return ids;
}
