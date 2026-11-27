import type { TurnQuestion } from "./onboarding-turn-schema";

/**
 * What the app takes out of, or puts beside, the interview's reply after the model wrote it (2026-11-14, replay 10 read as the person
 * reads it). Each rule here is one the Skill also states; the Skill alone was not followed every time, so the round is fixed in code.
 */

/** Sentences, each with its own end mark; `；` ends one too, so a list run together with semicolons splits. */
const sentencesOf = (text: string): string[] => text.match(/[^。！？!?；;\n]+[。！？!?；;]?|\n+/gu) ?? [];

/** Where the Skill's help lines end: the hotlines, then 「去最近的医院急诊」. */
const SAFETY_MARKS = ["12356", "82951332", "急诊"]; // i18n-ignore: matched in the reply, never shown

/**
 * The reply of a round that answers a disclosure of self-harm, up to its help lines; after them only a question stays (the check on
 * how the person is now). Replay 10 read the disclosure against the person she admires right after the hotlines (「……和那段情绪很低的
 * 时间正好相对」): the Skill says the disclosure is never portrait material, and that round's reply is where it was used first.
 */
export function safetyReplyOnly(reply: string): string {
  const end = Math.max(...SAFETY_MARKS.map((mark) => { const at = reply.lastIndexOf(mark); return at < 0 ? -1 : at + mark.length; }));
  if (end < 0) return reply;
  const stop = reply.slice(end).search(/[。！？!?\n]/u);
  const cut = stop < 0 ? reply.length : end + stop + 1;
  const questions = sentencesOf(reply.slice(cut)).filter((sentence) => /[？?]\s*$/u.test(sentence));
  return `${reply.slice(0, cut)}${questions.join("")}`.trim();
}

// `researchCopied` (a reply listing a research thread's figures was sent back) was removed on 2026-11-22: a belief checked on the spot is
// answered with its data and links (「你的认知｜判定｜数据与纠偏」), which is what the person asked for.

/** Dates as anyone writes them: 「11 月 24 日」, 「11/24」, 「2026-11-24」. */
const DATE_WRITTEN = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])|\d{4}-(\d{2})-(\d{2})/gu;
/**
 * The dates a text writes, as written (「11 月 20 日」, 「12/5」): what the ledger snapshot lists as the days the person gave (2026-11-25),
 * so the dialogue sees which days it may name.
 */
export const datesWritten = (text: string): string[] => [...new Set([...text.matchAll(DATE_WRITTEN)].map((match) => match[0].replace(/\s+/gu, " ").trim()))];
