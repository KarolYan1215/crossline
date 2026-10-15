import { courseCodeOf } from "./task-title";

/**
 * What a dated item, a file or an event belongs to, worked out from everything already on record before anyone is asked (decided
 * 2026-10-08): the item's own project when it names a known one plainly, the project its source file is already filed under, then the
 * file's name, then the opening of its text. Only a single, unambiguous match counts — two projects named in one file decide nothing.
 * When nothing decides it, the person is asked (`apps/web/lib/asks.ts`, `source_project`), never guessed for.
 */
export type KnownProject = { id: string; name: string; identityId: string };

const squash = (text: string) => text.replace(/[\s_\-·.:：]+/g, "").toLowerCase();
const UNCERTAIN = /待确认|可能|未定|不确定|[?？]/u;

/** Known projects a piece of text names: by course code, or by a name of three or more characters appearing in it. */
export function projectsNamedIn(text: string, projects: KnownProject[]): KnownProject[] {
  if (!text.trim()) return [];
  const haystack = squash(text);
  const codes = new Set([...text.matchAll(/(?:^|[^A-Za-z])([A-Za-z]{2,5})[\s_\-]?(\d{3,4}[A-Za-z]?)(?![\dA-Za-z])/gu)].map((match) => `${match[1]!.toUpperCase()} ${match[2]!.toUpperCase()}`));
  return projects.filter((project) => {
    const code = courseCodeOf(project.name) ?? courseCodeOf(project.id);
    if (code) return codes.has(code);
    const name = squash(project.name);
    return name.length >= 3 && haystack.includes(name);
  });
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
  const byName = oneCourse(projectsNamedIn(doc.fileName, projects));
  if (byName.length === 1) return { project: byName[0]!, basis: "文件名" };
  if (byName.length > 1) return undefined;
  const byHead = oneCourse(projectsNamedIn(doc.extractedText.slice(0, 1500), projects));
  return byHead.length === 1 ? { project: byHead[0]!, basis: "正文开头" } : undefined;
}

/** A part of a course (its final project, an exam) — named like the course but not the course itself. */
const COURSE_PART = /项目|作业|考试|测验|报告|论文|展示|project|homework|assignment|exam|quiz|report|paper|presentation/i;
/**
 * 「RBT610-Fall2026-Syllabus.pdf」 names both 「RBT 610 Robot Perception」 and 「RBT 610 期末项目」: the course's file belongs to the course.
 * Before, the tie left every file of that course unfiled and its tasks without material (2026-10-15 walkthrough).
 */
function oneCourse(named: KnownProject[]): KnownProject[] {
  if (named.length < 2) return named;
  const courses = named.filter((project) => !COURSE_PART.test(project.name));
  return courses.length === 1 && named.every((project) => courseCodeOf(project.name) && courseCodeOf(project.name) === courseCodeOf(courses[0]!.name)) ? courses : named;
}

/** A project an uncertain string leans towards (「课程待确认（可能为 ECE 548）」 → ECE 548): the recommended answer when the person is asked. */
export function leaningProject(project: string | undefined, projects: KnownProject[]): KnownProject | undefined {
  if (!project) return undefined;
  const named = projectsNamedIn(project, projects);
  return named.length === 1 ? named[0] : undefined;
}

/** The upload a `src-N` reference means: the N-th of the workspace's documents in upload order (the interview numbers them the same way). */
export function documentsByRef<T>(docs: T[]): Map<string, T> {
  return new Map(docs.map((doc, index) => [`src-${index + 1}`, doc]));
}

/**
 * The project name a dated item belongs to: its own project when that plainly names a known one, else the project its source file is
 * filed under (by its own evidence or by the person's answer), else none — and then the person is asked.
 */
export function itemProjectResolver(projects: KnownProject[], docs: Array<{ projectId?: string }>): (item: { project?: string; sourceRef?: string }) => string | undefined {
  const byRef = documentsByRef(docs);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return (item) => plainProject(item.project, projects)?.name ?? (() => { const id = item.sourceRef ? byRef.get(item.sourceRef)?.projectId : undefined; return id ? names.get(id) : undefined; })();
}
