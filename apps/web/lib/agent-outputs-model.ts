import type { OutputFolder, OutputLine } from "./outputs";
import type { ReportSummary } from "./reports";

/**
 * 「Agent 产出」 (2026-11-10, the owner): one page for what the agents made — the grown workflows' reports, the assistant's results and
 * the files they handed over — narrowed by source and by line. Pending results are still reviewed on 待确认; this page is where they are
 * found again afterwards. The shapes and the filtering here are plain data, so they are tested without a ledger.
 */
export const OUTPUT_SOURCES = ["workflow", "task", "file"] as const;
export type OutputSource = (typeof OUTPUT_SOURCES)[number];
export const SOURCE_LABEL: Record<OutputSource, string> = { workflow: "工作流", task: "Agent 任务", file: "文件" };

export type ReportEntry = ReportSummary & { lineId: string };
export type RunEntry = {
  taskId: string; title: string; at: string; status: "accepted" | "needs_review"; partial: boolean; lineId: string; files: number;
  /** Where its result is read: 待确认 while it waits for review, else the task it was for (none for an automation's own run). */
  href?: string;
};
export type AgentOutputs = { lines: Array<{ id: string; label: string }>; reports: ReportEntry[]; runs: RunEntry[]; folder: OutputFolder };
export type OutputFilter = { source?: OutputSource; line?: string };

/** The filter from the address (`?source=workflow|task|file&line=<id>`); anything else is ignored. */
export function parseOutputFilter(params: { [key: string]: string | string[] | undefined }): OutputFilter {
  const source = typeof params.source === "string" && (OUTPUT_SOURCES as readonly string[]).includes(params.source) ? params.source as OutputSource : undefined;
  const line = typeof params.line === "string" && params.line ? params.line : undefined;
  return { ...(source ? { source } : {}), ...(line ? { line } : {}) };
}

/** The address of the page with one part of the filter changed (`undefined` clears it). */
export function outputsHref(filter: OutputFilter, change: Partial<Record<keyof OutputFilter, string | undefined>>): string {
  const next = { ...filter, ...change };
  const query = new URLSearchParams();
  if (next.source) query.set("source", next.source);
  if (next.line) query.set("line", next.line);
  const text = query.toString();
  return text ? `/outputs?${text}` : "/outputs";
}

export type FilteredOutputs = {
  reports: ReportEntry[]; runs: RunEntry[]; files: OutputLine[];
  /** How many of each source the line filter leaves: the source chips' counts. */
  counts: Record<OutputSource, number>;
  /** The lines that have anything at all, in the workspace's order (「其他」 last): the line chips. */
  lines: Array<{ id: string; label: string }>;
};

export function filterOutputs(view: AgentOutputs, filter: OutputFilter): FilteredOutputs {
  const onLine = <T extends { lineId: string }>(items: T[]) => filter.line ? items.filter((item) => item.lineId === filter.line) : items;
  const reports = onLine(view.reports), runs = onLine(view.runs);
  const files = filter.line ? view.folder.lines.filter((line) => line.id === filter.line) : view.folder.lines;
  const counts = { workflow: reports.length, task: runs.length, file: files.reduce((sum, line) => sum + line.tasks.reduce((inner, task) => inner + task.files.length, 0), 0) };
  const used = new Set([...view.reports.map((item) => item.lineId), ...view.runs.map((item) => item.lineId), ...view.folder.lines.map((line) => line.id)]);
  const shown = (source: OutputSource) => !filter.source || filter.source === source;
  return {
    reports: shown("workflow") ? reports : [], runs: shown("task") ? runs : [], files: shown("file") ? files : [],
    counts, lines: view.lines.filter((line) => used.has(line.id))
  };
}
