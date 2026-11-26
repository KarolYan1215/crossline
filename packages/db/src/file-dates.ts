import { CrosslineStore } from "./store";

/**
 * What the person's own files said about dates, from every batch still in force whether or not it has been confirmed yet (a milestone chain
 * should not wait on the calendar import), with each item tied to a project id. `dates` carry a day; `undated` are things a file lists but
 * marks TBD, kept so the part they belong to is not lost. An item with no project cannot belong to any project's chain and is left out.
 * Only the newest batch used to be read (W-228): a later reply that added one lunch hour hid every exam an earlier, adopted batch held.
 * A batch replaced by another is not read (its items moved into the new one); an item the person themself left out is not either.
 */
export function latestFileDates(store: CrosslineStore, workspaceId: string): {
  dates: Array<{ project: string; kind: string; date: string; title: string }>;
  undated: Array<{ project: string; kind: string; title: string; note?: string }>;
} {
  type Decision = { superseded?: boolean; excluded?: string[]; by?: string };
  const decisions = new Map<string, Decision[]>();
  for (const event of store.listEvents(workspaceId, { type: "dates.decided" })) decisions.set(event.entityId, [...(decisions.get(event.entityId) ?? []), event.payload as Decision]);
  type Item = { id?: string; project?: string; kind?: string; date?: string; title?: string; note?: string };
  const batches = [...store.listEvents(workspaceId, { type: "dates.extracted" })].reverse()
    .filter((event) => !(decisions.get(event.entityId) ?? []).some((decision) => decision.superseded))
    .map((event) => {
      const turnedDown = new Set((decisions.get(event.entityId) ?? []).filter((decision) => decision.by === "person").flatMap((decision) => decision.excluded ?? []));
      const body = event.payload as { dates?: Item[]; undated?: Item[] };
      const kept = (items: Item[] | undefined) => (items ?? []).filter((item) => !item.id || !turnedDown.has(item.id));
      return { dates: kept(body.dates), undated: kept(body.undated) };
    });
  // Newest first, so the same item read twice keeps its latest reading.
  const once = <T extends Item>(items: T[], key: (item: T) => string) => { const seen = new Set<string>(); return items.filter((item) => !seen.has(key(item)) && Boolean(seen.add(key(item)))); };
  const payload = { dates: once(batches.flatMap((batch) => batch.dates), (item) => `${item.project}|${item.kind}|${item.date}|${item.title}`),
    undated: once(batches.flatMap((batch) => batch.undated), (item) => `${item.project}|${item.kind}|${item.title}`) };
  // The model names a project by id when it can and by its name when it cannot; both are resolved to the id the milestones use.
  const projects = store.listProjects(workspaceId);
  const resolve = (name: string) => (projects.find((project) => project.id === name)
    ?? projects.find((project) => project.name.toLowerCase() === name.toLowerCase())
    ?? projects.find((project) => name.toLowerCase().includes(project.name.toLowerCase()) || project.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(project.id.toLowerCase())))?.id;
  const dates = (payload?.dates ?? []).flatMap((entry) => {
    const project = entry.project ? resolve(entry.project) : undefined;
    return project && entry.kind && entry.date && entry.title ? [{ project, kind: entry.kind, date: entry.date, title: entry.title }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 80);
  // An item whose file named its day only relatively (`relative:` note) is asked about even with no project: its day is lost otherwise.
  const undated = (payload?.undated ?? []).flatMap((entry) => {
    const project = entry.project ? resolve(entry.project) : undefined;
    const relative = typeof entry.note === "string" && entry.note.startsWith("relative:");
    if (!entry.kind || !entry.title || (!project && !relative)) return [];
    return [{ project: project ?? "", kind: entry.kind, title: entry.title, ...(relative ? { note: entry.note } : {}) }];
  }).slice(0, 20);
  return { dates, undated };
}
