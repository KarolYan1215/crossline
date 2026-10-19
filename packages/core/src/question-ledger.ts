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

/** Letters and digits only, lower case: what a question says, not how it is punctuated. */
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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

/** One line per question for a model's short index: number, status, the question, and the answer when there is one. */
export function ledgerLines(questions: LedgerQuestion[]): string[] {
  const label: Record<QuestionStatus, string> = { pending: "待问", open: "未答", answered: "已答", assumed: "按假设", dropped: "不再问" };
  return questions.map((question) => `#${question.id} [${label[question.status]}] ${question.text}${question.answer ? ` → ${question.answer.slice(0, 120)}` : ""}`);
}
