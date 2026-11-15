import {
  CARDS_OFFERED, INSIGHTS_PER_ROUND, cardCandidateIds, checkInsight, hypothesisReplies, isWebUrl, locateQuote, questionSimilarity,
  type DimensionId, type Hypothesis, type LedgerQuestion, type ProfileGap, type ResearchRequest, type ResearchThread, type TurnInsight, type TurnQuestion
} from "@crossline/core";
import { RESEARCH_OPEN_MAX } from "./onboarding-research";

/**
 * What the interview's dialogue puts in front of the person — questions, the app's own waiting questions, observation cards, research
 * threads — checked item by item (2026-11-14 audit, docs/onboarding-validation-audit.md §3.3–3.5). Every check answers with the problem
 * in words the model can act on; nothing here rewrites or quietly drops what the model wrote. The interview sends the problems back in
 * the same round (`onboarding-session.ts`), and keeps an item only once it passes.
 *
 * What stays a hard limit is a fact the model cannot see for itself: the round's size, the ledger's count of askings, a quote's place in a
 * reply, a disclosure, a hypothesis already asked. Whether two questions are the same question is the model's to judge: the likeness of
 * their words is only a hint, answered with what the person said, and a follow-up says so (`followUp`).
 */

/** Questions in one round, the app's own included (the schema's `maxItems` says the same). */
export const ROUND_QUESTIONS = 5;
/** Research questions one round may raise (the schema's `maxItems`). */
export const ROUND_RESEARCH = 3;
/** A question this alike an answered one is pointed out as possibly the same (a hint, never a removal). */
export const LIKE_ANSWERED = 0.85;
/** About the same line and project a lower likeness is pointed out: the model rewords what it asks. */
export const LIKE_SAME_LINE = 0.6;
/** However it is worded, one question is put to the person at most this many times (a follow-up is a new question). */
export const MAX_ASKINGS = 2;

export type CardCheck<T> = { accepted: T[]; problems: string[] };

/** What the questions are checked against: the interview's ledger (dropped ones left out) and the app's own questions still waiting. */
export type QuestionContext = { ledger: LedgerQuestion[]; openItems: ProfileGap[] };

const alike = (a: { text: string; identityId: string; projectId: string }, b: { text: string; identityId: string; projectId: string }) => {
  if (a.projectId && b.projectId && a.projectId !== b.projectId) return false;
  if (a.identityId && b.identityId && a.identityId !== b.identityId) return false;
  const similarity = questionSimilarity(a.text, b.text);
  return similarity >= LIKE_ANSWERED || (Boolean(a.identityId) && a.identityId === b.identityId && a.projectId === b.projectId && similarity >= LIKE_SAME_LINE);
};
const optionKey = (label: string) => label.replace(/[\s，,。.、；;：:（）()「」]/g, "").toLowerCase();
const short = (text: string, max = 60) => text.length > max ? `${text.slice(0, max)}…` : text;

/* i18n-ignore-start: problems sent back to the interview model */
/**
 * The model's questions for this round, after `already` (what this round holds so far). A question is refused only for its structure, the
 * round's size or the ledger's count of askings; a question like one answered comes back with that answer, and stays refused until the
 * model rewrites it or marks it a follow-up.
 */
export function checkQuestions(questions: TurnQuestion[], context: QuestionContext, already: TurnQuestion[] = []): CardCheck<TurnQuestion> {
  const accepted: TurnQuestion[] = [];
  const problems: string[] = [];
  const byId = new Map(context.ledger.map((question) => [question.id, question]));
  const answered = context.ledger.filter((question) => question.status === "answered" || question.status === "assumed");
  const ownAsked = context.ledger.filter((question) => !question.key.startsWith("gap:"));
  const waiting = new Set(context.openItems.map((gap) => gap.question.id));
  for (const question of questions) {
    const label = `「${short(question.text)}」`;
    const round = [...already, ...accepted];
    if (round.some((other) => other.id === question.id)) { problems.push(`${label}的 id「${question.id}」这一轮已经用过，换一个。`); continue; }
    if (round.length >= ROUND_QUESTIONS) { problems.push(`这一轮已有 ${ROUND_QUESTIONS} 道题，${label}放到下一轮。`); continue; }
    const labels = question.options.map((option) => optionKey(option.label ?? ""));
    const repeated = question.options.find((option, index) => labels.indexOf(optionKey(option.label ?? "")) !== index);
    if (repeated) { problems.push(`${label}的选项「${repeated.label}」重复了，每个选项说一件不同的事。`); continue; }
    const named = question.repeats ? byId.get(question.repeats) : undefined;
    // The app's own waiting question asked in the model's words: its answer would not be read as the fact it settles.
    const gapId = named?.key.startsWith("gap:") ? named.key.slice(4) : "";
    if (gapId && waiting.has(gapId)) { problems.push(`${label}问的是应用自己的待办题 #${named!.id}：把「${gapId}」放进 openItems，应用照原样出卡，不要换说法问。`); continue; }
    if (!question.followUp) {
      const twin = named && (named.status === "answered" || named.status === "assumed") ? named : answered.find((item) => alike(item, question));
      if (twin) {
        problems.push(`${label}和 #${twin.id}「${short(twin.text)}」像是同一个问题，本人答过：「${short(twin.answer || "（跳过）", 120)}」。`
          + "是在这个回答上往深问，就让题干接住它并设 followUp: true；不是就不再问。");
        continue;
      }
      const sameRound = round.find((other) => alike(other, question));
      if (sameRound) { problems.push(`${label}和这一轮的「${short(sameRound.text)}」问的像是同一件事，留一个。`); continue; }
      const near = ownAsked.filter((item) => item.id === named?.id || alike(item, question));
      const earlier = ownAsked.filter((item) => near.includes(item) || near.some((other) => alike(other, item)));
      if (earlier.length >= MAX_ASKINGS) {
        problems.push(`${label}这件事已经问过 ${earlier.length} 次（${earlier.map((item) => `#${item.id}`).join("、")}），不再问；没答清的按可改的假设记，在 reply 里说一次。`);
        continue;
      }
    }
    accepted.push({ ...question, repeats: question.repeats && byId.has(question.repeats) ? question.repeats : 0 });
  }
  return { accepted, problems };
}

/**
 * The app's own waiting questions the dialogue puts to the person (`openItems`), by id: shown as the app wrote them, so a tap settles the
 * fact (`answeredGapFacts`). They count in the round's size.
 */
export function checkOpenItems(ids: string[], openItems: ProfileGap[], already: TurnQuestion[] = []): CardCheck<TurnQuestion> {
  const accepted: TurnQuestion[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const gap = openItems.find((item) => item.question.id === id);
    const round = [...already, ...accepted];
    if (!gap) { problems.push(`openItems 里的「${id}」不是本轮 openItems 列出的待办题；只能用列出的 id。`); continue; }
    if (round.some((question) => question.id === id)) continue;
    if (round.length >= ROUND_QUESTIONS) { problems.push(`这一轮已有 ${ROUND_QUESTIONS} 道题，待办题「${id}」放到下一轮。`); continue; }
    accepted.push(gap.question);
  }
  return { accepted, problems };
}

/** What an observation card is checked against. */
export type InsightContext = {
  /** Every reply of the conversation by `reply-N`. */
  replies: Record<string, string>;
  /** Replies a disclosure of self-harm sits in (`disclosureReplies`): never a card's evidence. */
  sensitive: ReadonlySet<string>;
  /** A line's own interview shows no observation cards. */
  focusLine: boolean;
  /** The round's stage, for `checkInsight`. */
  stage: string;
  /** Under the points rules a card asks about one hypothesis of the log. */
  rules: boolean;
  hypotheses: Hypothesis[];
  /** Cards shown in earlier rounds: their words and the hypotheses they asked about. */
  earlier: TurnInsight[];
};

/** A card that passed: as it will be shown, and, when it is a new inference, the dimension the log adds it under. */
export type CheckedInsight = { card: TurnInsight; fresh?: { dimension: DimensionId | undefined } };

const squeeze = (text: string) => text.replace(/\s/gu, "");

/**
 * The round's observation cards, after `already`. Each refusal names what to fix: a quote not found in the reply it names, a disclosure
 * cited, too few replies, a hypothesis already asked or refuted, a new inference while the log still offers candidates.
 */
export function checkInsights(insights: TurnInsight[], context: InsightContext, already: CheckedInsight[] = []): CardCheck<CheckedInsight> {
  const accepted: CheckedInsight[] = [];
  const problems: string[] = [];
  if (!insights.length) return { accepted, problems };
  if (context.focusLine) return { accepted, problems: ["单条主线的访谈不出观察卡，insights 写 []。"] };
  const offered = context.rules ? cardCandidateIds(context.hypotheses, CARDS_OFFERED) : [];
  const askedIds = new Set(context.earlier.map((card) => card.hypothesisId ?? "").filter(Boolean));
  const shown = new Set(context.earlier.map((card) => squeeze(card.text)));
  for (const written of insights) {
    const round = [...already, ...accepted];
    const label = `观察卡「${short(written.text ?? "", 30)}」`;
    if (round.length >= INSIGHTS_PER_ROUND) { problems.push(`这一轮已有 ${INSIGHTS_PER_ROUND} 张观察卡，${label}放到下一轮。`); continue; }
    if (!written.text?.trim() || !written.falsifier?.trim()) { problems.push(`${label}缺 text 或 falsifier。`); continue; }
    const refs = written.refs ?? [];
    const missing = refs.find((ref) => !(ref.replyId in context.replies) || !locateQuote(context.replies[ref.replyId]!, ref.quote ?? ""));
    if (missing) { problems.push(`${label}的引文「${short(missing.quote ?? "", 40)}」不在 ${missing.replyId} 里：逐字照抄本人原话，不超过 40 字。`); continue; }
    const disclosed = refs.find((ref) => context.sensitive.has(ref.replyId));
    if (disclosed) { problems.push(`${label}引了 ${disclosed.replyId}：那是本人谈到自伤的回答，不作观察卡的依据。`); continue; }
    const badUrl = (written.external ?? []).find((item) => !isWebUrl(item?.url));
    if (badUrl) { problems.push(`${label}的 external「${short(badUrl.text ?? "", 30)}」没有可打开的网页地址；没有来源就不写这条。`); continue; }
    if (shown.has(squeeze(written.text)) || round.some((item) => squeeze(item.card.text) === squeeze(written.text))) {
      problems.push(`${label}这段话之前出过，换一个推断或不出。`); continue;
    }
    const named = context.rules ? written.hypothesisId?.trim() ?? "" : "";
    const onRecord = named ? context.hypotheses.find((item) => item.id === named) : undefined;
    if (named && !onRecord) { problems.push(`${label}的 hypothesisId「${named}」不在假设日志里；从 cardFrom 选，新推断写 ""。`); continue; }
    if (onRecord && (onRecord.cardKey || askedIds.has(onRecord.id) || onRecord.status === "refuted")) {
      problems.push(`${label}问的假设 ${onRecord.id} 已经出过卡或被推翻，不再出。`); continue;
    }
    if (onRecord && round.some((item) => item.card.hypothesisId === onRecord.id)) { problems.push(`${label}和这一轮另一张卡问的是同一条假设 ${onRecord.id}。`); continue; }
    if (context.rules && !onRecord) {
      if (offered.length) { problems.push(`${label}是新推断，可 cardFrom 里还有候选（${offered.join("、")}）：先从中出卡，新推断等候选用完。`); continue; }
      if (round.some((item) => item.fresh)) { problems.push(`${label}：新推断一轮最多一张。`); continue; }
    }
    // An uncertain hypothesis the log offered on one reply puts both explanations and may cite that one reply (`cardCandidates`).
    const minReplies = onRecord && offered.includes(onRecord.id) && hypothesisReplies(onRecord).length < 2 ? 1 : 2;
    if (new Set(refs.map((ref) => ref.replyId)).size < minReplies) {
      problems.push(`${label}要引至少 ${minReplies} 条不同回答的原话：观察是把本人说过的几件事连起来。`); continue;
    }
    const checked = checkInsight(written, context.replies, context.stage, minReplies);
    if (!checked) { problems.push(`${label}没有通过核对（text、falsifier、引文）。`); continue; }
    if (!context.rules) { accepted.push({ card: checked }); continue; }
    accepted.push(onRecord ? { card: { ...checked, hypothesisId: onRecord.id, dimension: onRecord.dimension } }
      : { card: checked, fresh: { dimension: written.dimension } });
  }
  return { accepted, problems };
}

const researchKey = (text: string) => text.replace(/[\s，。？?！!、,.]/gu, "").toLowerCase();

/** The round's research questions, after `already`: not one a thread already has, within the threads that may be open at once. */
export function checkResearch(asked: ResearchRequest[], threads: ResearchThread[], already: ResearchRequest[] = []): CardCheck<ResearchRequest> {
  const accepted: ResearchRequest[] = [];
  const problems: string[] = [];
  const open = threads.filter((thread) => thread.status === "running" || thread.status === "asking").length;
  for (const item of asked) {
    const round = [...already, ...accepted];
    const key = researchKey(item.question);
    const thread = threads.find((other) => researchKey(other.question) === key);
    if (thread) { problems.push(`调研「${short(item.question)}」已经有线程（${thread.status}），不再提。`); continue; }
    if (round.some((other) => researchKey(other.question) === key)) continue;
    if (round.length >= ROUND_RESEARCH) { problems.push(`这一轮已提 ${ROUND_RESEARCH} 个调研问题，「${short(item.question)}」放到下一轮。`); continue; }
    if (open + round.length >= RESEARCH_OPEN_MAX) { problems.push(`同时开着的调研已有 ${RESEARCH_OPEN_MAX} 条，等有结论再提「${short(item.question)}」。`); continue; }
    accepted.push(item);
  }
  return { accepted, problems };
}
/* i18n-ignore-end */
