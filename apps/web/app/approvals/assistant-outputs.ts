/**
 * How an assistant result's files are shown for review: by what they are for, never by how they were made. Scripts, caches, config and
 * the README that explains them are the assistant's own scaffolding and are left out; a reusable workflow (a `SKILL.md` with its
 * `workflow.json`) is one entry described in words with its steps, never by file name; a Markdown source written beside a Word or PDF
 * file of the same name is that file's preview, not a second deliverable. Pure, so the grouping is tested without a task directory.
 */

/** The groups' Chinese names are their keys (and their labels, translated where they are shown: `t(entry.group)`). */
export type OutputGroup = "成品" | "材料目录" | "文件台账" | "缺口清单";
export const OUTPUT_GROUPS: OutputGroup[] = ["成品", "材料目录", "文件台账", "缺口清单"];
export type OutputItem = {
  path: string; name: string; purpose: string; group: OutputGroup;
  /** `markdown` and `table` get a preview read from `previewPath`. */
  preview: "markdown" | "table" | "image" | "none"; previewPath?: string;
};
export type GroupedOutputs = {
  groups: Array<{ group: OutputGroup; items: OutputItem[] }>;
  /** The reusable workflow, when the run made one: where its manifest is, and what its SKILL.md says it is. */
  workflow?: { manifestPath?: string; purpose: string };
  /** Technical files left out. */
  hidden: number;
};

const TECH_EXT = /\.(py|pyc|pyo|js|mjs|cjs|ts|ps1|psm1|sh|bat|cmd|json|ya?ml|toml|ini|cfg|conf|lock|log|env|map|tmp)$/i;
const TECH_DIR = /(^|\/)(__pycache__|node_modules|\.git|\.venv|venv|scripts|\.cache|tests?)(\/|$)/i;
const README = /(^|\/)readme(\.[a-z]+)?$/i;
const WORKFLOW = /(^|\/)(SKILL\.md|workflow\.json)$/i;
const DOC_EXT = /\.(docx?|pdf|pptx?|xlsx?|odt)$/i;

const ext = (file: string) => /\.[^./]+$/.exec(file)?.[0].toLowerCase() ?? "";
const stem = (file: string) => file.replace(/\.[^./]+$/, "");
const base = (file: string) => file.split("/").pop() ?? file;

/** The assistant names and describes its files in the language it works in, so each group is read in both. */
function groupOf(path: string, purpose: string): OutputGroup {
  const text = `${path} ${purpose}`;
  if (/缺口|缺项|gaps?\b|missing/i.test(text)) return "缺口清单";
  if (/台账|inventory|ledger|登记表|register\b/i.test(text)) return "文件台账";
  if (/目录|catalog|索引|\bindex\b|table of contents/i.test(text)) return "材料目录";
  return "成品";
}

export function groupOutputs(artifacts: Array<{ path: string; purpose: string }>): GroupedOutputs {
  const files = artifacts.map((item) => ({ ...item, path: item.path.replace(/\\/g, "/") }));
  let hidden = 0;
  let workflow: GroupedOutputs["workflow"];
  const shown: Array<{ path: string; purpose: string }> = [];
  for (const file of files) {
    if (WORKFLOW.test(file.path)) {
      workflow ??= { purpose: "" };
      if (/workflow\.json$/i.test(file.path)) workflow.manifestPath = file.path;
      else workflow.purpose = file.purpose;
      continue;
    }
    if (README.test(file.path) || TECH_DIR.test(file.path) || (TECH_EXT.test(file.path) && ext(file.path) !== ".csv")) { hidden += 1; continue; }
    shown.push(file);
  }
  // A Markdown source beside a document of the same name: the document is the deliverable, the source its preview.
  const documents = new Set(shown.filter((file) => DOC_EXT.test(file.path)).map((file) => stem(base(file.path))));
  const sources = new Map(shown.filter((file) => ext(file.path) === ".md" && documents.has(stem(base(file.path)))).map((file) => [stem(base(file.path)), file.path]));
  const items: OutputItem[] = shown.filter((file) => !(ext(file.path) === ".md" && documents.has(stem(base(file.path))))).map((file) => {
    const kind = ext(file.path);
    const source = sources.get(stem(base(file.path)));
    const preview: OutputItem["preview"] = kind === ".md" || kind === ".txt" ? "markdown" : kind === ".csv" ? "table"
      : /\.(png|jpe?g|gif|webp)$/.test(kind) ? "image" : source ? "markdown" : "none";
    return { path: file.path, name: stem(base(file.path)), purpose: file.purpose, group: groupOf(file.path, file.purpose), preview,
      ...(preview === "none" ? {} : { previewPath: preview === "markdown" && source ? source : file.path }) };
  });
  const groups = OUTPUT_GROUPS.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((entry) => entry.items.length);
  return { groups, ...(workflow ? { workflow } : {}), hidden };
}

/** The opening of a Markdown file: its first lines, cut at a line boundary. */
export function markdownHead(text: string, lines = 10, chars = 700): { text: string; more: boolean } {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  const head: string[] = [];
  let length = 0;
  for (const line of all) {
    if (head.length >= lines || length + line.length > chars) break;
    head.push(line); length += line.length + 1;
  }
  return { text: head.join("\n").trim(), more: all.slice(head.length).some((line) => line.trim()) };
}

/** A CSV's first rows and columns, quotes respected, for a table preview. */
export function csvHead(text: string, rows = 5, columns = 5): { header: string[]; rows: string[][]; totalRows: number; totalColumns: number } {
  const records: string[][] = [];
  let field = "", record: string[] = [], quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      record.push(field); field = "";
      if (record.some((cell) => cell.trim())) records.push(record);
      record = [];
    } else field += char;
  }
  record.push(field);
  if (record.some((cell) => cell.trim())) records.push(record);
  const [header = [], ...rest] = records;
  const width = Math.max(header.length, ...rest.map((row) => row.length), 0);
  return { header: header.slice(0, columns), rows: rest.slice(0, rows).map((row) => row.slice(0, columns)), totalRows: rest.length, totalColumns: width };
}

/** A workflow manifest's steps, read leniently: whatever cannot be read is left out. */
export function workflowSteps(manifest: unknown): { name: string; summary: string; steps: Array<{ title: string; by: "assistant" | "person" }> } {
  const value = (manifest && typeof manifest === "object" ? manifest : {}) as { name?: unknown; summary?: unknown; steps?: unknown };
  const steps = Array.isArray(value.steps) ? value.steps.flatMap((step) => {
    const item = step as { title?: unknown; by?: unknown };
    return typeof item?.title === "string" && item.title.trim() ? [{ title: item.title.trim(), by: item.by === "person" ? "person" as const : "assistant" as const }] : [];
  }) : [];
  return { name: typeof value.name === "string" ? value.name : "", summary: typeof value.summary === "string" ? value.summary : "", steps };
}
