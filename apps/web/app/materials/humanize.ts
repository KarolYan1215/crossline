import { spansText, type DocBlock, type Span } from "./doc-blocks";

/**
 * What the assistant wrote, made fit for a person to read (the person's direction, 2026-10-15): no local paths, no hashes, no byte
 * counts or extensions, no internal columns or codes (`source_id`, `candidate_category`, `S01`, `P0`). A file is called by its own name —
 * the uploaded file's name, found again by the hash the assistant's copy was stored under — or 「来源 1」 when nothing knows it. A table
 * keeps at most four columns a person can read, with Chinese headers; a table that is only file bookkeeping becomes one sentence. Pure,
 * so every rule is tested without a task directory.
 */

/** A 64-hex hash (lower case) or a source code such as `S01`, mapped to a readable name. */
export type Names = Record<string, string>;

const HASH = /^[0-9a-f]{16,}$/i;
const EXTENSIONS = "pdf|docx?|csv|tsv|md|markdown|txt|json|xlsx?|pptx?|png|jpe?g|gif|webp|html?|zip|py";
const stripExt = (name: string) => name.replace(new RegExp(`\\.(${EXTENSIONS})$`, "i"), "");
const baseOf = (path: string) => path.replace(/^file:\/+/i, "").split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The names this run's text needs: each uploaded file whose hash the text mentions, and each source code tied to such a hash. */
export function namesFrom(texts: string[], docs: Array<{ sha256: string; fileName: string }>): Names {
  const all = texts.join("\n");
  const names: Names = {};
  for (const doc of docs) {
    const hash = doc.sha256.toLowerCase();
    if (hash && all.toLowerCase().includes(hash)) names[hash] = stripExt(doc.fileName);
  }
  // A code is tied to a hash when one line (a ledger row, `S01:<hash>.pdf`) carries both.
  for (const line of all.split(/\r?\n/)) {
    const code = /(?:^|[\s|,，"`])(S\d{1,3})(?=[\s|,，:："`]|$)/.exec(line)?.[1];
    const hash = /[0-9a-f]{40,64}/i.exec(line)?.[0]?.toLowerCase();
    if (code && hash && names[hash] && !names[code]) names[code] = names[hash];
  }
  return names;
}

/** Reads names out of text, numbering the files nothing knows as 「来源 1」, 「来源 2」, the same number for the same file every time. */
export class Namer {
  readonly #names: Names;
  readonly #unknown = new Map<string, string>();
  constructor(names: Names = {}) { this.#names = Object.fromEntries(Object.entries(names).map(([key, value]) => [key.toLowerCase(), value])); }

  #fallback(key: string): string {
    let label = this.#unknown.get(key);
    if (!label) { label = `来源 ${this.#unknown.size + 1}`; this.#unknown.set(key, label); }
    return label;
  }

  /** A path or a file name, as the name a person knows it by. */
  file(token: string): string {
    const stem = stripExt(baseOf(token.replace(/^S\d{1,3}[:：]/, "")));
    if (HASH.test(stem)) return this.#names[stem.toLowerCase()] ?? this.#fallback(stem.toLowerCase());
    return stem;
  }

  /** A source code (`S01`): the file it stands for, else 「来源 1」 by its own number. */
  code(code: string): string {
    return this.#names[code.toLowerCase()] ?? `来源 ${Number(code.slice(1))}`;
  }

  /** A bare hash: the file's name when it is one, else nothing (a checksum says nothing to a person). */
  hash(hash: string): string {
    return this.#names[hash.toLowerCase()] ?? "";
  }
}

const WINDOWS_PATH = /`?(?:file:\/\/\/)?[A-Za-z]:[\\/][^\s"'`|，。；;、（）()<>\]]*`?/g;
const POSIX_PATH = /`?(?:file:\/\/)?\/(?:Users|home|tmp|var|mnt|private)\/[^\s"'`|，。；;、（）()<>\]]*`?/g;
const CODED_FILE = /\b(S\d{1,3})[:：]([^\s,，;；|`]+)/g;
const HASH_FILE = new RegExp(`\`?\\b[0-9a-f]{16,}\\.(?:${EXTENSIONS})\\b\`?`, "gi");
const BARE_HASH = /`?\b[0-9a-f]{16,}\b`?/gi;
const SOURCE_CODE = /\bS\d{2,3}\b/g;
const PRIORITY = /(^|[\s·|,，；;:：（(])P[0-3](?=$|[\s·|,，；;）)。])/g;
const BYTES = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\s?(?:B|KB|MB|GB|bytes|字节)\b|\b\d+(?:\.\d+)?\s?(?:KB|MB|GB|bytes|字节)\b|\b\d{3,}\s?B\b/g;
const FILE_EXT = new RegExp(`([\\w\\u4e00-\\u9fff)）\\]-])\\.(?:${EXTENSIONS})\\b`, "gi");

/** One string with every path, hash, byte count, extension and internal code replaced by what a person reads. */
export function cleanText(text: string, namer: Namer = new Namer()): string {
  return scrub(text, namer).replace(/^[\s·|,，；;:：]+|[\s·|,，；;:：]+$/g, "").trim();
}

/** `cleanText` without trimming the edges, for one run of a line whose neighbours keep their spacing. */
function scrub(text: string, namer: Namer): string {
  return text
    .replace(CODED_FILE, (_whole, _code: string, file: string) => namer.file(file))
    .replace(WINDOWS_PATH, (path) => namer.file(path.replace(/`/g, "")))
    .replace(POSIX_PATH, (path) => namer.file(path.replace(/`/g, "")))
    .replace(HASH_FILE, (file) => namer.file(file.replace(/`/g, "")))
    .replace(BARE_HASH, (hash) => namer.hash(hash.replace(/`/g, "")))
    .replace(SOURCE_CODE, (code) => namer.code(code))
    .replace(PRIORITY, "$1")
    .replace(BYTES, "")
    .replace(FILE_EXT, "$1")
    // What the removals leave behind: empty quotes and brackets, doubled separators, stray spaces.
    .replace(/(?<!`)``(?!`)|（\s*）|\(\s*\)|“\s*”/g, "")
    .replace(/([；;，,、])\s*(?=[；;，,、。]|$)/g, "")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/[ \t]{2,}/g, " ");
}

/** The first sentence of a note, at most `max` characters. */
export function firstSentence(text: string, max = 80): string {
  const sentence = text.split(/(?<=[。！？!?])|[；;]/)[0]?.trim() ?? "";
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

// ---------------------------------------------------------------------------------------------------------
// Tables

const key = (header: string) => header.toLowerCase().replace(/[\s_\-()（）]/g, "");

/** Header words a person reads, in Chinese. */
const HEADER_LABEL: Array<[RegExp, string]> = [
  [/^(filename|file|文件名?|文件名称|relativepath|path|filepath|原始路径|路径|uri|source|来源文件|matchedfiles)$/, "文件"],
  [/^(title|name|item|项|项目|名称|标题)$/, "名称"],
  [/^(category|type|kind|类别|类型)$/, "类别"],
  [/^(status|accessstatus|state|状态|读取状态)$/, "状态"],
  [/^(date|日期)$/, "日期"],
  [/^(deadline|due|duedate|截止|截止日期)$/, "截止"],
  [/^(lectures?|讲次)$/, "讲次"],
  [/^(evidence|依据|证据)$/, "依据"],
  [/^(gaps?|缺口)$/, "缺口"],
  [/^(nextaction|nextstep|action|下一步)$/, "下一步"],
  [/^(notes?|remarks?|备注)$/, "备注"],
  [/^(description|summary|说明|摘要)$/, "说明"],
  [/^(topic|主题)$/, "主题"],
  [/^(owner|负责人)$/, "负责人"],
  [/^(pages?|页码|页数)$/, "页码"]
];
const FILE_COLUMN = /^(filename|file|文件名?|文件名称|relativepath|path|filepath|原始路径|路径|uri|source|来源文件|matchedfiles)$/;
const PREFERRED_FILE = /^(filename|文件名|文件名称|file|文件)$/;
/** Columns only the assistant's bookkeeping needs. */
const TECH_COLUMN = /^(id|sourceid|来源编号|编号|candidatecategory|候选类别|extension|ext|扩展名|bytes|size|大小|filesize|sha256|sha-?256|hash|checksum|校验和?|modified(utc)?|mtime|modifiedtime|修改时间(utc)?|createdat|created|duplicategroup|重复组|error|errors|错误|priority|优先级|researchlink|研究关联|研究主线关联)$/;
const STATUS_COLUMN = /^(status|accessstatus|state|状态|读取状态)$/;
const TECH_VALUE = /^([0-9a-f]{16,}|\.[a-z0-9]{1,5}|\d+|\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?|[A-Z]{1,4}\d{1,3}|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+|P[0-3])$/;

export type Status = "可访问" | "缺" | "待核验";

/** A status cell as one of three words, or nothing when it is not a status. */
export function statusOf(value: string): Status | undefined {
  const text = value.trim();
  if (/^(可访问|可读取|已读取|已有|有|已取得|已完成|完成|done|ok|yes|available|readable|accessible|✓|✔|☑)/i.test(text)) return "可访问";
  if (/^(待|未核[实验]|未确认|pending|unverified|unknown|tbd|部分)/i.test(text)) return "待核验";
  if (/^(缺|未有|无|未取得|missing|no\b|absent|✗|✘|☐)/i.test(text)) return "缺";
  return undefined;
}

const COUNT = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十"];
const count = (n: number) => (n <= 10 ? `${COUNT[n]}份` : `${n} 份`);

export type HumanTable = { kind: "table"; header: string[]; rows: string[][]; total: number } | { kind: "summary"; text: string };

/**
 * A table as a person reads it: the bookkeeping columns gone (ids, codes, paths but one, sizes, extensions, hashes, times, error and
 * priority columns, and any column whose every value is such a thing), the file column named by the file's own name, at most four
 * columns with Chinese headers. A table that was only about files — their names and whether they open — is one sentence instead.
 */
export function humanTable(header: string[], rows: string[][], namer: Namer = new Namer(), max = 4): HumanTable {
  const width = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const keys = Array.from({ length: width }, (_, column) => key(header[column] ?? ""));
  const valuesOf = (column: number) => rows.map((row) => (row[column] ?? "").trim()).filter(Boolean);
  const fileColumns = keys.map((name, column) => ({ name, column })).filter((entry) => FILE_COLUMN.test(entry.name));
  const fileColumn = (fileColumns.find((entry) => PREFERRED_FILE.test(entry.name)) ?? fileColumns[0])?.column;
  const kept: number[] = [];
  for (let column = 0; column < width; column += 1) {
    if (column === fileColumn) { kept.push(column); continue; }
    if (FILE_COLUMN.test(keys[column]!) || TECH_COLUMN.test(keys[column]!)) continue;
    const values = valuesOf(column);
    // A column a header names for a person (页码, 日期) is kept even when its values are bare numbers.
    const named = HEADER_LABEL.some(([pattern]) => pattern.test(keys[column]!));
    if (!values.length || (!named && values.every((value) => TECH_VALUE.test(value)))) continue;
    kept.push(column);
  }
  const cell = (row: string[], column: number) => column === fileColumn ? namer.file((row[column] ?? "").replace(/[`"']/g, "").trim()) : cleanText(row[column] ?? "", namer);
  const statusColumn = kept.find((column) => STATUS_COLUMN.test(keys[column]!));
  const others = kept.filter((column) => column !== fileColumn && column !== statusColumn);

  if (fileColumn !== undefined && !others.length) {
    const files = rows.map((row) => cell(row, fileColumn)).filter(Boolean);
    const states = statusColumn === undefined ? [] : rows.map((row) => statusOf(row[statusColumn] ?? ""));
    const listed = files.length && files.length <= 4 ? `：${files.join("、")}` : "";
    if (states.length && states.every((state) => state === "可访问")) return { kind: "summary", text: `${count(files.length)}文件均可读取${listed}。` };
    if (states.some(Boolean)) {
      const tally = (["可访问", "待核验", "缺"] as const).map((state) => [state, states.filter((item) => item === state).length] as const).filter(([, n]) => n);
      return { kind: "summary", text: `${count(files.length)}文件${listed}；${tally.map(([state, n]) => `${state === "可访问" ? "可读取" : state === "缺" ? "缺" : "待核验"} ${n} 份`).join("，")}。` };
    }
    return { kind: "summary", text: `${count(files.length)}文件${listed}。` };
  }
  if (!kept.length) return { kind: "summary", text: `${rows.length} 行记录均为文件校验信息，不在此列出。` };

  const order = [...(fileColumn !== undefined ? [fileColumn] : []), ...kept.filter((column) => column !== fileColumn)].slice(0, max);
  // A header the assistant already wrote in Chinese is kept as written; an English one is given its Chinese word.
  const label = (column: number) => {
    const raw = header[column] ?? "";
    if (column === fileColumn) return "文件";
    if (/[一-鿿]/.test(raw)) return cleanText(raw, namer);
    return HEADER_LABEL.find(([pattern]) => pattern.test(keys[column]!))?.[1] ?? cleanText(raw, namer);
  };
  const out = rows.map((row) => order.map((column) => cell(row, column))).filter((row) => row.some(Boolean));
  return { kind: "table", header: order.map(label), rows: out, total: out.length };
}

/**
 * A list of gaps or checks as rows of a short title, a status and one sentence — never the raw run of fields the assistant keeps per
 * row. The columns are found by their headers (title, status, gap or description); without a recognisable status the row has none.
 */
export function gapRows(header: string[], rows: string[][], namer: Namer = new Namer()): Array<{ label: string; status?: Status; note?: string }> {
  const keys = header.map(key);
  const find = (pattern: RegExp) => keys.findIndex((name) => pattern.test(name));
  const status = find(STATUS_COLUMN);
  const title = find(/^(title|name|item|项|项目|名称|标题|requirement|要求)$/);
  const note = [find(/^(gaps?|缺口)$/), find(/^(description|summary|说明|摘要|notes?|备注|remarks?)$/), find(/^(nextaction|nextstep|action|下一步)$/), find(/^(evidence|依据|证据)$/)]
    .find((column) => column >= 0);
  const label = title >= 0 ? title : keys.findIndex((name, column) => column !== status && !TECH_COLUMN.test(name) && !FILE_COLUMN.test(name)
    && rows.some((row) => (row[column] ?? "").trim() && !TECH_VALUE.test((row[column] ?? "").trim())));
  return rows.flatMap((row) => {
    const name = cleanText(row[label] ?? "", namer);
    if (!name) return [];
    const state = status >= 0 ? statusOf(row[status] ?? "") : undefined;
    const said = note !== undefined && note >= 0 ? firstSentence(cleanText(row[note] ?? "", namer)) : "";
    return [{ label: name, ...(state ? { status: state } : {}), ...(said ? { note: said } : {}) }];
  });
}

// ---------------------------------------------------------------------------------------------------------
// Whole documents

const pipeCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const PIPE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Markdown text with the same cleaning, kept as Markdown (for the places that draw it with `Markdown`): each line scrubbed in place,
 * each pipe table rebuilt through `humanTable` — or replaced by its one sentence.
 */
export function humanizeMarkdown(text: string, namer: Namer = new Namer()): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes("|") && PIPE_RULE.test(lines[index + 1] ?? "")) {
      const header = pipeCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) rows.push(pipeCells(lines[index++]!));
      index -= 1;
      const table = humanTable(header, rows, namer);
      if (table.kind === "summary") out.push(table.text);
      else out.push(`| ${table.header.join(" | ")} |`, `|${table.header.map(() => "---").join("|")}|`, ...table.rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "／")).join(" | ")} |`));
      continue;
    }
    out.push(scrub(line, namer));
  }
  return out.join("\n");
}

/** A run of text cleaned in place; a code mark is dropped once its path has become a name. */
function cleanSpans(spans: Span[], namer: Namer): Span[] {
  return spans.flatMap((span) => {
    const text = scrub(span.text, namer);
    if (!text.trim()) return [];
    if (text === span.text) return [span];
    const { code: _code, ...rest } = span;
    return [{ ...rest, text }];
  });
}

/**
 * A document's blocks with every string cleaned and every table made human (`humanTable`); a table that is only file bookkeeping becomes
 * its one sentence, as a one-item list so a catalogue's tree still shows it under its heading.
 */
export function humanizeBlocks(blocks: DocBlock[], namer: Namer = new Namer()): DocBlock[] {
  return blocks.flatMap((block): DocBlock[] => {
    if (block.t === "h" || block.t === "p" || block.t === "quote") {
      const spans = cleanSpans(block.spans, namer);
      return spans.length ? [{ ...block, spans }] : [];
    }
    if (block.t === "list") {
      const items = block.items.map((item) => ({ ...item, spans: cleanSpans(item.spans, namer) })).filter((item) => item.spans.length);
      return items.length ? [{ ...block, items }] : [];
    }
    if (block.t === "layout") return [{ t: "layout", lines: block.lines.map((line) => scrub(line, namer)) }];
    const cells = block.rows.map((row) => row.map(spansText));
    const [header = [], ...rows] = block.header ? cells : [[], ...cells];
    const table = humanTable(header, rows, namer);
    if (table.kind === "summary") return [{ t: "list", ordered: false, items: [{ spans: [{ text: table.text }], depth: 0 }] }];
    const toSpans = (row: string[]): Span[][] => row.map((text) => [{ text }]);
    return [{ t: "table", header: block.header, rows: [...(block.header ? [toSpans(table.header)] : []), ...table.rows.map(toSpans)] }];
  });
}
