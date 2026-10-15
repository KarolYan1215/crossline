import { htmlToBlocks, textToBlocks, type DocBlock } from "./doc-blocks";
import { materialKind, type MaterialKind } from "./kinds";

/**
 * A material as the viewer draws it, built on the server from the file's bytes and, for the person's uploads, the text the worker already
 * extracted. Never HTML: a Word file goes through mammoth and comes back as typed blocks, Markdown and text come back as text the page
 * renders itself, a table as cells. `GET <file route>?view=preview` answers with this.
 */
export type MaterialPreview =
  | { kind: "doc"; from: "docx" | "pdf" | "text"; blocks: DocBlock[]; note?: string }
  | { kind: "markdown"; text: string; truncated: boolean }
  | { kind: "table"; header: string[]; rows: string[][]; totalRows: number }
  | { kind: "image" }
  | { kind: "pdf"; note: string }
  | { kind: "none"; note: string };

const TEXT_CAP = 200_000;
const ROW_CAP = 500;

function csvRows(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = "", record: string[] = [], quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (quoted) {
      if (char === "\"" && body[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === delimiter) { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      record.push(field); field = "";
      if (record.some((cell) => cell.trim())) records.push(record);
      record = [];
    } else field += char;
  }
  record.push(field);
  if (record.some((cell) => cell.trim())) records.push(record);
  return records;
}

/** A CSV (or TSV) in full, up to `ROW_CAP` rows, quotes respected. Exported for its test. */
export function tablePreview(text: string, delimiter = ","): Extract<MaterialPreview, { kind: "table" }> {
  const [header = [], ...rest] = csvRows(text, delimiter);
  return { kind: "table", header, rows: rest.slice(0, ROW_CAP), totalRows: rest.length };
}

/** A saved web page as its readable text: scripts, styles and tags dropped, a block element's end kept as a line break. */
export function htmlPageText(html: string): string {
  return html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "").replace(/<\/(p|div|h[1-6]|li|tr|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Bytes that are not UTF-8 text (a binary renamed .md) are not shown as text. */
const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 4096).some((byte) => byte === 0);

export async function buildPreview(input: { fileName: string; bytes?: Uint8Array; extractedText?: string; kind?: MaterialKind }): Promise<MaterialPreview> {
  const kind = input.kind ?? materialKind(input.fileName);
  const text = () => input.bytes && !looksBinary(input.bytes) ? new TextDecoder("utf-8").decode(input.bytes) : input.extractedText ?? "";
  if (kind === "image") return { kind: "image" };
  if (kind === "markdown" || kind === "text") {
    const body = text();
    if (!body.trim()) return { kind: "none", note: "这份文件没有可显示的文字。" };
    return { kind: "markdown", text: body.slice(0, TEXT_CAP), truncated: body.length > TEXT_CAP };
  }
  if (kind === "csv") return tablePreview(text(), /\.tsv$/i.test(input.fileName) ? "\t" : ",");
  if (kind === "docx") {
    if (input.bytes) {
      try {
        const mammoth = await import("mammoth");
        const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
        const blocks = htmlToBlocks(value);
        if (blocks.length) return { kind: "doc", from: "docx", blocks };
      } catch { /* a damaged file falls back to the text read when it was uploaded */ }
    }
    if (input.extractedText?.trim()) return { kind: "doc", from: "text", blocks: textToBlocks(input.extractedText.slice(0, TEXT_CAP)), note: "按上传时读取的文字显示，原有排版可能有出入。" };
    return { kind: "none", note: "这份 Word 文件读不出文字，可下载原文件查看。" };
  }
  if (kind === "pdf") {
    if (input.extractedText?.trim()) return { kind: "doc", from: "pdf", blocks: textToBlocks(input.extractedText.slice(0, TEXT_CAP)), note: "按 PDF 中读取的文字显示；图表与公式以原文件为准。" };
    return { kind: "pdf", note: "这份 PDF 没有读取过文字，以原版式显示。" };
  }
  if (kind === "office") return { kind: "none", note: "这类文件不能在页面内预览，可下载后用 Office 打开。" };
  return { kind: "none", note: "这类文件不能在页面内预览，可下载查看。" };
}
