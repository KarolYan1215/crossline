/**
 * A document's structure, as data the page draws itself: headings, paragraphs, lists, tables and aligned layout. Three readers fill it — a
 * Word file converted by mammoth (its small, well-formed HTML), a file's extracted text (a PDF's or an older upload's), and Markdown the
 * assistant wrote — and none of them ever hands HTML to the browser: what comes out is text in typed blocks, drawn by `DocBlocksView`.
 * Pure, so the readers are tested without a file.
 */

export type Span = { text: string; b?: true; i?: true; sup?: true; sub?: true; code?: true; href?: string };
export type ListItem = { spans: Span[]; depth: number; checked?: boolean };
export type DocBlock =
  | { t: "h"; level: 1 | 2 | 3 | 4; spans: Span[] }
  | { t: "p"; spans: Span[] }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "table"; header: boolean; rows: Span[][][] }
  /** Lines whose alignment is the structure (a schedule printed as columns): kept as laid out. */
  | { t: "layout"; lines: string[] }
  | { t: "quote"; spans: Span[] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
  if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
  return ENTITIES[name.toLowerCase()] ?? whole;
});

/** Only web addresses and in-page anchors are kept as links; anything else (javascript:, data:) becomes plain text. */
export const safeHref = (href: string | undefined) => href && /^(https?:\/\/|#)/i.test(href.trim()) ? href.trim() : undefined;

export const spansText = (spans: Span[]) => spans.map((span) => span.text).join("");
const trimSpans = (spans: Span[]): Span[] => {
  const out = spans.filter((span) => span.text.length);
  while (out.length && !out[0]!.text.trim()) out.shift();
  while (out.length && !out.at(-1)!.text.trim()) out.pop();
  if (out.length) {
    out[0] = { ...out[0]!, text: out[0]!.text.replace(/^\s+/, "") };
    out[out.length - 1] = { ...out.at(-1)!, text: out.at(-1)!.text.replace(/\s+$/, "") };
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------
// Word (mammoth's HTML)

type Mark = Omit<Span, "text">;
type Cell = { spans: Span[]; header: boolean };

/**
 * mammoth's output is a known, closed set of tags (p, h1–h6, strong, em, sup, sub, a, ul/ol/li, table/tr/td/th, br, img) with entities
 * escaped; this walks it as tokens and keeps the text. An unknown tag is ignored and its text kept; an image is left out (a converted
 * picture is a data address the page will not show). A paragraph that is one short bold line is a heading: Word files written without
 * heading styles mark their sections that way.
 */
export function htmlToBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const marks: Mark[] = [];
  let spans: Span[] | null = null;
  let heading: 1 | 2 | 3 | 4 | null = null;
  const lists: Array<{ ordered: boolean; items: ListItem[] }> = [];
  let table: { rows: Cell[][] } | null = null;
  let row: Cell[] | null = null;
  let cell: Cell | null = null;
  const mark = (): Mark => Object.assign({}, ...marks) as Mark;
  const target = (): Span[] => {
    if (cell) return cell.spans;
    const list = lists.at(-1);
    if (list && list.items.length && !spans) return list.items.at(-1)!.spans;
    spans ??= [];
    return spans;
  };
  const closeParagraph = () => {
    if (!spans) return;
    const clean = trimSpans(spans);
    spans = null;
    if (!clean.length) { heading = null; return; }
    if (heading) blocks.push({ t: "h", level: heading, spans: clean });
    else if (clean.every((span) => span.b) && spansText(clean).length <= 60 && !/[。．.;；]$/.test(spansText(clean))) blocks.push({ t: "h", level: 3, spans: clean.map(({ b: _b, ...span }) => span) });
    else blocks.push({ t: "p", spans: clean });
    heading = null;
  };
  for (const token of html.split(/(<[^>]+>)/g)) {
    if (!token) continue;
    const tag = /^<(\/?)([a-z0-9]+)([^>]*)>$/i.exec(token);
    if (!tag) {
      const text = decode(token);
      if (text) target().push({ text, ...mark() });
      continue;
    }
    const [, closing, rawName, attributes = ""] = tag;
    const name = rawName!.toLowerCase();
    if (!closing) {
      if (/^h[1-6]$/.test(name)) { closeParagraph(); heading = Math.min(4, Number(name[1])) as 1 | 2 | 3 | 4; spans = []; }
      else if (name === "p") { if (cell) { if (cell.spans.length) cell.spans.push({ text: "\n" }); } else if (!(lists.length && lists.at(-1)!.items.length)) { closeParagraph(); spans = []; } }
      else if (name === "br") target().push({ text: "\n" });
      else if (name === "strong" || name === "b") marks.push({ b: true });
      else if (name === "em" || name === "i") marks.push({ i: true });
      else if (name === "sup") marks.push({ sup: true });
      else if (name === "sub") marks.push({ sub: true });
      else if (name === "a") { const raw = /href="([^"]*)"/i.exec(attributes)?.[1]; const href = safeHref(raw ? decode(raw) : undefined); marks.push(href ? { href } : {}); }
      else if (name === "ul" || name === "ol") { closeParagraph(); lists.push({ ordered: name === "ol", items: [] }); }
      else if (name === "li") { const list = lists.at(-1); if (list) list.items.push({ spans: [], depth: lists.length - 1 }); }
      else if (name === "table") { closeParagraph(); table = { rows: [] }; }
      else if (name === "tr") { row = []; }
      else if (name === "td" || name === "th") { cell = { spans: [], header: name === "th" }; }
      continue;
    }
    if (/^h[1-6]$/.test(name) || name === "p") { if (!cell && !(lists.length && lists.at(-1)!.items.length && !spans)) closeParagraph(); }
    else if (["strong", "b", "em", "i", "sup", "sub", "a"].includes(name)) marks.pop();
    else if (name === "ul" || name === "ol") {
      const list = lists.pop()!;
      if (lists.length) lists.at(-1)!.items.push(...list.items.map((item) => ({ ...item, spans: trimSpans(item.spans) })));
      else if (list.items.length) blocks.push({ t: "list", ordered: list.ordered, items: list.items.map((item) => ({ ...item, spans: trimSpans(item.spans) })).filter((item) => item.spans.length) });
    }
    else if (name === "td" || name === "th") { if (row && cell) row.push({ ...cell, spans: trimSpans(cell.spans) }); cell = null; }
    else if (name === "tr") { if (table && row) table.rows.push(row); row = null; }
    else if (name === "table" && table) {
      const rows = table.rows.filter((cells) => cells.some((item) => item.spans.length));
      // The first row is a header when Word said so (th) or when every one of its cells is bold, as a header row usually is.
      const header = Boolean(rows[0]?.length && rows[0].every((item) => item.header || (item.spans.length > 0 && item.spans.every((span) => span.b || !span.text.trim()))));
      if (rows.length) blocks.push({ t: "table", header, rows: rows.map((cells) => cells.map((item) => item.spans)) });
      table = null;
    }
  }
  closeParagraph();
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------
// Extracted text (a PDF, or a Word file read before it could be converted)

const BULLET = /^\s*[-*•●▪◦·]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,2})[.)、]\s+(.*)$/;
/** Two or more runs of three spaces between words: a line laid out in columns. */
const COLUMNS = /\S {3,}\S.* {2,}\S|\S {3,}\S {3,}\S/;

function headingLevel(line: string, previousBlank: boolean, nextLine: string | undefined): 2 | 3 | undefined {
  const text = line.trim();
  if (text.length < 2 || text.length > 70) return undefined;
  // 「9 INSTRUCTORS AND TEACHING ASSISTANTS」, 「10 OFFICIAL COURSE DESCRIPTION」
  if (/^(\d+(\.\d+)*\s+)?[A-Z][A-Z0-9 &/,'()-]{3,}$/.test(text) && /[A-Z]{3}/.test(text)) return 2;
  // 「1. Course Name and Number」, 「9.2 Instructor Availability」
  if (/^\d+(\.\d+)*\.?\s+\S/.test(text) && !/[.。;；,，]$/.test(text) && text.length <= 60 && nextLine !== undefined && !NUMBERED.test(nextLine)) return 3;
  // 「Grading:」, 「课程概览：」 on a line of its own
  if (/[:：]$/.test(text) && text.length <= 50 && (previousBlank || nextLine === undefined || !nextLine.trim())) return 3;
  // 「第三章 …」
  if (/^第[一二三四五六七八九十百\d]+[章节部分讲周]/.test(text)) return 2;
  return undefined;
}

/**
 * Extracted text has lost its styling but not its shape: section numbers, lines ending in a colon, bullets and column alignment are still
 * there. Those become headings, lists and laid-out blocks; the remaining lines of a paragraph are joined (a PDF breaks lines at the
 * page edge, not at the end of a thought).
 */
export function textToBlocks(text: string): DocBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: ListItem[] } | null = null;
  let layout: string[] = [];
  let piped: string[][] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: "p", spans: [{ text: paragraph.join(/[一-鿿]$/.test(paragraph[0] ?? "") ? "" : " ") }] });
    paragraph = [];
  };
  const flushList = () => { if (list?.items.length) blocks.push({ t: "list", ...list }); list = null; };
  const flushLayout = () => {
    // Fewer than three aligned lines is a coincidence, not a table: they go back to being text.
    if (layout.length >= 3) blocks.push({ t: "layout", lines: layout });
    else for (const line of layout) paragraph.push(line.trim());
    layout = [];
  };
  // A Word table read as text keeps a row per line with its cells joined by 「 | 」 (the worker's extraction does that on purpose).
  const flushPiped = () => {
    if (piped.length >= 2) blocks.push({ t: "table", header: false, rows: piped.map((cells) => cells.map((cell) => [{ text: cell }])) });
    else for (const cells of piped) paragraph.push(cells.join(" | "));
    piped = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\s+$/, "");
    const blank = !line.trim();
    if (/\S \| \S/.test(line)) { flushLayout(); flushParagraph(); flushList(); piped.push(line.split(" | ").map((cell) => cell.trim())); continue; }
    flushPiped();
    if (COLUMNS.test(line) || (layout.length && line.trim() && /^\s{2,}\S|^\S{1,6}\s{3,}\S/.test(line))) { flushParagraph(); flushList(); layout.push(line); continue; }
    flushLayout();
    if (blank) { flushParagraph(); flushList(); continue; }
    const previousBlank = index === 0 || !lines[index - 1]!.trim();
    const level = headingLevel(line, previousBlank, lines[index + 1]);
    if (level) { flushParagraph(); flushList(); blocks.push({ t: "h", level, spans: [{ text: line.trim().replace(/[:：]$/, "") }] }); continue; }
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push({ spans: [{ text: (bullet ? bullet[1]! : numbered![2]!).trim() }], depth: 0 });
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushPiped(); flushLayout(); flushParagraph(); flushList();
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------
// Markdown the assistant wrote (for the visual summaries: trees, ledgers, checklists, flows)

function inlineSpans(text: string): Span[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part) =>
    part.startsWith("**") && part.endsWith("**") ? { text: part.slice(2, -2), b: true as const }
      : part.startsWith("`") && part.endsWith("`") ? { text: part.slice(1, -1), code: true as const } : { text: part });
}
const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isTableRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** The Markdown subset the assistant writes: headings, nested and checkbox lists, pipe tables, quotes and paragraphs. */
export function markdownToBlocks(text: string): DocBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: ListItem[] } | null = null;
  const flushParagraph = () => { if (paragraph.length) blocks.push({ t: "p", spans: inlineSpans(paragraph.join(" ")) }); paragraph = []; };
  const flushList = () => { if (list?.items.length) blocks.push({ t: "list", ...list }); list = null; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\s+$/, "");
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (/^\s*```/.test(line)) { flushParagraph(); flushList(); const body: string[] = []; index += 1; while (index < lines.length && !/^\s*```/.test(lines[index]!)) body.push(lines[index++]!); blocks.push({ t: "layout", lines: body }); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); blocks.push({ t: "h", level: Math.min(4, heading[1]!.length) as 1 | 2 | 3 | 4, spans: inlineSpans(heading[2]!.replace(/\s+#+$/, "")) }); continue; }
    if (line.includes("|") && isTableRule(lines[index + 1] ?? "")) {
      flushParagraph(); flushList();
      const rows = [tableCells(line)];
      index += 2;
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) rows.push(tableCells(lines[index++]!));
      index -= 1;
      blocks.push({ t: "table", header: true, rows: rows.map((cells) => cells.map(inlineSpans)) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flushParagraph(); flushList(); const last = blocks.at(-1); if (last?.t === "quote") last.spans.push({ text: " " }, ...inlineSpans(quote[1]!)); else blocks.push({ t: "quote", spans: inlineSpans(quote[1]!) }); continue; }
    const item = /^(\s*)(?:([-*+•])|(\d{1,3})[.)、])\s+(?:\[([ xX✓])\]\s+)?(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = Boolean(item[3]);
      const depth = Math.min(4, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2));
      if (list && depth === 0 && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push({ spans: inlineSpans(item[5]!), depth, ...(item[4] !== undefined ? { checked: item[4].trim() !== "" } : {}) });
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return blocks;
}

/** The plain text of a table cell or a heading, for comparisons and labels. */
export const blockText = (block: DocBlock): string => block.t === "list" ? block.items.map((item) => spansText(item.spans)).join("\n")
  : block.t === "table" ? block.rows.map((cells) => cells.map(spansText).join(" ")).join("\n")
  : block.t === "layout" ? block.lines.join("\n") : spansText(block.spans);
