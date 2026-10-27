/**
 * Which of the person's uploaded files belong to a task. A file filed under the task's project does; an unfiled one (the interview's
 * uploads sit under no project) does only when its name or opening text names the project — 「F26-ECE555-Syllabus.pdf」 for ECE 555.
 * Before this every unfiled upload was listed under every task, and an ECE 555 homework was handed the MoS₂ notes as its material.
 */
export function relevantDocuments<T extends { projectId?: string | undefined; fileName: string; extractedText?: string }>(
  docs: T[], task: { projectId: string; projectName?: string | undefined }): T[] {
  const name = squash(task.projectName ?? "");
  return docs.filter((doc) => doc.projectId ? doc.projectId === task.projectId
    : name.length >= 3 && squashedOf(doc).some((text) => text.includes(name)));
}

const squash = (text: string) => text.toLowerCase().replace(/[\s_\-·.]+/g, "");
/**
 * A document's squashed name and opening, worked out once per document object (2026-10-26): a page asks this for every task against
 * every file, and squashing the same 3000 characters 61 times over was most of a task list's time.
 */
const squashed = new WeakMap<object, { fileName: string; text: string; squashed: [string, string] }>();
function squashedOf(doc: { fileName: string; extractedText?: string }): [string, string] {
  const text = doc.extractedText ?? "";
  const kept = squashed.get(doc);
  if (kept && kept.fileName === doc.fileName && kept.text === text) return kept.squashed;
  const value: [string, string] = [squash(doc.fileName), squash(text.slice(0, 3000))];
  squashed.set(doc, { fileName: doc.fileName, text, squashed: value });
  return value;
}
