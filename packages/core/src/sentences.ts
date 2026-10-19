/**
 * Numbered evidence (2026-10-19, docs/onboarding-v3.md 「编号引用」): the person's replies and their files are cut into numbered
 * sentences, the model cites a sentence by its number instead of copying words, and the system fills the quote in from the ledger. A
 * model asked to copy text verbatim failed on punctuation, Markdown and line breaks; a number is either one it was shown or not.
 *
 * Segmentation is the Unicode sentence algorithm (UAX #29, ICU through `Intl.Segmenter`), not rules of our own: it already keeps `3.5`,
 * `9.00`, `10:30` and `U.S.` whole and reads an ASCII period after Chinese text as a full stop. What it gets wrong only changes how fine
 * a citation is, never whether it is right, because three rules make every error harmless: segments never lose text (each keeps its
 * offsets into the source), fragments too short to mean anything (`Dr. `, `1. `) join their neighbour, and a run without punctuation is
 * cut at a space or comma once it passes `SEGMENT_MAX` characters. A citation may name several sentences, so splitting too finely costs
 * nothing. Lines are cut first, so one row of a syllabus table is one sentence with its date and its title together.
 */
export type TextSegment = { start: number; end: number; text: string };

/** Above this many characters a segment is cut again at a space, a comma or a bar. */
export const SEGMENT_MAX = 120;
/** A segment with fewer letters or digits than this joins its neighbour on the same line. */
const SEGMENT_MIN = 4;
/** Recorded with each sentence so a later change of the rules never renumbers what is stored. */
export const SEGMENTER_VERSION = "uax29-v1";

const SENTENCES = new Intl.Segmenter("zh", { granularity: "sentence" });
const content = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
const CUT = /[\s，,；;、|｜]/u;

export function segmentText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const offset = line.index;
    const pieces = [...SENTENCES.segment(line[0])].map((piece) => ({ start: offset + piece.index, end: offset + piece.index + piece.segment.length }));
    // Fragments too short to stand alone join the next piece on the line, or the previous one when they are last.
    const merged: Array<{ start: number; end: number }> = [];
    let carry: number | undefined;
    for (const piece of pieces) {
      const start = carry ?? piece.start;
      carry = undefined;
      if (content(text.slice(start, piece.end)) < SEGMENT_MIN) { carry = start; continue; }
      merged.push({ start, end: piece.end });
    }
    if (carry !== undefined) {
      const last = merged.at(-1);
      if (last) last.end = offset + line[0].length; else merged.push({ start: carry, end: offset + line[0].length });
    }
    for (const piece of merged) for (const part of cutLong(text, piece.start, piece.end)) {
      const trimmed = trim(text, part.start, part.end);
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function cutLong(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = [];
  let from = start;
  while (end - from > SEGMENT_MAX) {
    let cut = -1;
    for (let at = from + SEGMENT_MAX; at > from + SEGMENT_MIN; at -= 1) if (CUT.test(text[at - 1]!)) { cut = at; break; }
    if (cut < 0) {
      cut = from + SEGMENT_MAX;
      // Never between the two halves of a surrogate pair.
      if (/[\uDC00-\uDFFF]/.test(text[cut] ?? "")) cut -= 1;
    }
    parts.push({ start: from, end: cut });
    from = cut;
  }
  parts.push({ start: from, end });
  return parts;
}

function trim(text: string, start: number, end: number): TextSegment | undefined {
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return end > start ? { start, end, text: text.slice(start, end) } : undefined;
}

/**
 * Where a quote stands in a text, comparing letters and digits only (case folded): punctuation, spacing and Markdown are not content.
 * Used to give facts written before numbered evidence their sentences, and for quotes the system itself takes from a reply.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | undefined {
  const keep = /[\p{L}\p{N}]/u;
  const index: number[] = [];
  let folded = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (!keep.test(char)) continue;
    folded += char.toLowerCase();
    index.push(at);
  }
  const needle = [...quote].filter((char) => keep.test(char)).join("").toLowerCase();
  if (!needle) return undefined;
  const found = folded.indexOf(needle);
  if (found < 0) return undefined;
  return { start: index[found]!, end: index[found + needle.length - 1]! + 1 };
}

const CHINESE_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 一 … 九百九十九; enough for hours, days, scores and counts said in words. */
function chineseNumber(word: string): number | undefined {
  let total = 0, digit = -1;
  for (const char of word) {
    if (char in CHINESE_DIGITS) { digit = CHINESE_DIGITS[char]!; continue; }
    const unit = char === "十" ? 10 : char === "百" ? 100 : 0;
    if (!unit) return undefined;
    total += (digit < 0 ? 1 : digit) * unit;
    digit = -1;
  }
  return total + (digit < 0 ? 0 : digit);
}

/**
 * Every number a text states, however it is typed: `9:00`, `9.00`, `9：00`, `９点`, `九点半`, `下午3点` (also 15), `3pm` (also 15).
 * People do not type to a format, so a check of what the model wrote against what they said compares numbers, not spellings.
 */
export function numbersIn(raw: string): Set<number> {
  const text = raw.normalize("NFKC");
  const found = new Set<number>();
  for (const match of text.matchAll(/\d+/g)) found.add(Number(match[0]));
  for (const match of text.matchAll(/[零〇一二两三四五六七八九十百]+/g)) {
    const value = chineseNumber(match[0]);
    if (value !== undefined) found.add(value);
  }
  if (/[点時时个]半/u.test(text)) found.add(30);
  const afternoon = /(?:下午|晚上|傍晚|中午)\s*([零〇一二两三四五六七八九十]+|\d{1,2})|(\d{1,2})\s*(?:pm|p\.m\.)/giu;
  for (const match of text.matchAll(afternoon)) {
    const word = match[1] ?? match[2] ?? "";
    const hour = /\d/.test(word) ? Number(word) : chineseNumber(word);
    if (hour !== undefined && hour < 12) found.add(hour + 12);
  }
  return found;
}

/**
 * Whether the numbers in a value the model wrote appear in the sentences it cited. Zero and years are not compared (a year is worked out
 * from today, `09:00`'s zeros say nothing), and a whole number of hours may be written as minutes. A miss is a warning, never a refusal:
 * the person's own words may say 「一个半小时」 for 90 minutes.
 */
export function numbersSupported(value: string, cited: string): boolean {
  const said = numbersIn(cited);
  for (const number of numbersIn(value)) {
    if (number === 0 || (number >= 1900 && number <= 2100)) continue;
    if (said.has(number) || (number % 60 === 0 && said.has(number / 60))) continue;
    return false;
  }
  return true;
}
