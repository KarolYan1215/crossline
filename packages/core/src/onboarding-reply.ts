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

/** Questions that ask for one story the person tells as their best: a story told once is told the same way when asked again. */
const STORY_ASK = /最骄傲|最自豪|最有成就感|最得意|高峰/u;
const ELSE_THAN = /之外|以外|除了|另一件|别的一件|还有哪/u;

/**
 * A question asking for the person's best story, once one was asked for already, excludes the story told (「除了前面讲过的那件，……」).
 * Replay 10 asked 「最有成就感的事」 in round 1 and 「近一年最骄傲的一件事」 in round 20, and she told the same exam word for word.
 */
export function withoutToldStory<T extends Pick<TurnQuestion, "text">>(questions: T[], askedBefore: string[]): T[] {
  if (!askedBefore.some((text) => STORY_ASK.test(text))) return questions;
  return questions.map((question) => STORY_ASK.test(question.text) && !ELSE_THAN.test(question.text)
    ? { ...question, text: `除了前面讲过的那件，${question.text}` } : question); // i18n-ignore: only a Chinese question matches `STORY_ASK`
}

/** Dates, times, counts and amounts as written: what a research conclusion is made of. */
const FIGURE = /\d{1,4}\s*(?:年|月|日|号|点|时|小时|天|周|%|％|万|元|岁|人)/gu;
const squeeze = (text: string) => text.replace(/\s/gu, "");

/**
 * How many figures of a research conclusion a reply may repeat: one conclusion that changes the next step needs two at most (「8 点前到岗、
 * 18 点后离行」); replay 10's rounds 14 and 15, which listed the threads, had six and three.
 */
export const RESEARCH_FIGURES_MAX = 2;

/**
 * The figures of the finished research threads the reply repeats, each once. The Skill says a reply keeps one conclusion that changes
 * the next step and leaves the dates and thresholds to the right column; replay 10 still put every firm's deadline into three replies.
 */
export function researchCopied(reply: string, findings: string[]): string[] {
  const found = new Set(findings.flatMap((text) => (text.match(FIGURE) ?? []).map(squeeze)));
  return [...new Set((reply.match(FIGURE) ?? []).map(squeeze))].filter((figure) => found.has(figure));
}

const pairsOf = (text: string): Set<string> => {
  const plain = text.replace(/[\s，。！？、；：「」『』（）,.!?;:()"'“”‘’]/gu, "");
  const pairs = new Set<string>();
  for (let at = 0; at + 1 < plain.length; at += 1) pairs.add(plain.slice(at, at + 2));
  return pairs;
};

/** A sentence whose character pairs are at least this much in the card says the card again. */
const ECHO_SHARE = 0.5;

/**
 * The reply without the sentences the observation card beside it already says. Replay 10's round 13 put the same guess in both, and the
 * person read it twice; the card is where it can be rated, so the reply's copy goes. A reply left empty keeps its words.
 */
export function withoutCardEcho(reply: string, card: string | undefined): string {
  const cardPairs = pairsOf(card ?? "");
  if (!cardPairs.size) return reply;
  const kept = sentencesOf(reply).filter((sentence) => {
    const pairs = pairsOf(sentence);
    if (pairs.size < 8) return true;
    let shared = 0;
    for (const pair of pairs) if (cardPairs.has(pair)) shared += 1;
    return shared / pairs.size < ECHO_SHARE;
  });
  return kept.join("").trim() || reply;
}

/**
 * The reply without telling the person something is 「还在记录」. The extraction runs behind the dialogue, and replay 10 said 「时段还在记录，记
 * 下后就能开始使用」 two rounds after she gave the hours: to her they were answered. What is being recorded is not asked again (`recording`),
 * and once it is on record the reply says the app can be used.
 */
export function withoutRecordingTalk(reply: string): string {
  return sentencesOf(reply).filter((sentence) => !/还在记录|正在记录|记下后就|记录完就/u.test(sentence)).join("").trim() || reply;
}

/** The closing question, the app's or the model's own words for it. */
export const CLOSING_ASK = /还有(?:什么|没有别的|别的|没有什么)(?:想聊|想说|要聊|要说)/u;
/** An answer saying there is nothing more. */
const NOTHING_MORE = /没有了|没了|没有别的|就这些|不用了|暂时没有|没有想聊|没什么/u;

/**
 * Whether the person just said there is nothing more to talk about, answering the closing question the last round asked. Then the next
 * round asks nothing: replay 10 asked 「还有什么想聊的吗」, she answered 「没有了」, and the next round asked it again.
 */
export function saidNothingMore(lastQuestions: Array<Pick<TurnQuestion, "id" | "text">>, replyText: string): boolean {
  const asked = lastQuestions.filter((question) => question.id === "closing-open" || CLOSING_ASK.test(question.text));
  if (!asked.length) return false;
  // The page writes an answer as 「【question】选择：…」. The closing question answered with nothing more, and no words outside an answer, is the
  // person saying so; answers to the round's other questions (replay 11: the cartoon figure's look, asked beside it) do not change that.
  const parts = replyText.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  const answers = parts.map((line) => /^【([^】]*)】(.*)$/u.exec(line));
  if (!answers.some((answer) => answer)) return parts.length > 0 && parts.every((line) => NOTHING_MORE.test(line) && line.length <= 20);
  return answers.every(Boolean) && answers.some((answer) => CLOSING_ASK.test(answer![1]!) && NOTHING_MORE.test(answer![2]!));
}

/** A date the reply says something is set for: 「定在 11 月 17 日」. */
const SET_FOR = /(?:定在|定于|安排在|放在|约在|就在|改到|挪到)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu;
/** Dates as anyone writes them: 「11 月 24 日」, 「11/24」, 「2026-11-24」. */
const DATE_WRITTEN = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]|(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])|\d{4}-(\d{2})-(\d{2})/gu;
const WEEKDAY_CHAR = "日一二三四五六"; // i18n-ignore: matched against the reply, never shown

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
