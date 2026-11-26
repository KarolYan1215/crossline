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

/** A date the reply says something is set for: 「定在 11 月 17 日」. */
const SET_FOR = /(?:定在|定于|安排在|放在|约在|就在|改到|挪到)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu;
/** Dates as anyone writes them: 「11 月 24 日」, 「11/24」, 「2026-11-24」. */
const DATE_WRITTEN = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])|\d{4}-(\d{2})-(\d{2})/gu;
const WEEKDAY_CHAR = "日一二三四五六"; // i18n-ignore: matched against the reply, never shown
/**
 * The dates a text writes, as written (「11 月 20 日」, 「12/5」): what the ledger snapshot lists as the days the person gave (2026-11-25),
 * so the dialogue sees which days it may name. The same pattern `inventedDates` records a reply against.
 */
export const datesWritten = (text: string): string[] => [...new Set([...text.matchAll(DATE_WRITTEN)].map((match) => match[0].replace(/\s+/gu, " ").trim()))];

/**
 * Dates the reply says something is set for that nobody gave: not in the person's replies, the research, the files or the facts on
 * record, not today, and not the day a weekday in the latest reply falls on (「周三就投」 the reply may write as its date). Replay 11
 * (2026-11-14) wrote 「试做定在 11 月 17 日周二」 when she had chosen the trial and said no day; a date is the person's to choose.
 */
export function inventedDates(reply: string, known: string[], latestReply: string, today: string): string[] {
  const day = (month: number, date: number) => `${month}-${date}`;
  const given = new Set<string>();
  for (const text of known) for (const match of text.matchAll(DATE_WRITTEN)) {
    const [month, date] = match[1] ? [match[1], match[2]] : match[3] ? [match[3], match[4]] : [match[5], match[6]];
    given.add(day(Number(month), Number(date)));
  }
  const [year, todayMonth, todayDate] = today.split("-").map(Number) as [number, number, number];
  given.add(day(todayMonth, todayDate));
  const said = new Set([...latestReply.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])/gu)].map((match) => match[1] === "天" ? "日" : match[1]!));
  const invented: string[] = [];
  for (const match of reply.matchAll(SET_FOR)) {
    const month = Number(match[1]);
    const date = Number(match[2]);
    if (given.has(day(month, date))) continue;
    // The year the date falls in: this one, or the next when the month is well behind today's.
    const when = new Date(Date.UTC(month + 6 < todayMonth ? year + 1 : year, month - 1, date));
    if (said.has(WEEKDAY_CHAR[when.getUTCDay()]!)) continue;
    invented.push(`${month} 月 ${date} 日`); // i18n-ignore: quoted back to the model in the repair note
  }
  return [...new Set(invented)];
}
