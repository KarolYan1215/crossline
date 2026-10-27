import "server-only";
import { AUTOMATIONS_SETTING, readAutomations, type AccessContext } from "@crossline/core";
import { listAgentTasks, type AgentTaskRow } from "@crossline/db";
import { groupOutputs } from "../app/approvals/assistant-outputs";
import { readTaskFile } from "./agent";
import { getStore } from "./crossline";
import { identityLines } from "./lines";
import { tOf } from "./locale";
import { zipStream, type ZipEntry } from "./zip";

/**
 * The assistant's output folder on the hosted beta (2026-10-19, the owner's decision: 「写到附属文件夹，允许通过浏览器下载」). Nothing is
 * copied: every finished run already keeps its files in its own task directory, so the folder is a view over them — by line, then by task
 * — of what each run handed over (helper scripts, caches and the run's own records left out by the review page's own grouping). A file is
 * downloaded through the task's file route; a task, a line or everything comes as one zip.
 */
export type OutputFile = { path: string; name: string; bytes: number; href: string };
export type OutputTask = { taskId: string; title: string; at: string; status: "accepted" | "needs_review"; partial: boolean; files: OutputFile[] };
export type OutputLine = { id: string; label: string; tasks: OutputTask[] };
export type OutputFolder = { lines: OutputLine[]; files: number; bytes: number };

/** The most one zip carries: past it the person downloads by line or by task. */
export const ZIP_MAX_FILES = 400;
export const ZIP_MAX_BYTES = 300 * 1024 * 1024;
const ZIP_FILE_LIMIT = 60 * 1024 * 1024;
const OTHER = "other";

/** Runs that handed something over: accepted or waiting for the person, never a workflow being grown or one turned down. */
const delivered = (row: AgentTaskRow) => (row.status === "accepted" || row.status === "needs_review") && !row.taskId.startsWith("grow-") && row.artifacts.length > 0;

export function outputFolder(ctx: AccessContext): OutputFolder {
  const store = getStore();
  const lines = identityLines(ctx).map((line) => ({ id: line.id, label: line.label }));
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order.identityId]));
  const automations = readAutomations(store.getSetting(ctx.workspaceId, AUTOMATIONS_SETTING));
  // An automation's run is named `<automation id>-<time>`: it belongs to that automation's line.
  const lineOf = (row: AgentTaskRow) => orders.get(row.workOrderId)
    ?? automations.find((automation) => row.taskId.startsWith(`${automation.id}-`))?.lineId ?? OTHER;
  const byLine = new Map<string, OutputTask[]>();
  let files = 0, bytes = 0;
  for (const row of listAgentTasks(store, ctx.workspaceId).filter(delivered)) {
    const sizes = new Map(row.artifacts.map((item) => [item.path.replace(/\\/g, "/"), item.bytes]));
    const shown = groupOutputs(row.artifacts.map((item) => ({ path: item.path, purpose: "" }))).groups.flatMap((group) => group.items);
    if (!shown.length) continue;
    const task: OutputTask = { taskId: row.taskId, title: row.title, at: row.requestedAt, status: row.status as OutputTask["status"], partial: row.partial,
      files: shown.map((item) => ({ path: item.path, name: item.path.split("/").pop() ?? item.path, bytes: sizes.get(item.path) ?? 0,
        href: `/api/agent/tasks/${encodeURIComponent(row.taskId)}/file?path=${encodeURIComponent(item.path)}&download=1` })) };
    const line = lineOf(row);
    byLine.set(line, [...(byLine.get(line) ?? []), task]);
    files += task.files.length;
    bytes += task.files.reduce((sum, file) => sum + file.bytes, 0);
  }
  const known = new Set(lines.map((line) => line.id));
  const result: OutputLine[] = [...lines, { id: OTHER, label: tOf(ctx)("其他") }]
    .map((line) => ({ ...line, tasks: byLine.get(line.id) ?? [] }))
    // A line id the workspace no longer has is shown under 「其他」 rather than dropped.
    .map((line) => line.id === OTHER ? { ...line, tasks: [...line.tasks, ...[...byLine].filter(([id]) => id !== OTHER && !known.has(id)).flatMap(([, tasks]) => tasks)] } : line)
    .filter((line) => line.tasks.length);
  return { lines: result, files, bytes };
}

/** A folder name a file system takes: no separators or control characters, not empty. */
const folderName = (text: string, unnamed: string) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || unnamed;

/**
 * The zip of one task, one line or everything (`scope`): folders 「主线/日期 任务/文件」. Refused (undefined) when nothing is in it, and cut
 * short of the limits with `truncated` so the person knows to download a smaller part.
 */
export function outputZip(ctx: AccessContext, scope: { taskId?: string; lineId?: string }):
  { stream: ReadableStream<Uint8Array>; fileName: string; truncated: boolean } | undefined {
  const folder = outputFolder(ctx);
  const lines = folder.lines.filter((line) => !scope.lineId || line.id === scope.lineId)
    .map((line) => ({ ...line, tasks: line.tasks.filter((task) => !scope.taskId || task.taskId === scope.taskId) }))
    .filter((line) => line.tasks.length);
  if (!lines.length) return undefined;
  const unnamed = tOf(ctx)("未命名");
  const entries: ZipEntry[] = [];
  let bytes = 0, truncated = false;
  for (const line of lines) for (const task of line.tasks) for (const file of task.files) {
    if (entries.length >= ZIP_MAX_FILES || bytes + file.bytes > ZIP_MAX_BYTES) { truncated = true; continue; }
    bytes += file.bytes;
    const prefix = scope.taskId ? "" : `${folderName(line.label, unnamed)}/${task.at.slice(0, 10)} ${folderName(task.title, unnamed)}/`;
    entries.push({ name: `${prefix}${file.path}`, modified: new Date(task.at), read: () => readTaskFile(ctx, task.taskId, file.path, ZIP_FILE_LIMIT)?.body });
  }
  const only = scope.taskId ? lines[0]!.tasks[0]!.title : scope.lineId ? lines[0]!.label : tOf(ctx)("助手产出");
  return { stream: zipStream(entries), fileName: `${folderName(only, unnamed)}.zip`, truncated };
}
