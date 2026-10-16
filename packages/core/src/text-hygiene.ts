import { tFor, type Locale } from "./i18n";

/**
 * Clean-up for the kind of junk a model emits at the end of a free-text field, before any validator sees it.
 *
 * Seen in real runs, and each only ever ADDS text that was never part of the answer, so removing it loses nothing:
 *  - a run of invisible formatting characters (zero-width space / joiner / non-joiner, bidi marks, BOM) — the shape that
 *    escaped the "same character eight times" trim because it alternates between three of them;
 *  - after that run, a stray letter from an unrelated script and a leaked token (`ജ…numerusform】【。`);
 *  - the closing of the JSON the model lost its place in (`。}],`).
 *
 * None of this touches a field that must stay verbatim: quotes are compared with the person's own text, which may legitimately
 * contain any of these characters, so quote-like keys are skipped by `cleanAnswerStrings`.
 */
// Soft hyphen, zero-width space/joiners, bidi marks, word joiner and invisible operators, BOM.
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;
// A letter of a script none of our users write: its presence mid-answer means the model lost the thread.
const FOREIGN_LETTER = /[^\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/u;
const BRACKET_TAIL = /[\s,"'\]}]*\}[\s,"'\]}]*$/u;

export const stripInvisible = (text: string): string => text.replace(INVISIBLE, "");

/**
 * Cuts a leaked tail off a short free-text field: everything from the first foreign-script letter, then a trailing
 * run of closing brackets. Returns the text unchanged if nothing precedes the leak (a field that is entirely in another
 * script is not a leak, it is the answer).
 */
export function trimLeakedTail(text: string): string {
  let out = text;
  const foreign = FOREIGN_LETTER.exec(out);
  if (foreign && foreign.index > 0 && out.slice(0, foreign.index).trim()) out = out.slice(0, foreign.index);
  const bracket = BRACKET_TAIL.exec(out);
  if (bracket && bracket.index > 0 && out.slice(0, bracket.index).trim()) out = out.slice(0, bracket.index);
  return out.trimEnd();
}

const VERBATIM_KEY = /quote$/i;

/**
 * Removes invisible characters from every string in a parsed answer, in place, except in fields that are checked against
 * someone's own text. Applied to every Skill's answer before its validator runs.
 */
export function cleanAnswerStrings<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return stripInvisible(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>)
        .map(([key, entry]) => [key, VERBATIM_KEY.test(key) ? entry : walk(entry)]));
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Model text written before the style rule forbade it can still say 「p50 合计 180 分钟」; shown to the person it reads 「通常合计 180 分钟」.
 * p25 is the optimistic end, p50 the usual, p85 the cautious one.
 */
export function plainEstimateWords(text: string, locale?: Locale): string {
  const t = tFor(locale);
  // Chinese runs the word into what follows (「通常合计」); English keeps the space that was there ("usual total").
  const word = (key: string) => (match: string) => locale === "en" && /\s$/.test(match) ? `${t(key)} ` : t(key);
  return text.replace(/(?<![A-Za-z0-9])p\s?50(?![0-9])\s*/giu, word("通常")).replace(/(?<![A-Za-z0-9])p\s?85(?![0-9])\s*/giu, word("保守"))
    .replace(/(?<![A-Za-z0-9])p\s?25(?![0-9])\s*/giu, word("乐观"));
}
