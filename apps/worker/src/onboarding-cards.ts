import {
  CARDS_OFFERED, INSIGHTS_PER_ROUND, cardCandidateIds, checkInsight, hypothesisReplies, isWebUrl, levelOf, locateQuote, questionSimilarity, roughWindow,
  type DimensionId, type Hypothesis, type LedgerQuestion, type OnboardingStage, type ProfileGap, type ResearchRequest, type ResearchThread, type TurnInsight,
  type TurnProgress, type TurnQuestion, type AskedInReply, type ChecklistVerdict
} from "@crossline/core";
import type { SkillTools } from "@crossline/codex";

/**
 * What the interview's dialogue puts in front of the person — questions, the app's own waiting questions, observation cards, research
 * threads — checked item by item (2026-11-14 audit, docs/onboarding-validation-audit.md §3.3–3.5). Every check answers with the problem
 * in words the model can act on; nothing here rewrites or quietly drops what the model wrote. The interview sends the problems back in
 * the same round (`onboarding-session.ts`), and keeps an item only once it passes.
 *
 * What stays a hard limit is a question's structure and a fact the model cannot see for itself: a quote's place in a reply, a disclosure,
 * a hypothesis already asked. Whether two questions are the same question is the model's to judge against the ledger snapshot (2026-11-25,
 * the owner: 「通过账本来排除，并且要关注更深的语义层面，让模型来确认」): it names the asked question a new one means (`repeats`) and
 * whether it goes deeper on its answer (`followUp`). The wording likeness, the count of askings and the round's size no longer send
 * anything back; when they fire they are recorded (`fired`, written to `rule-fired.jsonl`) so a replay can see whether the fault came back.
 */

/** Questions in one round, the app's own included: the Skill's goal now, recorded when passed (IR-051). */
export const ROUND_QUESTIONS = 5;
/** A question this alike an answered one is recorded as a possible repeat (IR-047; never a refusal). */
export const LIKE_ANSWERED = 0.85;
/** About the same line and project a lower likeness is recorded the same way. */
export const LIKE_SAME_LINE = 0.6;
/** However it is worded, one question is put to the person at most this many times: the Skill's goal, recorded when passed (IR-014). */
export const MAX_ASKINGS = 2;

/** A record-only rule that fired (`ruleFired`): the rule's id in the register and a few words of what fired. */
export type Fired = { rule: string; detail: string };
export type CardCheck<T> = { accepted: T[]; problems: string[]; fired?: Fired[] };

/**
 * What the questions are checked against: the interview's ledger (dropped ones left out), the app's own questions still waiting, the
 * days asked about before (`DateSubject`) and today, for reading an option as a day.
 */
export type QuestionContext = { ledger: LedgerQuestion[]; openItems: ProfileGap[]; dates?: DateSubject[]; today?: string };

/**
 * A date question asked before (its `about`) and the person's answer. Whether the answer left the day open is the model's to read
 * (2026-11-22: the `undecidedDay` pattern that guessed it from 「还没定」 and the like was removed); either way it is not asked again.
 */
export type DateSubject = { about: string; answer: string };
const aboutKey = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
/** Whether two `about`s name the same thing: equal, or one holds the other (「复工」 and 「复工日期」). */
export function sameAbout(a: string, b: string): boolean {
  const x = aboutKey(a), y = aboutKey(b);
  return Boolean(x && y) && (x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))));
}
/** An option that is a day or a window of days (「十一月底」「下周二」「11/20」), not a weekday as such (「周一」). */
export const dayOption = (label: string, today: string): boolean =>
  Boolean(roughWindow(label, today)) || /\d{1,2}\s*[/月.]\s*\d{1,2}|[本这下]个?(周|星期|礼拜)[一二三四五六日天]/u.test(label); // i18n-ignore: matched against options

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
 * The model's questions for this round, after `already` (what this round holds so far). A question is refused for its structure (a reused
 * id, repeated options, days as options, a date question without its subject), for asking the app's own waiting question in other words,
 * and for being, by the model's own `repeats`, an answered question asked again without going deeper. Everything else the old checks
 * caught — wording like an answered question, a subject's day asked again, a third asking, a sixth question in the round — is recorded
 * (`fired`) and the question stands: the model judged it against the snapshot.
 */
export function checkQuestions(questions: TurnQuestion[], context: QuestionContext, already: TurnQuestion[] = []): CardCheck<TurnQuestion> {
  const accepted: TurnQuestion[] = [];
  const problems: string[] = [];
  const fired: Fired[] = [];
  const byId = new Map(context.ledger.map((question) => [question.id, question]));
  const answered = context.ledger.filter((question) => question.status === "answered" || question.status === "assumed");
  const ownAsked = context.ledger.filter((question) => !question.key.startsWith("gap:"));
  const waiting = new Set(context.openItems.map((gap) => gap.question.id));
  for (const question of questions) {
    const label = `「${short(question.text)}」`;
    const round = [...already, ...accepted];
    if (round.some((other) => other.id === question.id)) { problems.push(`${label}的 id「${question.id}」这一轮已经用过，换一个。`); continue; }
    if (round.length >= ROUND_QUESTIONS) fired.push({ rule: "IR-051", detail: `round holds ${round.length + 1} questions` });
    const labels = question.options.map((option) => optionKey(option.label ?? ""));
    const repeated = question.options.find((option, index) => labels.indexOf(optionKey(option.label ?? "")) !== index);
    if (repeated) { problems.push(`${label}的选项「${repeated.label}」重复了，每个选项说一件不同的事。`); continue; }
    // Days (2026-11-15, replay 15 asked one resume date six times in other words): the day is the person's to set, so it is asked
    // without options, under a subject kept the same each time, and a subject the person answered is not asked again.
    const days = context.today ? question.options.filter((option) => dayOption(option.label ?? "", context.today!)) : [];
    if (days.length >= 2) {
      problems.push(`${label}的选项是日子（${days.slice(0, 3).map((option) => `「${option.label}」`).join("")}）：日期由本人定，改成不带选项的 free，date 设 true，about 写是哪件事的日子。`);
      continue;
    }
    if (question.date) {
      if (!question.about?.trim()) { problems.push(`${label}问的是日子：about 写这是哪件事的日子，几个字，同一件事每次用同一个叫法。`); continue; }
      const before = (context.dates ?? []).find((item) => sameAbout(item.about, question.about!));
      if (before && !question.followUp) fired.push({ rule: "IR-126", detail: `date subject asked again: ${short(before.about, 30)}` });
      const twinDay = round.find((other) => other.date && other.about && sameAbout(other.about, question.about!));
      if (twinDay) fired.push({ rule: "IR-126", detail: `two date questions on one subject in a round: ${short(question.about, 30)}` });
    }
    const named = question.repeats ? byId.get(question.repeats) : undefined;
    // The app's own waiting question asked in the model's words: its answer would not be read as the fact it settles.
    const gapId = named?.key.startsWith("gap:") ? named.key.slice(4) : "";
    if (gapId && waiting.has(gapId)) { problems.push(`${label}问的是应用自己的待办题 #${named!.id}：把「${gapId}」放进 openItems，应用照原样出卡，不要换说法问。`); continue; }
    if (!question.followUp) {
      // The model's own verdict: it said this is the answered question #n asked again, and not deeper. The answer goes back with it.
      if (named && (named.status === "answered" || named.status === "assumed")) {
        problems.push(`${label}你标了和 #${named.id}「${short(named.text)}」是同一个问题，本人答过：「${short(named.answer || "（跳过）", 120)}」。`
          + "是在这个回答上往深问，就让题干接住它并设 followUp: true；不是就不再问。");
        continue;
      }
      // By wording alone (IR-047, IR-014): recorded for the replays, never sent back. Two projects on one line asked in one pattern read as
      // one question by wording (2026-11-22, W-308), which is why the likeness is no verdict.
      const like = (item: Parameters<typeof alike>[0]) => !question.date && alike(item, question);
      const twin = answered.find(like);
      if (twin) fired.push({ rule: "IR-047", detail: `alike answered #${twin.id}, repeats ${question.repeats ?? 0}` });
      const near = ownAsked.filter((item) => item.id === named?.id || like(item));
      const earlier = ownAsked.filter((item) => near.includes(item) || near.some((other) => alike(other, item)));
      if (earlier.length >= MAX_ASKINGS) fired.push({ rule: "IR-014", detail: `asked ${earlier.length} times before: ${earlier.map((item) => `#${item.id}`).join(",")}` });
    }
    accepted.push({ ...question, repeats: question.repeats && byId.has(question.repeats) ? question.repeats : 0 });
  }
  return { accepted, problems, fired };
}

/**
 * The questions the reply itself asks, as the model declares them in `mark_round.asked` (2026-11-25): each with its meaning (`gist`) and the
 * asked question it means, by the model's own reading of the snapshot (`repeats`, 0 for none). Refused only for its structure and for the
 * model's own verdict that it repeats an answered question without going deeper.
 */
export function checkAsked(asked: AskedInReply[], ledger: LedgerQuestion[]): CardCheck<AskedInReply> {
  const accepted: AskedInReply[] = [];
  const problems: string[] = [];
  const byId = new Map(ledger.map((question) => [question.id, question]));
  for (const item of asked) {
    const label = `回复里的问题「${short(item.text ?? "")}」`;
    if (!item.text?.trim() || !item.gist?.trim()) { problems.push(`${label}要写 text（原话）和 gist（问的是什么，几个字）。`); continue; }
    const named = item.repeats ? byId.get(item.repeats) : undefined;
    if (item.repeats && !named) { problems.push(`${label}的 repeats「${item.repeats}」不在账本快照的已问题目里；没有意思相同的写 0。`); continue; }
    if (named && (named.status === "answered" || named.status === "assumed") && !item.followUp) {
      problems.push(`${label}你标了和 #${named.id}「${short(named.text)}」是同一个问题，本人答过：「${short(named.answer || "（跳过）", 120)}」。`
        + "往深问就在回复里接住这个回答并设 followUp: true；不是就换一个问题。");
      continue;
    }
    accepted.push({ text: item.text.trim(), gist: item.gist.trim(), repeats: named ? named.id : 0, followUp: Boolean(item.followUp) });
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
  const fired: Fired[] = [];
  for (const id of ids) {
    const gap = openItems.find((item) => item.question.id === id);
    const round = [...already, ...accepted];
    if (!gap) { problems.push(`openItems 里的「${id}」不是本轮 openItems 列出的待办题；只能用列出的 id。`); continue; }
    if (round.some((question) => question.id === id)) continue;
    if (round.length >= ROUND_QUESTIONS) fired.push({ rule: "IR-051", detail: `round holds ${round.length + 1} questions` });
    accepted.push(gap.question);
  }
  return { accepted, problems, fired };
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
 * cited, too few replies, a hypothesis already asked or refuted. Whether a card comes from the log or is the dialogue's own is its choice.
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
    // Only the second level goes on a card (2026-11-22, docs/plans/portrait-depth-1122.md §一).
    if (onRecord && levelOf(onRecord) !== 2) {
      problems.push(levelOf(onRecord) === 3 ? `${label}问的假设 ${onRecord.id} 是第三级（和本人对自己的解释相反）：留给报告，不上卡，也不在回复里说。`
        : `${label}问的假设 ${onRecord.id} 是第一级（本人自己说过的）：上卡只是复述，不出。`); continue;
    }
    if (onRecord && round.some((item) => item.card.hypothesisId === onRecord.id)) { problems.push(`${label}和这一轮另一张卡问的是同一条假设 ${onRecord.id}。`); continue; }
    // The log's candidates are offered, not imposed (2026-11-17, the owner: give the model information and a goal, not a gate). A new
    // inference the dialogue drew from the whole conversation goes on a card beside them, as many as the round holds; replay 6's failure
    // (every card new, the log never asked) is watched in the replays, not refused here.
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

/**
 * The round's research questions, after `already`: not one a thread already has. However many (2026-11-22: the caps of three a round and
 * four open were removed; the model gate and the spend cap bound the cost).
 */
export function checkResearch(asked: ResearchRequest[], threads: ResearchThread[], already: ResearchRequest[] = []): CardCheck<ResearchRequest> {
  const accepted: ResearchRequest[] = [];
  const problems: string[] = [];
  for (const item of asked) {
    const round = [...already, ...accepted];
    const key = researchKey(item.question);
    const thread = threads.find((other) => researchKey(other.question) === key);
    if (thread) { problems.push(`调研「${short(item.question)}」已经有线程（${thread.status}），不再提。`); continue; }
    if (round.some((other) => researchKey(other.question) === key)) continue;
    accepted.push(item);
  }
  return { accepted, problems };
}
/* i18n-ignore-end */

/**
 * The round's items handed in through the card tools (P2b-3b, docs/onboarding-agent-session.md D1): each kept the moment its check passes,
 * so the model fixes a failing one in the same turn, with the tool's answer, instead of after the whole round came back.
 */
export type RoundDraft = { questions: TurnQuestion[]; openItems: string[]; insights: TurnInsight[]; research: ResearchRequest[];
  /**
   * What the round says of itself through `mark_round` (2026-11-22, the free-text reply): the ledger part it is in, whether it answers a
   * disclosure (`safety`), whether it asks the lesson question, its progress record, and, in a line's own interview, that it is done.
   */
  meta?: RoundMeta };
export type RoundMeta = { stage?: OnboardingStage; safety?: boolean; askLesson?: boolean; progress?: TurnProgress; ready?: boolean;
  /** The model's verdict per checklist item against the ledger snapshot (2026-11-25): written to the session, read by the checklist. */
  checklist?: ChecklistVerdict[];
  /** The questions the reply itself asks, with their meaning: written to the question ledger, so the next snapshot lists them. */
  asked?: AskedInReply[] };
export const emptyDraft = (): RoundDraft => ({ questions: [], openItems: [], insights: [], research: [] });

/* i18n-ignore-start: tool answers and problems for the model */
/** What `checkTurn` would refuse the whole answer for, said of one question as it is handed in. */
export function questionShape(question: TurnQuestion, ids: { lines: readonly string[]; projects: readonly string[] }): string[] {
  const problems: string[] = [];
  const name = `问题「${question.id}」`;
  if (!question.id || !question.text?.trim()) problems.push("问题要有 id 和题干。");
  if (question.identityId && !ids.lines.includes(question.identityId)) problems.push(`${name}的主线「${question.identityId}」不存在。`);
  if (question.projectId && !ids.projects.includes(question.projectId)) problems.push(`${name}引用了不存在的项目「${question.projectId}」。`);
  const options = Array.isArray(question.options) ? question.options : [];
  if (new Set(options.map((option) => option.id)).size !== options.length) problems.push(`${name}的选项 id 有重复。`);
  if (question.kind !== "free" && options.length < 2) problems.push(`${name}是选择题，至少要给 2 个候选。`);
  return problems;
}

export const CARD_TOOL_NAMES = ["ask_question", "ask_app_question", "show_observation", "open_research", "mark_round"] as const;

/**
 * How the dialogue is told to use the tools, appended to its instructions on a route that calls functions. There the round's answer is
 * the final message itself, in free text (2026-11-22): what the person reads. The cards, the safety mark and the part of the ledger go
 * through the tools.
 */
export const CARD_TOOLS_INSTRUCTIONS = "你的最终消息就是本人读到的回复，直接写正文，不写 JSON。主问题写在回复里。工具只交回复旁边的东西，调完工具一定接着写这条最终消息：只调工具、不写正文，本人什么也看不到。"
  + "要放在回复旁边的东西用工具交：`ask_question`（一道带选项的题，真的有几个互斥的选项时才用）、`ask_app_question`（`openItems` 里应用的一道待问题，给它的 `id`）、"
  + "`show_observation`（一张观察卡）、`open_research`（交给后台调研线程的问题）、`mark_round`（这一轮在访谈的哪一部分、是否按「安全」一节回应、是否要问那道固定的题；单条主线的访谈问完时 `ready: true`）。"
  + "每次调用当场核对：回「收下」就已经放进这一轮；回的是问题，就按说的改好再调用，或者不要这一项。"
  + "访谈状态（进度、开始标准、问题记录、调研线程、量表读数、日历）用 `read_interview_state` 读，账本和文件用 `read_ledger`、`read_file` 读，需要时再读。";

/**
 * The card tools, over one round's draft. `check` runs the round's checks on the draft with the new item (`deskCheck` in the session):
 * the items already kept passed them, so whatever it reports is the new item's. A failing call is answered as a tool error and changes
 * nothing; the final answer's fields are merged after the draft (`withDraft`), so a model that writes them there instead is checked the same.
 */
export function cardTools(input: {
  schemas: { question: Record<string, unknown>; insight: Record<string, unknown>; research: Record<string, unknown>; round?: Record<string, unknown> };
  ids: () => { lines: readonly string[]; projects: readonly string[] };
  check: (draft: RoundDraft) => string[];
  draft: () => RoundDraft;
}): SkillTools {
  const specs: SkillTools["specs"] = [
    { name: "ask_question", description: "交这一轮你自己的一道问题（字段同输出的 questions 的一项）。当场核对，回「收下」或要改的问题。", inputSchema: input.schemas.question },
    { name: "ask_app_question", description: "问 openItems 里应用自己的一道待问题，按应用的写法和选项发给本人。给它的 id。", inputSchema: {
      type: "object", properties: { id: { type: "string", maxLength: 80 } }, required: ["id"], additionalProperties: false } },
    { name: "show_observation", description: "交一张观察卡（字段同输出的 insights 的一项）。当场核对引文和假设日志，回「收下」或要改的问题。", inputSchema: input.schemas.insight },
    { name: "open_research", description: "提一个交给后台调研线程的问题（字段同输出的 research 的一项）。当场核对，回「收下」或要改的问题。", inputSchema: input.schemas.research },
    ...(input.schemas.round ? [{ name: "mark_round", description: "说这一轮自己的事：stage（在访谈的哪一部分）、safety（这一轮按「安全」一节回应本人）、askLesson（问那道固定的题）、progress（进度记录）、ready（单条主线的访谈已问完）、"
      + "checklist（对照账本快照逐项判定清单：status 和 reply-N/src-N 的逐字依据）、asked（回复里问的题：原话、gist、repeats、followUp）。可以调用多次，后一次覆盖前一次给的字段。",
      inputSchema: input.schemas.round }] : [])
  ];
  const call = (name: string, args: unknown): string => {
    const value = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const draft = input.draft();
    const next: RoundDraft = { questions: [...draft.questions], openItems: [...draft.openItems], insights: [...draft.insights], research: [...draft.research] };
    let shape: string[] = [];
    let label = "";
    if (name === "ask_question") {
      const question = { allowOther: true, identityId: "", projectId: "", options: [], repeats: 0, ...value } as unknown as TurnQuestion;
      shape = questionShape(question, input.ids());
      next.questions.push(question);
      label = `问题「${question.id}」`;
    } else if (name === "ask_app_question") {
      const id = String(value.id ?? "");
      next.openItems.push(id);
      label = `待问题「${id}」`;
    } else if (name === "show_observation") {
      next.insights.push({ hypothesisId: "", external: [], refs: [], ...value } as unknown as TurnInsight);
      label = "观察卡";
    } else if (name === "open_research") {
      next.research.push(value as ResearchRequest);
      label = `调研「${short(String(value.question ?? ""))}」`;
    } else if (name === "mark_round") {
      next.meta = { ...(draft.meta ?? {}), ...(value as RoundMeta) };
      label = "这一轮的标记";
    } else throw new Error(`没有名为 ${name} 的工具`);
    const problems = shape.length ? shape : input.check(next);
    if (problems.length) throw new Error(`没收下，${label}要改：\n- ${problems.join("\n- ")}`);
    Object.assign(draft, next);
    const count = draft.questions.length + draft.openItems.length;
    // The model treated a kept `mark_round` as the end of its turn in 7 of 12 replayed rounds (2026-11-25): each cost a second turn.
    return `收下：${label}。这一轮已有 ${count} 道题${draft.insights.length ? `、${draft.insights.length} 张观察卡` : ""}。${name === "mark_round" ? "工具交完就写最终消息：本人读到的回复正文。" : ""}`;
  };
  return { specs, call };
}
/* i18n-ignore-end */

/** The final answer with the draft's items in front of its own (the merge `cardTools` relies on). */
export function withDraft(output: unknown, draft: RoundDraft): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const value = output as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(value[key]) ? value[key] as unknown[] : []);
  const meta = draft.meta ?? {};
  // `mark_round`'s fields stand over what the final answer said of them (a free-text answer says nothing of them).
  const marked = { ...(meta.stage ? { stage: meta.stage } : {}), ...(meta.safety !== undefined ? { safety: meta.safety } : {}),
    ...(meta.askLesson !== undefined ? { askLesson: meta.askLesson } : {}), ...(meta.progress ? { progress: meta.progress } : {}),
    ...(meta.ready ? { nextAction: "ready_for_milestones" } : {}), ...(meta.checklist ? { checklist: meta.checklist } : {}),
    ...(meta.asked ? { asked: meta.asked } : {}) };
  if (!draft.questions.length && !draft.openItems.length && !draft.insights.length && !draft.research.length) return { ...value, ...marked };
  return { ...value, ...marked, questions: [...draft.questions, ...list("questions")], openItems: [...draft.openItems, ...list("openItems")],
    insights: [...draft.insights, ...list("insights")], research: [...draft.research, ...list("research")] };
}
