// i18n-exempt: patterns over the interview's Chinese replies (never shown to the person)
/**
 * Counts the interview states about the person that nobody said (replay 2026-11-26: 「七张画完，两张没动」 for a set of four the person had
 * only called 「还剩两张没画」; the player went along and the portrait wrote 「一套九张」). A number of things — 张、篇、件 — in a statement of the
 * reply is checked against what was said: the person's replies, their files, and the interview's own earlier replies (a count it already
 * used, kept after being sent back once, is not flagged every round). Questions are not statements (「一共几张？」 is what it should ask), a
 * range is the interviewer's own instruction (「分成三到五章」), and 一 is too common to mean anything (「一件事」「一个」).
 *
 * This verifies a model's claim against the source words (docs/plans/harness-1125.md §4): the round is sent back once with the count named,
 * and the model decides — its second answer stands, whatever it keeps.
 */
// Things made or handed in, not events or people: 「投入的两次」「你说的两个理由」 count what the person told, which is the interview's inference.
const CLASSIFIERS = "张幅篇件本页章首集条单稿份套";
const DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }; // i18n-ignore: numerals
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10_000 }; // i18n-ignore: numerals

/** 「七」「十二」「两千」「3」 as a number; undefined when it is not one (「两三」). */
export function numeralValue(text: string): number | undefined {
  if (/^\d+$/u.test(text)) return Number(text);
  let total = 0, section = 0, digit: number | undefined;
  for (const char of text) {
    if (char in DIGITS) { if (digit !== undefined) return undefined; digit = DIGITS[char]; continue; }
    const unit = UNITS[char];
    if (unit === undefined) return undefined;
    if (unit === 10_000) { total = (total + section + (digit ?? 0)) * unit; section = 0; digit = undefined; continue; }
    section += (digit ?? 1) * unit;
    digit = undefined;
  }
  return total + section + (digit ?? 0);
}

// rule: interview.unsaid-count
const COUNT = new RegExp(`(?<![第到至~\\-—–\\d零一二两三四五六七八九十百千万几每])(\\d{1,5}|[零一二两三四五六七八九十百千万]{1,6})(?=[${CLASSIFIERS}])([${CLASSIFIERS}])`, "gu");

/** Each count in a text, as 「<number><classifier>」 (「两张」 and 「2张」 alike are 「2张」); `at` is where the numeral starts. */
export function countsIn(text: string): Array<{ key: string; words: string; at: number }> {
  const out: Array<{ key: string; words: string; at: number }> = [];
  for (const match of text.matchAll(COUNT)) {
    const value = numeralValue(match[1]!);
    if (value === undefined || value === 1) continue;
    out.push({ key: `${value}${match[2]}`, words: match[0], at: match.index });
  }
  return out;
}

// rule: interview.unsaid-count
const ORDINAL = new RegExp(`第(\\d{1,3}|[一二两三四五六七八九十百]{1,4})([${CLASSIFIERS}])`, "gu");

/**
 * The counts an enumeration implies (replay 2026-11-27: the person named 第一章…第四章 and 「四章里有两章」 was sent back): a person who said
 * 「第四章」 said there are at least four, so every count of chapters up to four is theirs.
 */
function impliedByOrdinals(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(ORDINAL)) {
    const value = Math.min(numeralValue(match[1]!) ?? 0, 100);
    for (let n = 2; n <= value; n += 1) out.push(`${n}${match[2]}`);
  }
  return out;
}

/**
 * The counts the interviewer said before the person did, in conversation order: a person repeating one (replay 2026-11-26: 「前七张都有
 * 猫」 after the interview's 「七张画完」) is going along, not reporting, so a claim resting on that quote is not their own report.
 */
export function countsFirstSaidByInterviewer(turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>): Set<string> {
  const first = new Map<string, "user" | "assistant">();
  for (const turn of turns) for (const count of countsIn(turn.text)) if (!first.has(count.key)) first.set(count.key, turn.role);
  return new Set([...first].filter(([, role]) => role === "assistant").map(([key]) => key));
}

/**
 * The counts the reply states (outside its questions) that none of `said` contains, in the words the reply used. A count after 这/那
 * points back at things already named (「这两件事不是一回事」, replay 2026-11-27), it does not report how many there are.
 */
export function unsaidCounts(reply: string, said: readonly string[]): string[] {
  const known = new Set(said.flatMap((text) => [...countsIn(text).map((count) => count.key), ...impliedByOrdinals(text)]));
  const statements = (reply.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? []).filter((sentence) => !/[？?]/u.test(sentence));
  return [...new Set(statements.flatMap((sentence) => countsIn(sentence)
    .filter((count) => !/[这那]/u.test(sentence[count.at - 1] ?? "") && !known.has(count.key))).map((count) => count.words))];
}
