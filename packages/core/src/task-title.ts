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

/** The name to show: the stored short title, or — for a task written before titles existed — the first clause of its description. */
export function taskTitleOf(order: { intent: string; payload?: unknown }): string {
  const stored = (order.payload as { title?: unknown } | undefined)?.title;
  return typeof stored === "string" && stored.trim() ? stored.trim() : cleanTaskTitle(order.intent);
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
