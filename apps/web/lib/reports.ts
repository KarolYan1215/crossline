import "server-only";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readReportItems, REPORT_ITEMS_FILE, type AccessContext, type ReportItem } from "@crossline/core";
import { listAgentTasks, readGrownSkills, type AgentTaskRow, type CrosslineStore } from "@crossline/db";
import { readTaskFile, runFilesHere } from "./agent";
import { addCapturedTaskWithId, getStore } from "./crossline";
import { identityLines } from "./lines";

/**
 * Reports (docs/skills-library.md 「报告」): what a grown workflow's run wrote as Markdown — for the favourites topic workflow 「话题总览.md」
 * and one 「话题-<名>.md」 per topic — read as one report, with the actions it proposes (`落地.json`) beside it. A report is the run itself
 * (its id is the task id); nothing is copied. Putting an action into practice writes a capture, the same way an accepted research proposal
 * does, and the task that comes of it links back here.
 */
export type ReportDocument = { path: string; name: string; text: string };
export type ReportItemView = ReportItem & { key: string; state: "open" | "added" | "dismissed" };
export type ReportSummary = { id: string; workflowId: string; title: string; at: string; notes?: number; files: number };
export type ReportView = ReportSummary & { documents: ReportDocument[]; items: ReportItemView[]; versions: Array<{ id: string; at: string }> };

export const REPORT_ADDED_EVENT = "report.item_added";
export const REPORT_DISMISSED_EVENT = "report.item_dismissed";
const CAPTURE_PREFIX = "report-";
const MAX_DOCUMENTS = 40;
const OVERVIEW = /^话题总览\.md$/; // i18n-ignore: the file name the run writes
const TOPIC = /^话题-.+\.md$/; // i18n-ignore: the file names the run writes

/** A grown workflow's run is named `flow-<workflow id without flow->-<time>`: the longest workflow id that prefixes it owns it. */
const runPrefix = (id: string) => `flow-${id.replace(/^flow-/, "")}-`;
const isReportRun = (row: AgentTaskRow) => row.taskId.startsWith("flow-") && (row.status === "accepted" || row.status === "needs_review") && runFilesHere(row.directory);

/** The Markdown a run left, two folders deep at most, never its read-only inputs or hidden folders: overview first, then topics, then the rest. */
export function reportFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (relative: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(path.join(directory, relative)); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || (depth === 0 && name === "input")) continue;
      const inner = relative ? `${relative}/${name}` : name;
      let directoryEntry = false;
      try { directoryEntry = statSync(path.join(directory, inner)).isDirectory(); } catch { continue; }
      if (directoryEntry) { if (depth < 1) walk(inner, depth + 1); }
      else if (/\.md$/i.test(name)) found.push(inner);
    }
  };
  walk("", 0);
  const rank = (file: string) => { const name = file.split("/").pop()!; return OVERVIEW.test(name) ? 0 : TOPIC.test(name) ? 1 : 2; };
  return found.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "zh")).slice(0, MAX_DOCUMENTS);
}

/** An action's key: the workflow and the action's words, so the same action in the next version of the report keeps its decision. */
export const itemKey = (workflowOrReport: string, title: string) => createHash("sha256").update(`${workflowOrReport}\n${title}`).digest("hex").slice(0, 12);

function reportRows(store: CrosslineStore, workspaceId: string) {
  const workflows = readGrownSkills(store, workspaceId);
  const ownerOf = (taskId: string) => workflows.filter((record) => taskId.startsWith(runPrefix(record.id))).sort((a, b) => b.id.length - a.id.length)[0];
  // Newest first; the tasks come oldest first, so reversed before the (stable) sort two runs finished in the same millisecond keep the later on top.
  return listAgentTasks(store, workspaceId).filter(isReportRun).reverse()
    .map((row) => ({ row, workflow: ownerOf(row.taskId), files: reportFiles(row.directory) }))
    .filter((entry) => entry.files.length)
    .sort((a, b) => (b.row.completedAt ?? b.row.requestedAt).localeCompare(a.row.completedAt ?? a.row.requestedAt));
}

function summaryOf(entry: ReturnType<typeof reportRows>[number]): ReportSummary {
  const { row, workflow, files } = entry;
  const notes = workflow?.lastRead?.taskId === row.taskId ? workflow.lastRead.items : undefined;
  return { id: row.taskId, workflowId: workflow?.id ?? "", title: workflow?.manifest.summary || row.title, at: row.completedAt ?? row.requestedAt,
    ...(notes !== undefined ? { notes } : {}), files: files.length };
}

/** The latest report of each workflow, newest first. */
export function listReports(ctx: AccessContext): ReportSummary[] {
  const seen = new Set<string>();
  return reportRows(getStore(), ctx.workspaceId).filter((entry) => {
    const owner = entry.workflow?.id ?? entry.row.taskId;
    if (seen.has(owner)) return false;
    seen.add(owner);
    return true;
  }).map(summaryOf);
}

function decisions(store: CrosslineStore, workspaceId: string): Map<string, "added" | "dismissed"> {
  const state = new Map<string, "added" | "dismissed">();
  for (const event of store.listEvents(workspaceId, { type: [REPORT_DISMISSED_EVENT, REPORT_ADDED_EVENT] })) {
    const key = (event.payload as { key?: unknown }).key;
    // Added wins over dismissed whatever the order: the task exists.
    if (typeof key === "string" && state.get(key) !== "added") state.set(key, event.type === REPORT_ADDED_EVENT ? "added" : "dismissed");
  }
  return state;
}

export function loadReport(ctx: AccessContext, id: string): ReportView | undefined {
  const store = getStore();
  const rows = reportRows(store, ctx.workspaceId);
  const entry = rows.find((item) => item.row.taskId === id);
  if (!entry) return undefined;
  const read = (relative: string) => readTaskFile(ctx, id, relative)?.body.toString("utf8");
  const documents = entry.files.flatMap((file) => { const text = read(file); return text === undefined ? [] : [{ path: file, name: file.split("/").pop()!.replace(/\.md$/i, ""), text }]; });
  const owner = entry.workflow?.id ?? id;
  const state = decisions(store, ctx.workspaceId);
  const raw = read(REPORT_ITEMS_FILE);
  const items = (raw ? readReportItems(raw, identityLines(ctx).map((line) => line.id)) : [])
    .map((item) => { const key = itemKey(owner, item.title); return { ...item, key, state: state.get(key) ?? "open" as const }; });
  const versions = entry.workflow ? rows.filter((item) => item.workflow?.id === entry.workflow!.id && item.row.taskId !== id)
    .map((item) => ({ id: item.row.taskId, at: item.row.completedAt ?? item.row.requestedAt })) : [];
  return { ...summaryOf(entry), documents, items, versions };
}

/**
 * One action put into practice: written down as a capture (analysed like anything else the person writes down), once per action — the
 * capture id is the action's key, and the event records which report it came from so the task links back. 「不需要」 is an event too.
 */
export function decideReportItem(ctx: AccessContext, reportId: string, key: string, decision: "add" | "dismiss"):
  { ok: true; captured: boolean } | { ok: false; code: string } {
  const report = loadReport(ctx, reportId);
  const item = report?.items.find((entry) => entry.key === key);
  if (!report || !item) return { ok: false, code: "REPORT_ITEM_NOT_FOUND" };
  const store = getStore();
  const captureId = `${CAPTURE_PREFIX}${key}`;
  if (decision === "dismiss") {
    if (item.state === "open") store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `report:dismissed:${key}`,
      type: REPORT_DISMISSED_EVENT, entityId: captureId, payload: { key, reportId } });
    return { ok: true, captured: false };
  }
  if (item.state === "added" || store.listCaptures(ctx.workspaceId).some((capture) => capture.id === captureId)) return { ok: true, captured: false };
  const line = identityLines(ctx).find((entry) => entry.id === item.lineId)?.label;
  // i18n-ignore: the capture's context, read by the analysis (model context)
  const context = [item.why, item.topic ? `话题：${item.topic}` : "", line ? `主线：${line}` : "", `来自报告「${report.title}」`].filter(Boolean).join("\n");
  addCapturedTaskWithId(ctx, { title: item.title, context: context.slice(0, 500) }, captureId, captureId);
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `report:added:${key}`,
    type: REPORT_ADDED_EVENT, entityId: captureId, payload: { key, reportId, reportTitle: report.title, title: item.title } });
  return { ok: true, captured: true };
}

/** The report a task came from: its capture id is the action's (the work order keeps the capture's id when analysis promotes it). */
export function reportOfTask(store: CrosslineStore, workspaceId: string, workOrderId: string): { id: string; title: string } | undefined {
  if (!workOrderId.startsWith(CAPTURE_PREFIX)) return undefined;
  const payload = store.listEvents(workspaceId, { type: REPORT_ADDED_EVENT, entityId: workOrderId }).at(-1)?.payload as { reportId?: unknown; reportTitle?: unknown } | undefined;
  return typeof payload?.reportId === "string" ? { id: payload.reportId, title: typeof payload.reportTitle === "string" ? payload.reportTitle : "" } : undefined;
}
