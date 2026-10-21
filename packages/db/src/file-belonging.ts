import { documentsByRef, leaningProject, plainProject, projectsNamedIn, type KnownProject } from "@crossline/core";
import type { CrosslineStore } from "./index";

/** Events an undo took back (`op.undone` of an `event.retract` operation): read as if they had never been written. */
export function retractedEventIdsIn(store: CrosslineStore, workspaceId: string): Set<string> {
  const undone = new Set(store.listEvents(workspaceId, { type: "op.undone" }).map((event) => event.entityId));
  return new Set(store.listEvents(workspaceId, { type: "op.applied" })
    .filter((event) => undone.has(event.entityId))
    .flatMap((event) => retracted((event.payload as { inverse?: RetractInverse }).inverse)));
}
type RetractInverse = { kind?: string; eventIds?: string[]; items?: RetractInverse[] };
/** Inside a batch too: an operation that also archived or moved something records its markers as one item of several. */
const retracted = (inverse: RetractInverse | undefined): string[] =>
  inverse?.kind === "event.retract" ? inverse.eventIds ?? [] : inverse?.kind === "batch" ? (inverse.items ?? []).flatMap(retracted) : [];

const PERSONAL = /^(个人|本人|个人档案|个人信息|person|personal)$/iu;
/** A file whose own name says it is about the person — a profile, a CV — whatever projects it happens to name in passing. */
const PROFILE_FILE = /(profile|resume|résumé|(^|[^a-z])cv([^a-z]|$)|简历|个人档案|个人资料|个人简介|画像)/iu;

/**
 * A file that came as part of a folder: an authorized folder's (`<label>/<relative path>`), a folder picked in the interview
 * (`webkitRelativePath`) or a recording's transcript (`<folder>/<file> 转写.txt`). A folder is filed by line once, as a whole (the folder
 * classifier, `linesBy`), and its files reach a task as the line's material; one question per file asked about every PDF in Downloads
 * (60 on the real account, 2026-10-21). Only when dates were read from such a file is its project asked.
 */
export const fromFolder = (fileName: string) => fileName.includes("/");

export type UnfiledFile = { id: string; fileName: string; titles: string[]; days: string[]; lean: KnownProject | undefined; raisedAt: string };

/**
 * The uploaded files whose project only the person can tell (decided 2026-10-08), each asked about once on 待决事项 and nowhere else:
 * a file not yet filed and not declined, not part of a folder (`fromFolder`), whose own name and opening name **no** known project — and also one that several projects
 * are named in when dates read from it belong to a project the interview could not tell (「课程待确认（可能为 ECE 548）」). A file that
 * names several projects and dates nothing project-bound (a CV, a profile) is about the person and is not asked about. With the dates
 * read from it (for the question's explanation and its urgency) and the project the interview leaned towards.
 */
export function unfiledFilesIn(store: CrosslineStore, workspaceId: string, input: { today: string; lineNames: string[] }): UnfiledFile[] {
  const today = input.today;
  const projects = store.listProjects(workspaceId).map((project) => ({ id: project.id, name: project.name, identityId: project.identityId }));
  if (!projects.length) return [];
  const docs = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done");
  const byRef = documentsByRef(store.listSourceDocuments(workspaceId));
  const retracted = retractedEventIdsIn(store, workspaceId);
  const cleared = new Set(store.listEvents(workspaceId, { type: "source.project_cleared" }).filter((event) => !retracted.has(event.eventId)).map((event) => event.entityId));
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
  const superseded = new Set(store.listEvents(workspaceId, { type: "dates.decided" })
    .filter((event) => (event.payload as { superseded?: boolean }).superseded).map((event) => event.entityId));
  const lineNames = new Set(input.lineNames);
  type Item = { title: string; project?: string; sourceRef?: string; date?: string; from?: string };
  const extracted = store.listEvents(workspaceId, { type: "dates.extracted" }).filter((event) => !superseded.has(event.entityId));
  const itemsOf = (event: (typeof extracted)[number]) => { const payload = event.payload as { dates?: Item[]; recurring?: Item[]; undated?: Item[] };
    return [...(payload.dates ?? []), ...(payload.recurring ?? []), ...(payload.undated ?? [])]; };
  const personalItem = (item: Item) => { const project = item.project?.trim() ?? ""; return !project || lineNames.has(project) || PERSONAL.test(project); };
  // A file the interview read the person's own history from (its dates filed under 「个人档案」 or a line's name) is about the person.
  const personal = new Set(extracted.flatMap((event) => itemsOf(event).filter(personalItem).flatMap((item) => item.sourceRef ? [byRef.get(item.sourceRef)?.id ?? ""] : [])));
  for (const doc of docs) {
    if (doc.projectId || cleared.has(doc.id) || personal.has(doc.id) || PROFILE_FILE.test(doc.fileName) || fromFolder(doc.fileName) || named(doc) > 0) continue;
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
