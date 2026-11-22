/**
 * What a dated item, a file or an event belongs to, worked out from everything already on record before anyone is asked (decided
 * 2026-10-08): the item's own project when it names a known one plainly, the project its source file is already filed under, then the
 * file's name, then the opening of its text. Only a single, unambiguous match counts — two projects named in one file decide nothing.
 * What code cannot settle by a name written out goes to the folder classifier (`crossline.file-projects.v1`, `FILE_PROJECTS_SCHEMA`,
 * 2026-11-22: a course-code parser and a 「course part」 word list used to settle it, and knew only courses); what the model cannot settle
 * either is asked (`apps/web/lib/asks.ts`, `source_project`), never guessed for.
 */
export type KnownProject = { id: string; name: string; identityId: string };

const squash = (text: string) => text.replace(/[\s_\-·.:：]+/g, "").toLowerCase();
const UNCERTAIN = /待确认|可能|未定|不确定|[?？]|\b(possibly|maybe|probably|likely|perhaps|unconfirmed|uncertain|unsure|tbd|tbc)\b/iu;

/**
 * Known projects a piece of text names written out: the project's name or its id, three characters or more, appearing in it once spaces
 * and separators are set aside (「ECE555-Syllabus」 names 「ECE 555」). Anything looser is the model's to read.
 */
export function projectsNamedIn(text: string, projects: KnownProject[]): KnownProject[] {
  if (!text.trim()) return [];
  const haystack = squash(text);
  return projects.filter((project) => [squash(project.name), squash(project.id)].some((key) => key.length >= 3 && haystack.includes(key)));
}

/** The one known project a plain project string means (「ECE 555」, 「ece555」, 「Crossline」), or undefined — never for one marked uncertain. */
export function plainProject(project: string | undefined, projects: KnownProject[]): KnownProject | undefined {
  if (!project || UNCERTAIN.test(project)) return undefined;
  const exact = projects.find((item) => squash(item.id) === squash(project) || squash(item.name) === squash(project));
  if (exact) return exact;
  const named = projectsNamedIn(project, projects);
  return named.length === 1 ? named[0] : undefined;
}

/** The project a file's own name, or else the opening of its text, names unambiguously; with which of the two decided it. */
export function documentProject(doc: { fileName: string; extractedText: string }, projects: KnownProject[]): { project: KnownProject; basis: "文件名" | "正文开头" } | undefined {
  const byName = projectsNamedIn(doc.fileName, projects);
  if (byName.length === 1) return { project: byName[0]!, basis: "文件名" };
  if (byName.length > 1) return undefined;
  const byHead = projectsNamedIn(doc.extractedText.slice(0, 1500), projects);
  return byHead.length === 1 ? { project: byHead[0]!, basis: "正文开头" } : undefined;
}

/**
 * The folder classifier's reading of files code could not file (`crossline.file-projects.v1`): the one project each belongs to, or ""
 * when the file's own words do not tie it to one. A tie such as 「RBT610-Fall2026-Syllabus.pdf」 against both 「RBT 610 Robot Perception」
 * and 「RBT 610 期末项目」 (2026-10-15 walkthrough) is the model's to settle: the course's syllabus belongs to the course.
 */
export const FILE_PROJECTS_SCHEMA = { type: "object", additionalProperties: false, required: ["files"], properties: {
  files: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "projectId", "why"],
    properties: { id: { type: "string" }, projectId: { type: "string" }, why: { type: "string" } } } } } } as const;
export type FileProjectsAnswer = { files: Array<{ id: string; projectId: string; why: string }> };
/** Keeps only answers about files that were asked, naming a known project or none; unknown project ids count as none. */
export function validateFileProjects(value: unknown, fileIds: readonly string[], projectIds: readonly string[]): FileProjectsAnswer {
  const answer = value as FileProjectsAnswer | undefined;
  if (!answer || !Array.isArray(answer.files)) throw new Error("FILE_PROJECTS_INVALID");
  return { files: answer.files.filter((item) => item && fileIds.includes(item.id))
    .map((item) => ({ id: item.id, projectId: projectIds.includes(item.projectId) ? item.projectId : "", why: String(item.why ?? "").trim().slice(0, 200) })) };
}

/** A project an uncertain string leans towards (「课程待确认（可能为 ECE 548）」 → ECE 548): the recommended answer when the person is asked. */
export function leaningProject(project: string | undefined, projects: KnownProject[]): KnownProject | undefined {
  if (!project) return undefined;
  const named = projectsNamedIn(project, projects);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The upload a `src-N` reference means. Since migration 16 each document keeps the number it was given on upload (`refNo`): numbering by
 * position meant that removing one file (an excluded folder file, a deleted upload) renumbered every later one, and stored facts and
 * dates then pointed at the wrong file. A row without one (a test, a hand-built list) falls back to its position.
 */
export function documentsByRef<T extends { refNo?: number }>(docs: T[]): Map<string, T> {
  return new Map(docs.map((doc, index) => [`src-${doc.refNo ?? index + 1}`, doc]));
}

/**
 * The project name a dated item belongs to: its own project when that plainly names a known one, else the project its source file is
 * filed under (by its own evidence or by the person's answer), else none — and then the person is asked.
 */
export function itemProjectResolver(projects: KnownProject[], docs: Array<{ projectId?: string; refNo?: number }>): (item: { project?: string; sourceRef?: string }) => string | undefined {
  const byRef = documentsByRef(docs);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return (item) => plainProject(item.project, projects)?.name ?? (() => { const id = item.sourceRef ? byRef.get(item.sourceRef)?.projectId : undefined; return id ? names.get(id) : undefined; })();
}
