import type { TaskDetail } from "../../lib/task-detail";
import { useT } from "../locale-context";

/** Files the assistant wrote to do its work, not for the person to read (a helper script). */
const TOOLING = /\.(ps1|py|js|mjs|ts|sh|bat|cmd)$/i;

/** The assistant's files made for this task that are ready to use (its accepted results and preparation still in review). Exported for its test. */
export function preparedFiles(detail: Pick<TaskDetail, "agentOutputs">): Array<{ href: string; name: string }> {
  return detail.agentOutputs.filter((task) => task.status === "accepted" || task.status === "needs_review").flatMap((task) =>
    task.files.filter((file) => !TOOLING.test(file.name))
      .map((file) => ({ href: `/api/agent/tasks/${encodeURIComponent(task.taskId)}/file?path=${encodeURIComponent(file.path)}`, name: file.name })));
}

/**
 * What is ready for this task, where the person is about to do it (docs/review-2026-10-13.md §6.4): on every task card and on the block
 * the day panel shows, not only in a review queue. The tutorial, when one was written, opens on the task's page.
 */
export function Prepared({ detail, max = 3 }: { detail: Pick<TaskDetail, "id" | "agentOutputs" | "preparedMaterials">; max?: number }) {
  const t = useT();
  const files = preparedFiles(detail);
  const tutorial = detail.preparedMaterials.some((item) => /manual\.md$/.test(item.uri));
  if (!files.length && !tutorial) return null;
  return <p className="task-prepared"><small>{t("已备好")}</small>
    {tutorial && <a href={`/workbench/${encodeURIComponent(detail.id)}#tutorial`}>{t("教程")}</a>}
    {files.slice(0, max).map((file) => <a key={file.href} href={file.href} target="_blank" rel="noreferrer">{file.name}</a>)}
    {files.length > max && <a href={`/workbench/${encodeURIComponent(detail.id)}#materials`}>{t("另有 {{count}} 份", { count: files.length - max })}</a>}
  </p>;
}
