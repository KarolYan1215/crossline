import "server-only";
import { documentsByRef, leaningProject, plainProject, projectsNamedIn, type AccessContext, type KnownProject } from "@crossline/core";
import { retractedEventIds } from "./undo";
import { getStore } from "./crossline";
import { identityLines } from "./lines";

const PERSONAL = /^(个人|本人|个人档案|个人信息|person|personal)$/iu;

export type UnfiledFile = { id: string; fileName: string; titles: string[]; days: string[]; lean: KnownProject | undefined; raisedAt: string };

/**
 * The uploaded files whose project only the person can tell (decided 2026-10-08), each asked about once on 待决事项 and nowhere else:
 * a file not yet filed and not declined, whose own name and opening name **no** known project — and also one that several projects
 * are named in when dates read from it belong to a project the interview could not tell (「课程待确认（可能为 ECE 548）」). A file that
 * names several projects and dates nothing project-bound (a CV, a profile) is about the person and is not asked about. With the dates
 * read from it (for the question's explanation and its urgency) and the project the interview leaned towards.
 */
export function unfiledFiles(ctx: AccessContext, today: string): UnfiledFile[] {
  const store = getStore();
  const projects = store.listProjects(ctx.workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  if (!projects.length) return [];
  const docs = store.listSourceDocuments(ctx.workspaceId).filter((doc) => doc.extractionStatus === "done");
  const byRef = documentsByRef(store.listSourceDocuments(ctx.workspaceId));
  const retracted = retractedEventIds(ctx);
  const cleared = new Set(store.listEvents(ctx.workspaceId, { type: "source.project_cleared" }).filter((event) => !retracted.has(event.eventId)).map((event) => event.entityId));
  const open = new Map<string, UnfiledFile>();
  const entry = (doc: { id: string; fileName: string; createdAt: string }) => open.get(doc.id)
    ?? open.set(doc.id, { id: doc.id, fileName: doc.fileName, titles: [], days: [], lean: undefined, raisedAt: doc.createdAt }).get(doc.id)!;
  const named = (doc: { fileName: string; extractedText: string }) => {
    const ids = new Set([...projectsNamedIn(doc.fileName, projects), ...projectsNamedIn(doc.extractedText.slice(0, 1500), projects)].map((project) => project.id));
    return ids.size;
  };
  // The whole text decides what kind of file it is: one that names several projects anywhere is about the person (a CV, a profile);
  // one that names a single project only further down is asked about, with that project recommended.
  const inWhole = (doc: { fileName: string; extractedText: string }) => projectsNamedIn(`${doc.fileName}\n${doc.extractedText}`, projects);
  const superseded = new Set(store.listEvents(ctx.workspaceId, { type: "dates.decided" })
    .filter((event) => (event.payload as { superseded?: boolean }).superseded).map((event) => event.entityId));
  const lineNames = new Set(identityLines(ctx).flatMap((line) => [line.id, line.label]));
  type Item = { title: string; project?: string; sourceRef?: string; date?: string; from?: string };
  const extracted = store.listEvents(ctx.workspaceId, { type: "dates.extracted" }).filter((event) => !superseded.has(event.entityId));
  const itemsOf = (event: (typeof extracted)[number]) => { const payload = event.payload as { dates?: Item[]; recurring?: Item[]; undated?: Item[] };
    return [...(payload.dates ?? []), ...(payload.recurring ?? []), ...(payload.undated ?? [])]; };
  const personalItem = (item: Item) => { const project = item.project?.trim() ?? ""; return !project || lineNames.has(project) || PERSONAL.test(project); };
  // A file the interview read the person's own history from (its dates filed under 「个人档案」 or a line's name) is about the person.
  const personal = new Set(extracted.flatMap((event) => itemsOf(event).filter(personalItem).flatMap((item) => item.sourceRef ? [byRef.get(item.sourceRef)?.id ?? ""] : [])));
  for (const doc of docs) {
    if (doc.projectId || cleared.has(doc.id) || personal.has(doc.id) || named(doc) > 0) continue;
    const whole = inWhole(doc);
    if (whole.length > 1) continue;
    entry(doc).lean = whole[0];
  }

  for (const event of extracted) {
    for (const item of itemsOf(event)) {
      // An item under no project, under a line's own name or under the person (a CV's dates) is not about a project.
      if (personalItem(item) || plainProject(item.project, projects)) continue;
      const doc = item.sourceRef ? byRef.get(item.sourceRef) : undefined;
      if (!doc || doc.projectId || cleared.has(doc.id) || named(doc) === 1) continue;
      const file = entry(doc);
      if (file.raisedAt < event.createdAt) file.raisedAt = event.createdAt;
      if (!file.titles.includes(item.title)) file.titles.push(item.title);
      const day = item.date ?? item.from;
      if (day && day >= today) file.days.push(day);
      file.lean ??= leaningProject(item.project, projects);
    }
  }
  return [...open.values()];
}
