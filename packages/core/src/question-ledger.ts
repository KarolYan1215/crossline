/**
 * The question ledger (2026-10-19, P2 of the interview redesign): every question the system or a model has put to the person — the
 * interview's own, the app's added ones, the decisions on 待决 and the questions a step plan asks — kept once, numbered, with its answer.
 * A model about to ask something is shown what was asked and answered and says which numbered question it is repeating (`repeats`), so a
 * duplicate is caught by the ledger rather than by matching words (the old `gapCoveredBy` needed a pattern per kind of question).
 */
export const QUESTION_KINDS = ["interview", "ask"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
/**
 * `pending`: known to be open but not yet shown (the app's own interview questions waiting for a round); `open`: shown, no answer yet;
 * `answered`: the person answered; `assumed`: settled by an assumption the person can correct; `dropped`: no longer asked (its cause went
 * away, or it repeated one already answered).
 */
export const QUESTION_STATUSES = ["pending", "open", "answered", "assumed", "dropped"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type LedgerQuestion = {
  id: number; kind: QuestionKind; key: string; text: string; options: string[]; identityId: string; projectId: string;
  status: QuestionStatus; answer: string; answerSentences: number[]; repeats?: number; askedAt: string; answeredAt?: string;
};

/**
 * An answer that settles nothing: 「不确定」, 「不知道」, 「还不知道」, a skip. A question answered so may be asked once more (2026-10-30: the
 * creator line's current project was answered 「不确定」, a start item takes only the person's word, and the ledger dropped every
 * re-ask as answered — the round fell back to one generic question thirteen rounds running).
 */
export function unsureAnswer(answer: string): boolean {
  const text = answer.replace(/(选择|补充)[:：]/g, "").replace(/[\s。.!！；;，,]+/g, "");
  return !text || /^(还?不(确定|知道|清楚|好说|记得)|暂(时)?不确定|暂不清楚|尚未确定|还没(想好|定)|没想好|说不(好|上来|准|清楚?)|跳过|暂无|unsure|notsure|don'?tknow|skip)$/iu.test(text);
}

/* i18n-ignore-start: patterns read from questions and answers, never shown */
/**
 * A question asking when something will be done (2026-11-14): 「哪天」「几号」「排在哪天」「打算什么时候投」「截止」. Not a question about when
 * something happened (「最近一次……是什么时候」), and not one about free hours (「哪些时段」「什么时间段有空」). The app's own deadline
 * questions ask it too. Replay 13 asked 「大概哪个时间范围内要投出去？」, which the first patterns missed.
 */
export const DATE_ASK = /哪天|哪一天|几号|何时|哪个日期|排在|定在|截止|(打算|准备|计划|想|要).{0,10}什么时候|什么时候.{0,6}(办|投|交|做|开始|完成|出来|定)|when.{0,30}(will|plan|going to)|(哪个|什么)时间(范围|点|之?前)|(多久|多长时间)(之|以)?内|哪一?周(?![一二三四五六日天几])|哪个月|几月|what day|which day|what date|by when/iu;
/**
 * An answer saying the day (or the thing) is not settled yet: 「还没定」「这学期内，具体再定」「看情况」「先选好方向，日期才定得下来」.
 * Replay 12 asked six days, four answered so, and the next rounds asked the next thing's day: a day that cannot be set is an answer,
 * kept as a rough window or left open, and not asked again in other words (`resolveRepeats` in the worker).
 */
export function undecidedAnswer(answer: string): boolean {
  return unsureAnswer(answer) || /还没定|没定下|还没想好|没想好|具体再定|再定|定不下|看情况|看安排|说不准|不确定|还说不好|才定得下/u.test(answer);
}
/* i18n-ignore-end */

/** Letters and digits only, lower case: what a question says, not how it is punctuated. */
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** The same question in the same words, punctuation, spacing and case set aside. */
export const sameQuestion = (a: string, b: string): boolean => { const left = normalize(a); return Boolean(left) && left === normalize(b); };
const bigrams = (text: string) => {
  const chars = [...normalize(text)];
  const out = new Map<string, number>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const pair = chars[index]! + chars[index + 1]!;
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
};

/** Dice similarity of two questions' character pairs, 0–1: a cheap first sort for the ledger's search, never a verdict on its own. */
export function questionSimilarity(a: string, b: string): number {
  const left = bigrams(a), right = bigrams(b);
  const total = [...left.values()].reduce((sum, n) => sum + n, 0) + [...right.values()].reduce((sum, n) => sum + n, 0);
  if (!total) return normalize(a) === normalize(b) && normalize(a) ? 1 : 0;
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  return (2 * shared) / total;
}

/**
 * The answers a reply gives, read from the form every answer card sends (`【question】选择：A；B。补充：text`, one per line): the question's
 * own words in brackets name it, so no model is needed to know which question a line answers.
 */
export function answersInReply(reply: string, questions: Array<{ id: number; text: string }>): Array<{ id: number; answer: string; start: number; end: number }> {
  const out: Array<{ id: number; answer: string; start: number; end: number }> = [];
  for (const question of questions) {
    const marker = `【${question.text}】`;
    const at = reply.indexOf(marker);
    if (at < 0) continue;
    const lineEnd = reply.indexOf("\n", at);
    const end = lineEnd < 0 ? reply.length : lineEnd;
    const answer = reply.slice(at + marker.length, end).trim();
    if (answer) out.push({ id: question.id, answer, start: at, end });
  }
  return out;
}

/** Length of the longest run of characters two normalized texts share. */
const longestShared = (a: string, b: string) => {
  const left = [...a], right = [...b];
  let best = 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const row = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) if (left[i - 1] === right[j - 1]) { row[j] = previous[j - 1]! + 1; best = Math.max(best, row[j]!); }
    previous = row;
  }
  return best;
};
/** A shared run this long (letters and digits) is taken as the reply speaking to that question or one of its options. */
export const FREE_TEXT_OVERLAP = 4;

/**
 * Questions a reply typed in the person's own words answers (2026-10-19: a compass round answered in a paragraph left all four open, and
 * the next rounds asked 「生活应该用来做什么」 again). Only replies with no card answers are read this way; a question counts when one
 * sentence of the reply shares a run of `FREE_TEXT_OVERLAP` characters with the question or one of its options, and that sentence is the answer.
 */
export function freeTextAnswers(reply: string, questions: Array<{ id: number; text: string; options: string[] }>): Array<{ id: number; answer: string; start: number; end: number }> {
  const sentences: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^。！？!?\n；;]+[。！？!?；;]?/gu;
  for (const match of reply.matchAll(pattern)) if (match[0].trim()) sentences.push({ text: match[0], start: match.index!, end: match.index! + match[0].length });
  const out: Array<{ id: number; answer: string; start: number; end: number }> = [];
  for (const question of questions) {
    const targets = [question.text, ...question.options].map(normalize).filter((text) => text.length >= FREE_TEXT_OVERLAP);
    const hit = sentences.find((sentence) => targets.some((target) => longestShared(normalize(sentence.text), target) >= FREE_TEXT_OVERLAP));
    if (hit) out.push({ id: question.id, answer: hit.text.trim().slice(0, 200), start: hit.start, end: hit.end });
  }
  return out;
}

/** One line per question for a model's short index: number, status, the question, and the answer when there is one. */
export function ledgerLines(questions: LedgerQuestion[]): string[] {
  const label: Record<QuestionStatus, string> = { pending: "待问", open: "未答", answered: "已答", assumed: "按假设", dropped: "不再问" }; // i18n-ignore: for the model
  return questions.map((question) => `#${question.id} [${label[question.status]}] ${question.text}${question.answer ? ` → ${question.answer.slice(0, 120)}` : ""}`);
}
