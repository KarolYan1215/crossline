import { createHash } from "node:crypto";
import type { StoredSourceDocument } from "@crossline/db";
import { tFor, type Locale } from "@crossline/core";

/**
 * Turning an uploaded file into text a model can read.
 *
 * Until now a file the person attached was stored and then never read: the analysis, the assistant and
 * onboarding were all handed the file *name* only (`analysis.ts` says so in a comment), so dropping a
 * syllabus into the app taught it nothing. Extraction happens here, in the worker, after upload, so a
 * slow or failing parse can never block the upload route and the original file is always kept.
 *
 * Nothing here guesses. A scanned PDF with no text layer comes back `unsupported` with a note saying so,
 * not as an empty string that looks like a blank document.
 */
export type ExtractionResult = { status: StoredSourceDocument["extractionStatus"]; text: string; note?: string };

/** Text longer than this is cut: a model context is not a place to put a 400-page book. */
export const EXTRACTED_TEXT_LIMIT = 200_000;

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const clip = (text: string): ExtractionResult["text"] =>
  text.length > EXTRACTED_TEXT_LIMIT ? text.slice(0, EXTRACTED_TEXT_LIMIT) : text;

/** Collapses the layout whitespace PDF and Word export leave behind, without touching line structure. */
function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One piece of text as the PDF placed it: its string, where its left edge is, which line it sits on, and how wide it is. */
export type PlacedText = { str: string; x: number; y: number; width: number };

/**
 * The text of one PDF page with its columns kept.
 *
 * Plain extraction reads each piece in the order the file stores it, which loses where on the page a piece sat. For prose that is
 * harmless; for a table it is fatal: a course schedule's 「#1」 under 「Out」 and a 「#1」 under 「Due」 became the same two characters
 * in the same order, and a model reading the result could not tell which was the day a quiz was handed out and which was the day it was
 * due. Here pieces are grouped into lines by height and spaced by how far apart they really are, so a column stays a column — the way
 * `pdftotext -layout` does it, and the way a person looking at the page reads it.
 */
export function layoutPage(items: PlacedText[]): string {
  const pieces = items.filter((item) => item.str.trim().length > 0);
  if (!pieces.length) return "";
  // The width of one character on this page: the median of piece width per character, so a wide heading cannot stretch the grid.
  const perChar = pieces.map((item) => item.width / Math.max(1, item.str.length)).filter((value) => value > 0).sort((a, b) => a - b);
  const unit = Math.max(2, perChar[Math.floor(perChar.length / 2)] ?? 5);
  const lines: PlacedText[][] = [];
  for (const item of [...pieces].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((entry) => Math.abs(entry[0]!.y - item.y) <= unit * 0.6);
    if (line) line.push(item); else lines.push([item]);
  }
  const left = Math.min(...pieces.map((item) => item.x));
  lines.sort((a, b) => b[0]!.y - a[0]!.y);
  const labelled = columnLabels(lines, unit);
  return lines.map((line) => {
    let out = "";
    let end = left;
    for (const item of line.sort((a, b) => a.x - b.x)) {
      const gap = (item.x - end) / unit;
      if (out && gap < 0.4) out += "";
      else if (out) out += " ".repeat(gap < 1.6 ? 1 : Math.min(40, Math.max(2, Math.round(gap))));
      else out += " ".repeat(Math.min(40, Math.max(0, Math.round((item.x - left) / unit))));
      out += item.str.trim() === item.str ? item.str : item.str.replace(/^\s+|\s+$/g, "");
      end = item.x + item.width;
    }
    const columns = labelled.get(line);
    // i18n-ignore: a layout marker inside the extracted text, read by models
    return columns ? `${out.trimEnd()}  [列 ${columns}]` : out.trimEnd();
  }).filter(Boolean).join("\n");
}

const TABLE_ROW_LABEL = /^(\d{1,2}\/\d{1,2}|TBD|TBA)$/i;

/**
 * For a table whose rows start with a date, says in words which column each small marker sits under. Spacing alone leaves a model
 * counting characters to tell a 「#2」 under 「Quiz」 from one under 「Homework Out」, and a real course schedule came back with every
 * quiz and homework date at low confidence because it could not. The header lines above the first row name the columns (two levels
 * there: 「Homework」 over 「Out」/「Due」); a short piece in a row is labelled with the nearest heading at each level. Added to the line,
 * never replacing it, and only when at least three rows start with a date, so prose and ordinary pages are untouched.
 */
function columnLabels(lines: PlacedText[][], unit: number): Map<PlacedText[], string> {
  const result = new Map<PlacedText[], string>();
  const byX = (line: PlacedText[]) => [...line].sort((a, b) => a.x - b.x);
  const rows = lines.map((line, index) => ({ line, index })).filter(({ line }) => TABLE_ROW_LABEL.test(byX(line)[0]!.str.trim()));
  if (rows.length < 3) return result;
  const first = rows[0]!.index;
  const header = lines.slice(Math.max(0, first - 3), first).filter((line) => line.length >= 2);
  if (!header.length) return result;
  const centre = (piece: PlacedText) => piece.x + piece.width / 2;
  const nearest = (line: PlacedText[], cx: number) => {
    const best = [...line].sort((a, b) => Math.abs(centre(a) - cx) - Math.abs(centre(b) - cx))[0];
    return best && Math.abs(centre(best) - cx) <= Math.max(best.width, 10 * unit) ? best.str.trim() : undefined;
  };
  for (const { line } of rows) {
    // The piece after the date is the row's description, however short (「SRAM」), not a marker in a column.
    const marks = byX(line).slice(line.length >= 3 ? 2 : 1).filter((piece) => piece.str.trim().length > 0 && piece.str.trim().length <= 8).flatMap((piece) => {
      const labels = header.map((level) => nearest(level, centre(piece))).filter((label): label is string => Boolean(label));
      const unique = labels.filter((label, i) => labels.indexOf(label) === i);
      return unique.length ? [`${unique.join(" ")}=${piece.str.trim()}`] : [];
    });
    if (marks.length) result.set(line, marks.join(" | "));
  }
  return result;
}

/** A Word table as rows of cells separated by 「 | 」, so a row stays a row instead of its cells becoming separate paragraphs. */
export function htmlTablesToText(html: string): string {
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };
  const plain = (fragment: string) => fragment.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, (entity) => entities[entity.toLowerCase()] ?? " ").replace(/\s+/g, " ").trim();
  return html
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_row, cells: string) => `\n${[...cells.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => plain(cell[1]!)).join(" | ")}\n`)
    .replace(/<\/(p|h[1-6]|li|table)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, (entity) => entities[entity.toLowerCase()] ?? " ");
}

/** `locale`: the language of the note shown beside a file that could not be read (the workspace's). */
export async function extractText(bytes: Uint8Array, kind: StoredSourceDocument["kind"], locale?: Locale): Promise<ExtractionResult> {
  const t = tFor(locale);
  const finish = (raw: string, emptyNote = t("文件里没有可提取的文字。")) => finished(raw, emptyNote);
  try {
    if (kind === "text") return finish(new TextDecoder("utf-8").decode(bytes));
    if (kind === "docx") {
      const mammoth = await import("mammoth");
      const buffer = Buffer.from(bytes);
      // Raw text turns every table cell into its own paragraph; a document with a table is read as HTML and its rows kept.
      const html = (await mammoth.convertToHtml({ buffer })).value;
      if (/<table/i.test(html)) return finish(htmlTablesToText(html));
      const { value } = await mammoth.extractRawText({ buffer });
      return finish(value);
    }
    if (kind === "pdf") {
      const { getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const pages: string[] = [];
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const content = await (await pdf.getPage(number)).getTextContent();
        const placed = (content.items as Array<{ str?: string; transform?: number[]; width?: number }>).flatMap((item) =>
          typeof item.str === "string" && item.transform ? [{ str: item.str, x: item.transform[4] ?? 0, y: item.transform[5] ?? 0, width: item.width ?? 0 }] : []);
        pages.push(layoutPage(placed));
      }
      return finish(pages.filter(Boolean).join("\n\n"), t("该 PDF 没有可提取的文字层（可能是扫描件）；需要图片或 OCR 输入。"));
    }
    if (kind === "image") {
      return { status: "unsupported", text: "", note: t("图片没有文字层；需要以图片形式交给模型查看。") };
    }
    return { status: "unsupported", text: "", note: t("录音需要本地转写，当前环境还没有配置转写引擎。") };
  } catch (error) {
    return { status: "failed", text: "", note: t("解析失败：{{reason}}", { reason: error instanceof Error ? error.message : String(error) }).slice(0, 300) };
  }
}

function finished(raw: string, emptyNote: string): ExtractionResult {
  const text = tidy(raw);
  return text ? { status: "done", text: clip(text) } : { status: "unsupported", text: "", note: emptyNote };
}

/** Bumped when extraction changes what text a file yields, so files read the old way are read again once. */
export const EXTRACTION_LAYOUT_VERSION = "3";

/**
 * Reads again, once per workspace, every PDF and Word file that was extracted before columns were kept. Only files whose original
 * is still on disk are touched, and a file that can no longer be read keeps the text it had rather than losing it.
 */
export async function reextractForLayout(store: import("@crossline/db").CrosslineStore, workspaceId: string,
  read: (uri: string) => Uint8Array): Promise<number> {
  if (store.getSetting(workspaceId, "extract.layout") === EXTRACTION_LAYOUT_VERSION) return 0;
  let changed = 0;
  for (const doc of store.listSourceDocuments(workspaceId)) {
    if ((doc.kind !== "pdf" && doc.kind !== "docx") || doc.extractionStatus !== "done") continue;
    let bytes: Uint8Array;
    try { bytes = read(doc.uri); } catch { continue; }
    const result = await extractText(bytes, doc.kind);
    if (result.status !== "done" || result.text === doc.extractedText) continue;
    store.setSourceDocumentExtraction(workspaceId, doc.id, { status: result.status, text: result.text });
    changed += 1;
  }
  store.setSetting(workspaceId, "extract.layout", EXTRACTION_LAYOUT_VERSION);
  return changed;
}
