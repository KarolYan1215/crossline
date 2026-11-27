import {
  INSIGHTS_PER_ROUND, checkInsight, isWebUrl, locateQuote,
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
 * whether it goes deeper on its answer (`followUp`). How many questions a round holds, how often one thing is asked, whether options are
 * days and whether a card repeats an earlier one are the Skill's (2026-11-27, docs/plans/condense-1127.md A6): nothing here counts them.
 */

export type CardCheck<T> = { accepted: T[]; problems: string[] };

/** What the questions are checked against: the interview's ledger (dropped ones left out) and the app's own questions still waiting. */
export type QuestionContext = { ledger: LedgerQuestion[]; openItems: ProfileGap[] };
const optionKey = (label: string) => label.replace(/[\s，,。.、；;：:（）()「」]/g, "").toLowerCase();
const short = (text: string, max = 60) => text.length > max ? `${text.slice(0, max)}…` : text;

/* i18n-ignore-start: problems sent back to the interview model */
/**
 * The model's questions for this round, after `already` (what this round holds so far). A question is refused for its structure (a reused
 * id, repeated options, a date question without its subject), for asking the app's own waiting question in other words, and for being, by
 * the model's own `repeats`, an answered question asked again without going deeper. Everything else is the model's, judged against the
 * snapshot.
 */
export function checkQuestions(questions: TurnQuestion[], context: QuestionContext, already: TurnQuestion[] = []): CardCheck<TurnQuestion> {
  const accepted: TurnQuestion[] = [];
  const problems: string[] = [];
  const byId = new Map(context.ledger.map((question) => [question.id, question]));
  const waiting = new Set(context.openItems.map((gap) => gap.question.id));
  for (const question of questions) {
    const label = `「${short(question.text)}」`;
    const round = [...already, ...accepted];
    if (round.some((other) => other.id === question.id)) { problems.push(`${label}的 id「${question.id}」这一轮已经用过，换一个。`); continue; }
    const labels = question.options.map((option) => optionKey(option.label ?? ""));
    const repeated = question.options.find((option, index) => labels.indexOf(optionKey(option.label ?? "")) !== index);
    if (repeated) { problems.push(`${label}的选项「${repeated.label}」重复了，每个选项说一件不同的事。`); continue; }
    // A date question names its subject (2026-11-15): the day is the person's to set, asked under a subject kept the same each time.
    if (question.date && !question.about?.trim()) { problems.push(`${label}问的是日子：about 写这是哪件事的日子，几个字，同一件事每次用同一个叫法。`); continue; }
    const named = question.repeats ? byId.get(question.repeats) : undefined;
    // The app's own waiting question asked in the model's words: its answer would not be read as the fact it settles.
    const gapId = named?.key.startsWith("gap:") ? named.key.slice(4) : "";
    if (gapId && waiting.has(gapId)) { problems.push(`${label}问的是应用自己的待办题 #${named!.id}：把「${gapId}」放进 openItems，应用照原样出卡，不要换说法问。`); continue; }
    // The model's own verdict: it said this is the answered question #n asked again, and not deeper. The answer goes back with it.
    if (!question.followUp && named && (named.status === "answered" || named.status === "assumed")) {
      problems.push(`${label}你标了和 #${named.id}「${short(named.text)}」是同一个问题，本人答过：「${short(named.answer || "（跳过）", 120)}」。`
        + "是在这个回答上往深问，就让题干接住它并设 followUp: true；不是就不再问。");
      continue;
    }
    accepted.push({ ...question, repeats: question.repeats && byId.has(question.repeats) ? question.repeats : 0 });
  }
  return { accepted, problems };
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
 * fact (`answeredGapFacts`).
 */
export function checkOpenItems(ids: string[], openItems: ProfileGap[], already: TurnQuestion[] = []): CardCheck<TurnQuestion> {
  const accepted: TurnQuestion[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const gap = openItems.find((item) => item.question.id === id);
    if (!gap) { problems.push(`openItems 里的「${id}」不是本轮 openItems 列出的待办题；只能用列出的 id。`); continue; }
    if ([...already, ...accepted].some((question) => question.id === id)) continue;
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

/**
 * The round's observation cards, after `already`. Each refusal names what to fix: a quote not found in the reply it names, a disclosure
 * cited, a link that is not a web page, a hypothesis id not in the log or already asked or refuted. How many replies a card joins, whether
 * it says something an earlier card said and which level of inference goes on a card are the Skill's (2026-11-27). Whether a card comes
 * from the log or is the dialogue's own is its choice.
 */
export function checkInsights(insights: TurnInsight[], context: InsightContext, already: CheckedInsight[] = []): CardCheck<CheckedInsight> {
  const accepted: CheckedInsight[] = [];
  const problems: string[] = [];
  if (!insights.length) return { accepted, problems };
  if (context.focusLine) return { accepted, problems: ["单条主线的访谈不出观察卡，insights 写 []。"] };
  const askedIds = new Set(context.earlier.map((card) => card.hypothesisId ?? "").filter(Boolean));
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
    const named = context.rules ? written.hypothesisId?.trim() ?? "" : "";
    const onRecord = named ? context.hypotheses.find((item) => item.id === named) : undefined;
    if (named && !onRecord) { problems.push(`${label}的 hypothesisId「${named}」不在假设日志里；从 cardFrom 选，新推断写 ""。`); continue; }
    if (onRecord && (onRecord.cardKey || askedIds.has(onRecord.id) || onRecord.status === "refuted")) {
      problems.push(`${label}问的假设 ${onRecord.id} 已经出过卡或被推翻，不再出。`); continue;
    }
    if (onRecord && round.some((item) => item.card.hypothesisId === onRecord.id)) { problems.push(`${label}和这一轮另一张卡问的是同一条假设 ${onRecord.id}。`); continue; }
    // The log's candidates are offered, not imposed (2026-11-17, the owner: give the model information and a goal, not a gate). How many
    // replies a card joins is the Skill's (2026-11-27); the quotes are checked, one at least.
    const checked = checkInsight(written, context.replies, context.stage);
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
