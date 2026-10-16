/**
 * A task's name (decided 2026-10-08): a short action that starts with its verb — 「完成 ECE 555 作业 2」「整理 ECE 548 复习提纲」 — used
 * wherever the task is named (cards, the calendar, lists). The sentence that says what exactly is to be done stays as the description
 * (`intent`) and is written freely. Milestones are achieved states; long-term goals are 「成为 ___ 的 <身份>」.
 */
export const TASK_TITLE_MAX = 24;

/** A name as kept: one line, no closing punctuation, at most `TASK_TITLE_MAX` characters (cut at a clause boundary when it can be). */
export function cleanTaskTitle(value: string): string {
  const line = value.replace(/\s+/g, " ").trim().replace(/[。．.；;，,！!]+$/u, "");
  if (line.length <= TASK_TITLE_MAX) return line;
  const clause = line.split(/[，,；;：:。]/u)[0]!.trim();
  return (clause.length >= 4 && clause.length <= TASK_TITLE_MAX ? clause : line.slice(0, TASK_TITLE_MAX)).trim();
}

/**
 * The course code a project names, normalised (「ECE 555」 from 「ECE 555」, 「ece555」 or 「ECE555 Digital Circuits」), or undefined. A
 * project the extraction itself marked uncertain (「课程待确认（可能为 ECE 548）」) names no course: guessing it into every title would
 * spread the guess.
 */
export function courseCodeOf(project: string | undefined): string | undefined {
  if (!project || /待确认|可能|未定|不确定|[?？]|\b(tbd|tbc|to be confirmed|possibly|maybe|probably|perhaps|unsure|uncertain|unconfirmed)\b/iu.test(project)) return undefined;
  const match = /(?:^|[^A-Za-z])([A-Za-z]{2,5})\s?(\d{3,4}[A-Za-z]?)(?![\dA-Za-z])/u.exec(project);
  return match ? `${match[1]!.toUpperCase()} ${match[2]!.toUpperCase()}` : undefined;
}

/**
 * A name that says which course it is about (decided 2026-10-08: 「课堂期末考试」 on the calendar named no course, and two courses each have
 * one). When the item belongs to a project with a course code and its name does not already carry it, the code goes in front.
 */
export function withCourse(title: string, project: string | undefined): string {
  const code = courseCodeOf(project);
  if (!code || !title) return title;
  const squash = (text: string) => text.replace(/\s+/g, "").toUpperCase();
  return squash(title).includes(squash(code)) ? title : `${code} ${title}`;
}

/**
 * The name to show: the stored short title, or — for a task written before titles existed — the first clause of its description; with
 * the course code in front when the task belongs to a course and its name leaves it out.
 */
export function taskTitleOf(order: { intent: string; payload?: unknown; projectId?: string }): string {
  const stored = (order.payload as { title?: unknown } | undefined)?.title;
  return withCourse(typeof stored === "string" && stored.trim() ? stored.trim() : cleanTaskTitle(order.intent), order.projectId);
}

/** The titler's answer (Skill `crossline-task-titler`): a short name for each task it was given, by id. */
export type TaskTitles = { titles: Array<{ id: string; title: string }> };
export const TASK_TITLES_SCHEMA = { type: "object", additionalProperties: false, required: ["titles"], properties: {
  titles: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["id", "title"], properties: {
    id: { type: "string", minLength: 1, maxLength: 128 }, title: { type: "string", minLength: 1, maxLength: 60 } } } } } } as const;

/** Keeps a name for each known task (cleaned to the title rule); unknown ids and empty names are dropped, never refused. */
export function validateTaskTitles(value: unknown, ids: string[]): TaskTitles {
  const answer = value as TaskTitles | undefined;
  if (!answer || !Array.isArray(answer.titles)) throw new Error("TASK_TITLES_SCHEMA_INVALID");
  const known = new Set(ids);
  return { titles: answer.titles.filter((item) => item && known.has(item.id)).map((item) => ({ id: item.id, title: cleanTaskTitle(String(item.title ?? "")) }))
    .filter((item) => item.title) };
}
