/**
 * Which of the person's uploaded files belong to a task. A file filed under the task's project does; an unfiled one (the interview's
 * uploads sit under no project) does only when its name or opening text names the project — 「F26-ECE555-Syllabus.pdf」 for ECE 555.
 * Before this every unfiled upload was listed under every task, and an ECE 555 homework was handed the MoS₂ notes as its material.
 */
export function relevantDocuments<T extends { projectId?: string | undefined; fileName: string; extractedText?: string }>(
  docs: T[], task: { projectId: string; projectName?: string | undefined }): T[] {
  const squash = (text: string) => text.toLowerCase().replace(/[\s_\-·.]+/g, "");
  const name = squash(task.projectName ?? "");
  return docs.filter((doc) => doc.projectId ? doc.projectId === task.projectId
    : name.length >= 3 && (squash(doc.fileName).includes(name) || squash((doc.extractedText ?? "").slice(0, 3000)).includes(name)));
}
