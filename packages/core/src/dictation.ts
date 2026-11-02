/**
 * Voice input (docs/voice-input.md, decided with the owner on 2026-11-02 over three rounds): every free-text box has a microphone. The
 * browser's own recogniser is used where it works, Crossline's SenseVoice where it does not; what was heard goes into the box at once,
 * and a model's correction against the person's own names replaces it a few seconds later — it fixes, it never rewrites. What the person
 * then changes in that text is remembered as their own wording for the next time.
 *
 * This file is what the web, the worker and the Skill share: the person's settings, the correction's schema and its check, and the
 * character diff both the "N corrections" count and the learned wording come from.
 */

/** Settings → 通用 「语音输入」. */
export const VOICE_SETTING = "voice.preferences";
/** `auto` follows the interface language (中文 → 普通话 with English mixed in, English → English). */
export type VoiceLanguage = "auto" | "zh" | "en" | "yue";
export type VoicePreferences = { enabled: boolean; language: VoiceLanguage; correct: boolean };
export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = { enabled: true, language: "auto", correct: true };
const LANGUAGES: readonly VoiceLanguage[] = ["auto", "zh", "en", "yue"];

export function readVoicePreferences(raw: string | undefined | null): VoicePreferences {
  try {
    const stored = JSON.parse(raw ?? "{}") as Partial<VoicePreferences>;
    return { enabled: stored.enabled !== false, correct: stored.correct !== false,
      language: LANGUAGES.includes(stored.language as VoiceLanguage) ? stored.language as VoiceLanguage : "auto" };
  } catch { return { ...DEFAULT_VOICE_PREFERENCES }; }
}

/** One recording is at most three minutes; the recorder stops itself there and the clip is transcribed as it is. */
export const DICTATION_MAX_SECONDS = 180;
/** What the browser sends the server engine: 16 kHz mono, 16-bit little-endian PCM (decoded and resampled in the page). */
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_MAX_BYTES = DICTATION_MAX_SECONDS * DICTATION_SAMPLE_RATE * 2 + 4096;

/**
 * The BCP 47 tag the browser's recogniser is given. It must be one language: 普通话 (`zh-CN`) still writes English words it hears, so a
 * mixed sentence is best served by the person's main language. Cantonese is `yue-Hant-HK` in Chrome and `zh-HK` in Safari.
 */
export function speechLang(preferences: Pick<VoicePreferences, "language">, uiLocale: "zh" | "en", safari = false): string {
  const language = preferences.language === "auto" ? uiLocale : preferences.language;
  if (language === "en") return "en-US";
  if (language === "yue") return safari ? "zh-HK" : "yue-Hant-HK";
  return "zh-CN";
}

/** The corrector's answer (Skill `crossline-dictation-corrector`): the whole text, corrected. */
export type DictationCorrection = { text: string };
export const DICTATION_CORRECTION_SCHEMA = { type: "object", additionalProperties: false, required: ["text"], properties: {
  text: { type: "string", minLength: 1, maxLength: 6000 } } } as const;

/** Spacing differences are not corrections: the comparison is made on the text with every run of whitespace as one space. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** A change of one span: `from` in the first text became `to` in the second (either may be empty). */
export type TextHunk = { from: string; to: string };
/** The same change by position, in code points: `a[aStart, aEnd)` became `b[bStart, bEnd)`. */
type Span = { aStart: number; aEnd: number; bStart: number; bEnd: number };

/** The changed spans between two code-point arrays, by an LCS table; `undefined` when either is longer than `limit`. */
function diffSpans(x: string[], y: string[], limit: number): Span[] | undefined {
  if (x.length > limit || y.length > limit) return undefined;
  const n = x.length, m = y.length, width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const spans: Span[] = [];
  let open: Span | undefined, i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { if (open) spans.push(open); open = undefined; i += 1; j += 1; continue; }
    open ??= { aStart: i, aEnd: i, bStart: j, bEnd: j };
    if (j < m && (i === n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) { j += 1; open.bEnd = j; }
    else { i += 1; open.aEnd = i; }
  }
  if (open) spans.push(open);
  return spans;
}

/**
 * The changed spans between two texts, by a character LCS. Long texts (over `limit` characters on either side, never a dictation the
 * person reads at a glance) are compared as one hunk rather than spending seconds on a table.
 */
export function textHunks(a: string, b: string, limit = 1500): TextHunk[] {
  if (a === b) return [];
  const x = [...a], y = [...b];
  const spans = diffSpans(x, y, limit);
  if (!spans) return [{ from: a, to: b }];
  return spans.map((span) => ({ from: x.slice(span.aStart, span.aEnd).join(""), to: y.slice(span.bStart, span.bEnd).join("") }));
}

/** How alike two texts are, 0–1: twice the characters they share in order over both lengths. */
export function dictationSimilarity(a: string, b: string): number {
  const x = squash(a), y = squash(b);
  if (!x && !y) return 1;
  const changed = textHunks(x, y).reduce((sum, hunk) => sum + [...hunk.from].length + [...hunk.to].length, 0);
  const total = [...x].length + [...y].length;
  return Math.max(0, (total - changed) / total);
}

/**
 * Takes the corrector's answer only when it is still the same text: a correction that changed more than the text can bear (a short
 * clip needs room for its punctuation, so the bar is lower there) is a rewrite, and the person keeps what they said. Throws with a code
 * the runner sends back once; past the repairs the caller keeps the raw text.
 */
export function validateDictationCorrection(raw: string, value: unknown): DictationCorrection {
  const text = typeof (value as DictationCorrection | undefined)?.text === "string" ? (value as DictationCorrection).text.trim() : "";
  if (!text) throw new Error("DICTATION_CORRECTION_EMPTY: return the whole text, corrected, in `text`.");
  const before = [...squash(raw)].length, after = [...squash(text)].length;
  const floor = before < 20 ? 0.35 : before < 60 ? 0.5 : 0.6;
  if (after > before * 1.5 + 12 || after < before * 0.5 - 4 || dictationSimilarity(raw, text) < floor) {
    throw new Error("DICTATION_REWRITTEN: only fix misheard words, names, punctuation and fillers; keep every other word as it was said.");
  }
  return { text };
}

/** How many places a correction changed, punctuation and spacing alone not counted (the person sees 「已纠正 N 处」). */
export function correctionCount(raw: string, corrected: string): number {
  const words = (text: string) => text.replace(/[\s\p{P}]+/gu, "");
  return textHunks(words(raw), words(corrected)).length;
}

/** A wording the person taught by editing what the recogniser wrote: next time 「heard」 is corrected to 「meant」. */
export type LexiconEdit = { heard: string; meant: string };
export const LEXICON_MAX_EDITS = 3;
const WORDY = /[\p{L}\p{N}]/u;

const LATIN = /[A-Za-z0-9]/;
const HAN = /\p{Script=Han}/u;

/**
 * What the person's edit of a dictated span teaches: each replaced word, both sides 1–16 characters with a letter or digit in them, at
 * most three. A change inside a Latin word takes the whole word (「cross line」 → 「Crossline」, not 「c」 → 「C」), and a one-character
 * Chinese change takes its neighbour, since 「王」 → 「汪」 alone would be applied everywhere. A deletion, an insertion, or an edit that
 * replaced most of the text (they rewrote it rather than fixing a word) teaches nothing.
 */
export function lexiconEdits(dictated: string, edited: string): LexiconEdit[] {
  if (!dictated.trim() || !edited.trim() || dictated === edited) return [];
  if (dictationSimilarity(dictated, edited) < 0.5) return [];
  const x = [...dictated], y = [...edited];
  const spans = diffSpans(x, y, 600);
  if (!spans) return [];
  const merged: Span[] = [];
  for (const raw of spans) {
    const span = { ...raw };
    // Shared characters around a change are equal on both sides, so both edges move together.
    const grows = (char: string | undefined) => !!char && LATIN.test(char);
    while (span.aStart > 0 && span.bStart > 0 && grows(x[span.aStart - 1]) && x[span.aStart - 1] === y[span.bStart - 1]) { span.aStart -= 1; span.bStart -= 1; }
    while (span.aEnd < x.length && span.bEnd < y.length && grows(x[span.aEnd]) && x[span.aEnd] === y[span.bEnd]) { span.aEnd += 1; span.bEnd += 1; }
    if (span.aEnd - span.aStart === 1 && HAN.test(x[span.aStart]!)) {
      if (span.aEnd < x.length && HAN.test(x[span.aEnd]!) && x[span.aEnd] === y[span.bEnd]) { span.aEnd += 1; span.bEnd += 1; }
      else if (span.aStart > 0 && HAN.test(x[span.aStart - 1]!) && x[span.aStart - 1] === y[span.bStart - 1]) { span.aStart -= 1; span.bStart -= 1; }
    }
    const last = merged.at(-1);
    if (last && span.aStart <= last.aEnd && span.bStart <= last.bEnd) {
      last.aEnd = Math.max(last.aEnd, span.aEnd); last.bEnd = Math.max(last.bEnd, span.bEnd);
      while (last.aEnd < x.length && last.bEnd < y.length && grows(x[last.aEnd]) && x[last.aEnd] === y[last.bEnd]) { last.aEnd += 1; last.bEnd += 1; }
    } else merged.push(span);
  }
  const edits = merged.map((span) => ({ heard: x.slice(span.aStart, span.aEnd).join("").trim(), meant: y.slice(span.bStart, span.bEnd).join("").trim() }))
    .filter((edit) => edit.heard && edit.meant && edit.heard !== edit.meant && [...edit.heard].length <= 16 && [...edit.meant].length <= 16
      && WORDY.test(edit.heard) && WORDY.test(edit.meant));
  return edits.length > LEXICON_MAX_EDITS ? [] : edits;
}

/** How a learned wording is kept (a preference entry of source `dictation`) and read back for the corrector. */
export const lexiconText = (edit: LexiconEdit) => `「${edit.heard}」 → 「${edit.meant}」`;
export function lexiconFromText(text: string): LexiconEdit | undefined {
  const match = /^「(.+?)」 → 「(.+)」$/.exec(text);
  return match ? { heard: match[1]!, meant: match[2]! } : undefined;
}
