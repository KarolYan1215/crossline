import zlib from "node:zlib";
import { chatHistoryText, credentialName, credentialText, maskPersonalNumbers, parseChatHistory, redactSecrets, tFor, JSON_SOURCE, type Locale } from "@crossline/core";
import type { StoredSourceDocument } from "@crossline/db";
import { EXTRACTED_TEXT_LIMIT, extractText, type ExtractionResult } from "./extract";

/**
 * The fixed order every file the person gives goes through before a model may read it (docs/plans/2026-11-22-interview-and-import-redesign.md
 * §四.3, D15): (1) keys and credentials, by code, first — a key a model has seen has already left for the model's provider; (2) personal
 * papers — a folder's are left out (`source-folders.ts`), a file uploaded on purpose is read with its ID, card and account numbers masked;
 * then (3) the model's screening (folders only) and (4) de-duplication happen elsewhere. This file is (1) and (2) for one file's text.
 */

/** Reads a file's text: a zstd-compressed export is unpacked first, and an AI conversation export keeps only what the person typed. */
export async function readSourceText(bytes: Uint8Array, kind: StoredSourceDocument["kind"], fileName: string, locale?: Locale): Promise<ExtractionResult> {
  const t = tFor(locale);
  if (kind !== "text" || !JSON_SOURCE.test(fileName)) return extractText(bytes, kind, locale);
  let raw = bytes;
  if (/\.zst$/i.test(fileName)) {
    // Node 22.15+ reads zstd natively; without it the export is said to be unreadable rather than read as garbage.
    const unzstd = (zlib as unknown as { zstdDecompressSync?: (input: Uint8Array) => Buffer }).zstdDecompressSync;
    if (!unzstd) return { status: "unsupported", text: "", note: t("这个 Node 版本读不了 .zst 压缩文件；请先解压成 .jsonl 再给。") };
    try { raw = new Uint8Array(unzstd(bytes)); } catch { return { status: "failed", text: "", note: t("解压失败。") }; }
  }
  const text = new TextDecoder("utf-8").decode(raw);
  let history;
  try { history = parseChatHistory(text); } catch { history = undefined; }
  if (!history) return extractText(raw, "text", locale);
  if (!history.conversations.length) return { status: "unsupported", text: "", note: t("这是 AI 对话记录，但里面没有本人说的话。") };
  const body = chatHistoryText(history, locale);
  return { status: "done", text: body.slice(0, EXTRACTED_TEXT_LIMIT),
    note: t("AI 对话记录：{{count}} 段对话，只保留了本人说的话。", { count: history.conversations.length }) };
}

export type IntakeVerdict =
  | { refused: true; code: "SOURCE_CREDENTIAL"; message: string }
  | { refused: false; text: string; note?: string };

/**
 * A file uploaded on purpose (D15): refused when its name or opening is a credential; otherwise any key elsewhere in it is cut out and
 * its ID, card and account numbers are masked, so what is stored — and every model that later reads it — never holds them.
 */
export function screenUploadedText(fileName: string, text: string, locale?: Locale): IntakeVerdict {
  const t = tFor(locale);
  if (credentialName(fileName) || credentialText(text)) {
    return { refused: true, code: "SOURCE_CREDENTIAL", message: t("「{{name}}」像是密钥或密码文件，没有保存，也没有交给模型。", { name: fileName }) };
  }
  return { refused: false, ...maskForModel(text, locale) };
}

/** Keys cut out and ID, card and account numbers masked, with a note saying what was hidden (a recording's transcript goes through this too). */
export function maskForModel(text: string, locale?: Locale): { text: string; note?: string } {
  const t = tFor(locale);
  const keys = redactSecrets(text);
  const numbers = maskPersonalNumbers(keys.text, locale);
  const notes = [...(keys.redacted ? [t("其中的密钥已移除")] : []),
    ...(numbers.masked.length ? [t("{{kinds}}已打码", { kinds: numbers.masked.map((kind) => t(kind)).join(t("、")) })] : [])];
  return { text: numbers.text, ...(notes.length ? { note: notes.join(t("；")) } : {}) };
}

/** A folder's file (sensitive papers are left out before this): keys anywhere in its text are cut out before it is kept. */
export const withoutSecrets = (text: string) => redactSecrets(text).text;
