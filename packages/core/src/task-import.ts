/**
 * Bringing the lists someone kept in another tool into Crossline on their first day (docs/personal-agent.md §9, 2026-10-28, the owner's
 * decision): Todoist and TickTick by a personal API token, a Notion database by an internal integration token, and anything else as pasted
 * text, a CSV export or a screenshot. What is read is parsed here by code into `ImportItem`s; one cheap model run sorts a few dozen at a
 * time (`crossline-import-triage`: which line, done already, gone stale, a duplicate of a task on the board, keep / merge / done / drop /
 * someday); the person then sees every item on one screen, grouped by line, with the suggestion ticked, and confirms once. Only what they
 * keep becomes a capture (`import-<source>-<id>`), which the capture analysis then turns into a task proposal like anything typed.
 *
 * Tokens live only in the worker's secret store (`import-<sourceId>`); the ledger keeps the source, a label and the last read
 * (`IMPORT_SOURCES_SETTING`). Items already brought in are remembered by their service's own id (`IMPORT_SEEN_SETTING`), so a daily read
 * and a reconnect never import the same task twice.
 */
import { comparePair, type MergeTask } from "./task-merge";

export const IMPORT_SOURCES_SETTING = "import.sources";
/** Batches read and sorted, waiting for the person's one confirmation (at most `IMPORT_BATCHES_KEEP`). */
export const IMPORT_BATCHES_SETTING = "import.batches";
/** External ids already brought in or set aside, per kind of service (`todoist:<id>`): never offered again. */
export const IMPORT_SEEN_SETTING = "import.seen";
export const IMPORT_BATCHES_KEEP = 5;
/** One batch holds at most this many items: a bigger list is cut, the rest offered with the next read. */
export const IMPORT_BATCH_MAX = 300;
/** Items one triage run sorts: a list of two hundred costs five runs, never two hundred. */
export const IMPORT_TRIAGE_CHUNK = 40;
/** A connected tool is read again this often when the person left the daily read on. */
export const IMPORT_DAILY_HOURS = 20;
/** Lines a daily read may put in the inbox by itself; the rest wait in a batch for the person. */
export const IMPORT_DAILY_CAPTURES = 10;

export type ImportServiceKind = "todoist" | "ticktick" | "notion";
export type ImportKind = ImportServiceKind | "text" | "csv" | "image";
export const IMPORT_SERVICE_KINDS: readonly ImportServiceKind[] = ["todoist", "ticktick", "notion"];
export const IMPORT_KIND_LABEL: Record<ImportKind, string> = { todoist: "Todoist", ticktick: "TickTick", notion: "Notion", text: "粘贴的清单", csv: "CSV 文件", image: "截图" };

export type ImportSource = {
  id: string; kind: ImportServiceKind; label: string; addedAt: string;
  /** Notion only: the database read, and its title as Notion shows it. */
  databaseId?: string; databaseTitle?: string;
  /** New items are read once a day (default on). */
  daily: boolean;
  /** Todoist only: finishing an imported task in Crossline closes it in Todoist (default off). */
  writeBack: boolean;
  lastReadAt?: string; lastItems?: number; lastError?: string;
};

/** One item as read from its tool, before anyone judged it. `due` is YYYY-MM-DD or ""; `list` is the project or list it sat in. */
export type ImportItem = { kind: ImportKind; externalId: string; title: string; notes: string; due: string; labels: string[]; list: string; done: boolean; createdAt: string };

export type ImportDecision = "keep" | "merge" | "done" | "drop" | "someday";
export const IMPORT_DECISION_LABEL: Record<ImportDecision, string> = { keep: "收进来", merge: "并入已有任务", done: "已做完", drop: "已失效", someday: "以后再说" };
export type ImportSuggestion = { decision: ImportDecision; lineId: string; project: string; due: string; duplicateOf: string; duplicateTitle: string; why: string };
export type ImportBatchItem = ImportItem & { key: string; suggestion: ImportSuggestion };
export type ImportBatch = {
  id: string; kind: ImportKind; sourceId: string; label: string; createdAt: string;
  state: "sorting" | "ready";
  /** Whether a model sorted it; false means only the rules did (no model connected, quota, a failed run) and every item is offered as kept. */
  sorted: boolean;
  /** Items left for the next read because the batch was full. */
  more: number;
  items: ImportBatchItem[];
};

export const readImportSources = (raw: string | null | undefined): ImportSource[] => {
  try { const parsed = JSON.parse(raw ?? "[]") as ImportSource[]; return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : []; }
  catch { return []; }
};
export const readImportBatches = (raw: string | null | undefined): ImportBatch[] => {
  try { const parsed = JSON.parse(raw ?? "[]") as ImportBatch[]; return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string" && Array.isArray(item.items)) : []; }
  catch { return []; }
};
export const readImportSeen = (raw: string | null | undefined): Record<string, string[]> => {
  try { const parsed = JSON.parse(raw ?? "{}") as Record<string, string[]>; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
};
/** The key an item is remembered by: services have their own global ids; pasted lines and files by their content. */
export const seenKey = (item: Pick<ImportItem, "kind" | "externalId">) => `${item.kind}:${item.externalId}`;
export const importSecretName = (sourceId: string) => `import-${sourceId}`;
/** The capture an imported item becomes; also the work order's id once the analysis promotes it. */
export const importCaptureId = (item: Pick<ImportItem, "kind" | "externalId">) => `import-${item.kind}-${item.externalId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`;
/** The service and id behind a capture or work order this importer wrote, or undefined. */
export function importOrigin(id: string): { kind: ImportKind; externalId: string } | undefined {
  const match = /^import-(todoist|ticktick|notion|text|csv|image)-(.+)$/.exec(id);
  return match ? { kind: match[1] as ImportKind, externalId: match[2]! } : undefined;
}

/** FNV-1a over a string, twice (forwards and backwards), as a short stable id: core also runs in the browser, so no crypto here. */
export function contentId(text: string): string {
  let forward = 0x811c9dc5, backward = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    forward = Math.imul(forward ^ text.charCodeAt(index), 0x01000193) >>> 0;
    backward = Math.imul(backward ^ text.charCodeAt(text.length - 1 - index), 0x01000193) >>> 0;
  }
  return `${forward.toString(36)}${backward.toString(36)}`;
}

/**
 * A day as YYYY-MM-DD in `timeZone`: a bare date is taken as it is, a date-time (`2026-11-03T03:00:00+0000`, TickTick's form, or ISO) is
 * read as that instant in the person's zone, since an all-day task stored at local midnight would otherwise fall on the day before.
 */
export function importDay(value: unknown, timeZone = "UTC"): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2").replace(" ", "T");
  const at = Date.parse(normalized);
  if (Number.isNaN(at)) return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  } catch { return new Date(at).toISOString().slice(0, 10); }
}

const obj = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const str = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const strings = (value: unknown) => (Array.isArray(value) ? value.map(str).filter(Boolean).slice(0, 12) : []);
const clean = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Todoist's API v1 tasks (`GET /api/v1/tasks`, every page) with its projects (`GET /api/v1/projects`). A task's `due.date` is its day,
 * `deadline.date` the day it must be done by, which wins when both are set; sub-tasks are kept as their own items.
 */
export function itemsFromTodoist(tasks: unknown[], projects: unknown[] = [], timeZone = "UTC"): ImportItem[] {
  const names = new Map(projects.map((project) => [str(obj(project).id), str(obj(project).name)]));
  return tasks.map(obj).filter((task) => str(task.id) && str(task.content).trim()).map((task) => {
    const due = importDay(obj(task.deadline).date, timeZone) || importDay(obj(task.due).datetime, timeZone) || importDay(obj(task.due).date, timeZone);
    return { kind: "todoist" as const, externalId: str(task.id), title: clean(str(task.content), 240), notes: clean(str(task.description), 600), due,
      labels: strings(task.labels), list: names.get(str(task.project_id)) ?? "", done: task.checked === true || task.is_completed === true,
      createdAt: str(task.added_at) || str(task.created_at) };
  });
}

/**
 * TickTick's Open API: each project's undone tasks (`GET /open/v1/project/{id}/data`, the inbox as `inbox`). `status` 2 is done and -1
 * abandoned; `dueDate` is `yyyy-MM-dd'T'HH:mm:ssZ`.
 */
export function itemsFromTickTick(projects: Array<{ name: string; tasks: unknown[] }>, timeZone = "UTC"): ImportItem[] {
  return projects.flatMap((project) => project.tasks.map(obj).filter((task) => str(task.id) && str(task.title).trim()).map((task) => ({
    kind: "ticktick" as const, externalId: str(task.id), title: clean(str(task.title), 240), notes: clean(str(task.content) || str(task.desc), 600),
    due: importDay(task.dueDate, timeZone), labels: strings(task.tags), list: project.name, done: task.status === 2 || task.status === -1,
    createdAt: str(task.createdTime) })));
}

/** The text of a Notion property, whatever its type (title, rich text, select, status, number, date, …). */
function notionText(property: Record<string, unknown>): string {
  const type = str(property.type);
  const value = property[type];
  if (Array.isArray(value)) return value.map((part) => str(obj(part).plain_text) || str(obj(part).name)).join("");
  if (type === "select" || type === "status") return str(obj(value).name);
  if (type === "date") return str(obj(value).start);
  if (type === "checkbox") return value === true ? "true" : "";
  return str(value);
}
const DONE_WORDS = /^(done|complete|completed|finished|closed|archived|已完成|完成|已做完|结束|已结束)$/i; // i18n-ignore: compared with what the person wrote in Notion
/**
 * A Notion database's pages (`POST /v1/databases/{id}/query`): the title property is the item, the first date property its day, a
 * status, select or checkbox named like a state says whether it is done, and multi-selects are its labels.
 */
export function itemsFromNotion(pages: unknown[], timeZone = "UTC"): ImportItem[] {
  return pages.map(obj).filter((page) => str(page.id) && page.archived !== true && page.in_trash !== true).flatMap((page) => {
    const properties = Object.values(obj(page.properties)).map(obj);
    const title = properties.find((property) => property.type === "title");
    const text = title ? clean(notionText(title), 240) : "";
    if (!text) return [];
    const date = properties.find((property) => property.type === "date");
    const states = properties.filter((property) => property.type === "status" || property.type === "select");
    const checkbox = properties.find((property) => property.type === "checkbox");
    const done = states.some((property) => DONE_WORDS.test(notionText(property))) || (checkbox ? checkbox.checkbox === true : false);
    const notes = properties.filter((property) => property.type === "rich_text").map(notionText).join(" ");
    return [{ kind: "notion" as const, externalId: str(page.id).replace(/-/g, ""), title: text, notes: clean(notes, 600),
      due: date ? importDay(obj(date.date).start, timeZone) : "", labels: properties.filter((property) => property.type === "multi_select").flatMap((property) => strings((property.multi_select as unknown[] ?? []).map((option) => obj(option).name))),
      list: "", done, createdAt: str(page.created_time) }];
  });
}

const BULLET = /^\s*(?:[-*+•·▪◦–]|\d{1,3}[.)、]|[a-z][.)])\s+/i;
const BOX_OPEN = /^\s*(?:\[\s?\]|☐|□|○)\s*/;
const BOX_DONE = /^\s*(?:\[[xX✓✔]\]|☑|☒|✅|✓|✔|●)\s*/;
const ISO_DAY = /(20\d{2})-(\d{2})-(\d{2})/;
/**
 * A pasted list, or the text read off a screenshot: one item per line, bullets, numbers and check boxes taken off (a ticked box is done);
 * a short line ending in a colon, or a Markdown heading, names the list the lines under it belong to. An ISO date in a line is its day;
 * other ways of writing a day are left to the triage run, which reads the line whole.
 */
export function itemsFromText(text: string, kind: "text" | "image" = "text"): ImportItem[] {
  let list = "";
  const items: ImportItem[] = [];
  const seen = new Set<string>();
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line) ?? (/^(.{1,30})[:：]$/.exec(line) && !BULLET.test(line) ? /^(.{1,30})[:：]$/.exec(line) : null);
    if (heading) { list = clean(heading[1]!, 60); continue; }
    let body = line.replace(BULLET, "");
    const done = BOX_DONE.test(body) || /^~~.+~~$/.test(body);
    body = body.replace(BOX_DONE, "").replace(BOX_OPEN, "").replace(/^~~(.+)~~$/, "$1");
    const title = clean(body, 240);
    if (title.length < 2 || seen.has(title)) continue;
    seen.add(title);
    const day = ISO_DAY.exec(title);
    items.push({ kind, externalId: contentId(`${list}|${title}`), title, notes: "", due: day ? day[0] : "", labels: [], list, done, createdAt: "" });
  }
  return items;
}

/** CSV as rows of fields (quoted fields, doubled quotes, commas and new lines inside quotes); a BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

/* i18n-ignore-start: column names compared with the headers other tools write, never shown */
const COLUMNS = {
  title: ["title", "content", "task", "task name", "name", "subject", "任务", "标题", "内容", "名称", "待办"],
  notes: ["description", "notes", "note", "desc", "备注", "描述", "说明"],
  due: ["due date", "due", "deadline", "date", "end date", "截止日期", "截止", "日期", "到期"],
  done: ["status", "completed", "done", "is completed", "状态", "完成"],
  id: ["taskid", "task id", "id"],
  labels: ["tags", "labels", "tag", "标签"],
  list: ["list name", "project", "list", "folder name", "section", "清单", "项目", "列表"],
  type: ["type"],
  created: ["created time", "created", "date added", "创建时间"]
};
const DONE_VALUES = /^(1|2|true|yes|done|completed|complete|x|已完成|完成|是)$/i;
/* i18n-ignore-end */
/**
 * A CSV export: the first row naming a title column is the header (TickTick's backup puts a few lines of notes above it; Todoist's export
 * has a TYPE column whose `section` and `note` rows are not tasks). Unknown layouts keep the first column as the title.
 */
export function itemsFromCsv(text: string, timeZone = "UTC"): ImportItem[] {
  const rows = parseCsv(text);
  const normalized = (cell: string) => cell.trim().toLowerCase();
  const headerIndex = rows.findIndex((row) => row.some((cell) => COLUMNS.title.includes(normalized(cell))));
  const header = headerIndex >= 0 ? rows[headerIndex]!.map(normalized) : [];
  const column = (names: string[]) => { for (const name of names) { const at = header.indexOf(name); if (at >= 0) return at; } return -1; };
  const at = { title: headerIndex >= 0 ? column(COLUMNS.title) : 0, notes: column(COLUMNS.notes), due: column(COLUMNS.due), done: column(COLUMNS.done), id: column(COLUMNS.id),
    labels: column(COLUMNS.labels), list: column(COLUMNS.list), type: column(COLUMNS.type), created: column(COLUMNS.created) };
  const cell = (row: string[], index: number) => (index >= 0 ? row[index]?.trim() ?? "" : "");
  const items: ImportItem[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(headerIndex + 1)) {
    const type = cell(row, at.type).toLowerCase();
    if (type && type !== "task") continue;
    const title = clean(cell(row, at.title), 240);
    if (title.length < 2) continue;
    const list = clean(cell(row, at.list), 60);
    const externalId = cell(row, at.id).replace(/[^A-Za-z0-9_-]/g, "") || contentId(`${list}|${title}`);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    items.push({ kind: "csv", externalId, title, notes: clean(cell(row, at.notes), 600), due: importDay(cell(row, at.due), timeZone),
      labels: cell(row, at.labels).split(/[,;，、#]/).map((label) => label.trim()).filter(Boolean).slice(0, 12), list,
      done: DONE_VALUES.test(cell(row, at.done)), createdAt: cell(row, at.created) });
  }
  return items;
}

/**
 * An open task the imported item is, by the daily merge's own rules (`comparePair`): an item has no project or milestone yet, so it is
 * compared with each open task of its line (of any line while none is chosen) as if it were in that task's project. The closest match
 * wins; an unsure pair is not one.
 */
export function importDuplicateOf(item: { title: string; notes: string; lineId: string; due: string }, open: readonly MergeTask[]): MergeTask | undefined {
  let best: { task: MergeTask; score: number } | undefined;
  for (const task of open) {
    if (item.lineId && task.identityId !== item.lineId) continue;
    const candidate: MergeTask = { id: "import-candidate", identityId: task.identityId, projectId: task.projectId, milestoneId: task.milestoneId, title: item.title,
      intent: item.notes || item.title, state: "awaiting_plan_approval", dueDate: item.due, milestoneDeadline: task.milestoneDeadline, progress: 0, hasStepPlan: false,
      // Who does it is not judged yet for an imported item: it is compared on what it says, on the task's side.
      started: false, dependsOn: [], ...(task.owner ? { owner: task.owner } : {}) };
    const pair = comparePair(candidate, task);
    if (pair.verdict === "same" && (!best || pair.score > best.score)) best = { task, score: pair.score };
  }
  return best?.task;
}

export type ImportTriage = { items: Array<{ key: string; decision: ImportDecision; lineId: string; project: string; due: string; duplicateOf: string; why: string }> };
export const IMPORT_TRIAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"], properties: {
    items: { type: "array", maxItems: IMPORT_TRIAGE_CHUNK, items: { type: "object", additionalProperties: false,
      required: ["key", "decision", "lineId", "project", "due", "duplicateOf", "why"], properties: {
      key: { type: "string", maxLength: 12 },
      decision: { type: "string", enum: ["keep", "merge", "done", "drop", "someday"] },
      lineId: { type: "string", maxLength: 80 },
      project: { type: "string", maxLength: 60 },
      due: { type: "string", maxLength: 10 },
      duplicateOf: { type: "string", maxLength: 128 },
      why: { type: "string", maxLength: 120 } } } } }
} as const;

/**
 * Every item given is answered once, by its key; a line is one of the person's lines or empty; a merge names an open task shown; a day is
 * YYYY-MM-DD. Anything else is sent back with the item named.
 */
// Repair messages to the triage Skill, not interface text.
/* i18n-ignore-start */
export function validateImportTriage(value: unknown, keys: string[], lineIds: string[], taskIds: string[]): ImportTriage {
  const answer = value as ImportTriage | undefined;
  if (!answer || !Array.isArray(answer.items)) throw Object.assign(new Error("IMPORT_TRIAGE_INVALID"), { detail: "items 必须是数组" });
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of answer.items) {
    if (!keys.includes(item.key)) { problems.push(`key ${item.key} 不是这次给出的条目`); continue; }
    if (seen.has(item.key)) problems.push(`key ${item.key} 重复`);
    seen.add(item.key);
    if (item.lineId && !lineIds.includes(item.lineId)) problems.push(`key ${item.key} 的 lineId「${item.lineId}」不是本人的主线（不确定时留空）`);
    if (item.decision === "merge" && !taskIds.includes(item.duplicateOf)) problems.push(`key ${item.key} 是 merge，duplicateOf 必须是 openTasks 里的 id`);
    if (item.decision !== "merge" && item.duplicateOf) problems.push(`key ${item.key} 不是 merge，duplicateOf 留空`);
    if (item.due && !/^\d{4}-\d{2}-\d{2}$/.test(item.due)) problems.push(`key ${item.key} 的 due 要写成 YYYY-MM-DD 或留空`);
  }
  const missing = keys.filter((key) => !seen.has(key));
  if (missing.length) problems.push(`这些条目没有回答：${missing.slice(0, 10).join("、")}`);
  if (problems.length) throw Object.assign(new Error("IMPORT_TRIAGE_INVALID"), { detail: problems.slice(0, 8).join("；") });
  return answer;
}
/* i18n-ignore-end */

/** What the rules alone suggest when no model sorted the batch: done items as done, the rest kept, duplicates by `importDuplicateOf`. */
export function ruleSuggestion(item: ImportItem, lineId: string, open: readonly MergeTask[]): ImportSuggestion {
  if (item.done) return { decision: "done", lineId, project: item.list, due: item.due, duplicateOf: "", duplicateTitle: "", why: "" };
  const duplicate = importDuplicateOf({ title: item.title, notes: item.notes, lineId, due: item.due }, open);
  if (duplicate) return { decision: "merge", lineId: lineId || duplicate.identityId, project: item.list, due: item.due, duplicateOf: duplicate.id, duplicateTitle: duplicate.title, why: "" };
  return { decision: "keep", lineId, project: item.list, due: item.due, duplicateOf: "", duplicateTitle: "", why: "" };
}

/** Whether a suggestion is ticked on the confirmation screen: kept and merged items are; done, stale and someday ones are not. */
export const ticked = (decision: ImportDecision) => decision === "keep" || decision === "merge";

/**
 * Whether a pasted text looks like a list brought from somewhere else (the input box's hint 「按导入核对处理」): six or more non-empty
 * lines, most of them short or marked as list items.
 */
export function looksLikeImportList(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 6) return false;
  const listy = lines.filter((line) => BULLET.test(line) || BOX_OPEN.test(line) || BOX_DONE.test(line) || line.length <= 40).length;
  return listy / lines.length >= 0.7;
}
