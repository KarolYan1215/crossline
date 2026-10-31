// i18n-exempt: instrument item texts in the one language they were translated into; a tap's answer line must repeat the item word for word (English cards are not offered yet)
/**
 * The short instruments the profile module asks as cards inside the interview (docs/profile-and-agent-kit.md §三, decided with the owner on
 * 2026-10-31). Every card is a few items on five dots labelled at both ends and the middle, plus a box: a tap is scored as it is, words are
 * mapped to the same 1–5 by the extraction and marked as such. Scores describe the person's own leanings only — never a norm or percentile.
 *
 * Sources and licences:
 * - Mini-IPIP (Donnellan, Oswald, Baird & Lucas 2006): IPIP items, public domain. Chinese wording is our own translation, to be
 *   back-translated and checked against the Taiwanese IPIP-50 (Pei-Wen Huang) and Zheng et al. 2008 before launch.
 * - 18REST (Psicologia: Reflexão e Crítica 2018, doi 10.1186/s41155-018-0086-z): CC BY 4.0; two of each type's three items. Replaces the
 *   RIASEC Markers, whose commercial terms could not be confirmed.
 * - SWLS (Diener, Emmons, Larsen & Griffin 1985): free to use with credit; its seven points are asked on five, so scores are not comparable
 *   with published SWLS norms.
 * - Value tradeoffs: our own pairs over Schwartz's ten values (the PVQ items are CC BY-NC-ND and are not used).
 */
import { SCHWARTZ_VALUES } from "./portrait";

export type InstrumentId = "mini_ipip" | "rest18" | "swls" | "values";
/** The interview stage a card belongs with, so it comes up while that topic is being talked about. */
export type ProfileStage = "narrative" | "situation" | "compass" | "energy";
/** Labels under the first, middle and last dot. */
export type Anchors = readonly [string, string, string];

export type ScaleItem = {
  id: string;
  instrument: InstrumentId;
  /** Big Five domain, RIASEC type, `swls`, or a value pair `left|right` (Schwartz names). */
  dimension: string;
  text: string;
  /** Scored 6 − answer. */
  reverse: boolean;
  anchors: Anchors;
  stage: ProfileStage;
  /** Where the item comes from, for the report's 「依据」. */
  source: string;
};

const AGREE: Anchors = ["完全不像我", "说不准", "非常像我"];
const INTEREST: Anchors = ["完全不想做", "说不准", "很想做"];
const SATISFIED: Anchors = ["完全不同意", "说不准", "完全同意"];

const IPIP_SOURCE = "Mini-IPIP（Donnellan 等 2006，公有领域；中文为自译，待回译核对）";
const REST_SOURCE = "18REST（2018，CC BY 4.0；中文为自译）";
const SWLS_SOURCE = "SWLS 生活满意度量表（Diener 等 1985；原 7 点，此处 5 点）";
const VALUES_SOURCE = "Schwartz 十项价值（自写取舍题）";

const ipip = (n: number, dimension: string, text: string, reverse: boolean, stage: ProfileStage): ScaleItem =>
  ({ id: `ipip-${n}`, instrument: "mini_ipip", dimension, text, reverse, anchors: AGREE, stage, source: IPIP_SOURCE });
const rest = (code: string, dimension: string, text: string): ScaleItem =>
  ({ id: `rest-${code}`, instrument: "rest18", dimension, text, reverse: false, anchors: INTEREST, stage: "situation", source: REST_SOURCE });
const swls = (n: number, text: string): ScaleItem =>
  ({ id: `swls-${n}`, instrument: "swls", dimension: "swls", text, reverse: false, anchors: SATISFIED, stage: "energy", source: SWLS_SOURCE });
const pair = (n: number, left: string, right: string, leftText: string, rightText: string): ScaleItem =>
  ({ id: `value-${n}`, instrument: "values", dimension: `${left}|${right}`, text: "只能选一边时，更看重哪个？", reverse: false,
    anchors: [leftText, "两边差不多", rightText], stage: "compass", source: VALUES_SOURCE });

/**
 * Every item, in the order cards are offered. Mini-IPIP's items are spread over the topics they sit closest to: extraversion and openness
 * with the life story, agreeableness with values, conscientiousness with work, neuroticism with energy and the day.
 */
export const PROFILE_ITEMS: readonly ScaleItem[] = [
  ipip(1, "E", "在聚会上是活跃气氛的那个人", false, "narrative"),
  ipip(6, "E", "话不多", true, "narrative"),
  ipip(11, "E", "在聚会上会和很多不同的人交谈", false, "narrative"),
  ipip(16, "E", "习惯待在不显眼的位置", true, "narrative"),
  ipip(5, "O", "想象力丰富", false, "narrative"),
  ipip(10, "O", "对抽象的想法不感兴趣", true, "narrative"),
  ipip(15, "O", "理解抽象的概念有困难", true, "narrative"),
  ipip(20, "O", "想象力不太好", true, "narrative"),
  ipip(2, "A", "能体会别人的感受", false, "compass"),
  ipip(7, "A", "对别人的难处不感兴趣", true, "compass"),
  ipip(12, "A", "能感受到别人的情绪", false, "compass"),
  ipip(17, "A", "其实对别人不太感兴趣", true, "compass"),
  pair(1, "自主", "遵从", "按自己的想法做，哪怕别人不认同", "照规矩来，不让身边的人为难"),
  pair(2, "刺激", "安全", "去试新鲜、有挑战的事", "过稳定、可预期的日子"),
  pair(3, "成就", "仁慈", "做出被人认可的成绩", "把时间留给身边需要我的人"),
  pair(4, "权力", "普世", "掌握资源和话语权", "让更多人、包括陌生人受益"),
  pair(5, "享乐", "传统", "趁现在享受生活", "守住家里和文化里传下来的东西"),
  pair(6, "安全", "自主", "一份稳定有保障的工作", "自由安排自己的时间和方向"),
  ipip(3, "C", "杂事马上就做完", false, "situation"),
  ipip(8, "C", "常忘了把东西放回原处", true, "situation"),
  ipip(13, "C", "喜欢有秩序", false, "situation"),
  ipip(18, "C", "常把东西弄得一团乱", true, "situation"),
  rest("int4", "R", "维护保养机器和工具"),
  rest("int1", "R", "操作机器加工零件"),
  rest("int38", "I", "阅读科学论文和书籍"),
  rest("int42", "I", "做分析和实验室实验"),
  rest("int30", "A", "参与戏剧的布景设计"),
  rest("int31", "A", "面对观众做艺术表演"),
  rest("int28", "S", "随时帮助别人"),
  rest("int27", "S", "为个人或群体提供健康与生活方面的指导"),
  rest("int11", "E", "参与公司的战略规划"),
  rest("int13", "E", "管理团队的目标与绩效"),
  rest("int54", "C", "整理归档重要的文件和资料"),
  rest("int48", "C", "监督法规的执行"),
  ipip(4, "N", "情绪起伏频繁", false, "energy"),
  ipip(9, "N", "大部分时间很放松", true, "energy"),
  ipip(14, "N", "容易心烦", false, "energy"),
  ipip(19, "N", "很少感到低落", true, "energy"),
  swls(1, "生活大体上接近理想"),
  swls(2, "眼下的生活状况很好"),
  swls(3, "对自己的生活满意"),
  swls(4, "到目前为止，已经得到了生活里想要的重要东西"),
  swls(5, "如果能重来一次，几乎什么都不想改")
];

const ITEMS_BY_ID = new Map(PROFILE_ITEMS.map((item) => [item.id, item]));
export const profileItem = (id: string): ScaleItem | undefined => ITEMS_BY_ID.get(id);

export const DIMENSION_LABEL: Record<InstrumentId, Record<string, string>> = {
  mini_ipip: { E: "外向性", A: "宜人性", C: "尽责性", N: "神经质", O: "开放性" },
  rest18: { R: "实用型", I: "研究型", A: "艺术型", S: "社会型", E: "企业型", C: "常规型" },
  swls: { swls: "生活满意度" },
  values: Object.fromEntries(SCHWARTZ_VALUES.map((value) => [value.name, value.name]))
};
export const CARD_TITLE: Record<InstrumentId, string> = {
  mini_ipip: "像不像你", rest18: "想不想做", swls: "对生活的感受", values: "取舍"
};

/** Items per card and cards per round (§三: at most two cards a round, counted in the round's questions). */
export const ITEMS_PER_CARD = 3;
export const CARDS_PER_ROUND = 2;

export type ProfileCard = { id: string; instrument: InstrumentId; title: string; stage: ProfileStage; items: ScaleItem[] };

/**
 * The next cards: items not yet answered or skipped, in bank order, grouped by instrument, at most `ITEMS_PER_CARD` each and
 * `CARDS_PER_ROUND` in all. `stages` is the current stage, or several in order — the stages the interview already left come first, so an
 * item a stage never got to is still asked later (otherwise the profile module could never finish). A card's id is its first item's, so a
 * card asked again after a reload keeps its id.
 */
export function cardsFor(stages: ProfileStage | readonly ProfileStage[], settled: ReadonlySet<string>, limit = CARDS_PER_ROUND): ProfileCard[] {
  const order = typeof stages === "string" ? [stages] : stages;
  const cards: ProfileCard[] = [];
  for (const stage of order) for (const item of PROFILE_ITEMS) {
    if (item.stage !== stage || settled.has(item.id)) continue;
    const last = cards.at(-1);
    if (last && last.instrument === item.instrument && last.stage === stage && last.items.length < ITEMS_PER_CARD) { last.items.push(item); continue; }
    if (cards.length >= limit) return cards;
    cards.push({ id: `card:${item.id}`, instrument: item.instrument, title: CARD_TITLE[item.instrument], stage, items: [item] });
  }
  return cards;
}

/** How many of the bank's items are answered or skipped, of all of them: the profile module's start item. */
export const cardsSettled = (settled: ReadonlySet<string>) =>
  ({ settled: PROFILE_ITEMS.filter((item) => settled.has(item.id)).length, total: PROFILE_ITEMS.length });

/** What is kept per item (setting `PROFILE_INSTRUMENTS_SETTING`). `mapped` answers come from the extraction reading the person's words. */
export type ItemAnswer = {
  itemId: string;
  /** 1–5 as answered, before reverse keying; absent when skipped or pending. */
  score?: number;
  /** `pending`: answered in words the extraction has not read yet; it counts as unanswered until it is mapped. */
  by: "tapped" | "mapped" | "skipped" | "pending";
  /** 0–1, for mapped answers. */
  confidence?: number;
  /** Evidence sentence ids the mapping rests on. */
  refs?: number[];
  at: string;
};
export const PROFILE_INSTRUMENTS_SETTING = "profile.instruments";
export type InstrumentAnswers = Record<string, ItemAnswer>;

export function readInstrumentAnswers(raw: string | null | undefined): InstrumentAnswers {
  try {
    const value = JSON.parse(raw ?? "{}") as InstrumentAnswers;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, answer]) => ITEMS_BY_ID.has(id) && answer && typeof answer === "object"));
  } catch { return {}; }
}

const validScore = (score: unknown): score is number => typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 5;

/** How much an answer says: a tap over a mapping over words waiting to be read over a skip. */
const WEIGHT: Record<ItemAnswer["by"], number> = { tapped: 3, mapped: 2, pending: 1, skipped: 0 };

/**
 * Adds answers to what is kept. An answer never gives way to one that says less (the person's own tap is never replaced by a mapping, a
 * skip never replaces words), and a later answer of the same kind replaces an earlier one.
 */
export function mergeInstrumentAnswers(kept: InstrumentAnswers, incoming: ItemAnswer[]): InstrumentAnswers {
  const next = { ...kept };
  for (const answer of incoming) {
    if (!ITEMS_BY_ID.has(answer.itemId)) continue;
    if ((answer.by === "tapped" || answer.by === "mapped") && !validScore(answer.score)) continue;
    const before = next[answer.itemId];
    if (before && WEIGHT[before.by] > WEIGHT[answer.by]) continue;
    next[answer.itemId] = answer;
  }
  return next;
}

/** Items answered in words and not yet mapped: what the extraction is asked to score (`scaleItems`). */
export const pendingItems = (answers: InstrumentAnswers): ScaleItem[] =>
  PROFILE_ITEMS.filter((item) => answers[item.id]?.by === "pending");

/** Items answered or skipped: a card is not offered again for them. */
export const settledItems = (answers: InstrumentAnswers): Set<string> => new Set(Object.keys(answers));

export type Administration = "tapped" | "mapped" | "mixed";
export type DimensionScore = {
  instrument: InstrumentId;
  dimension: string;
  label: string;
  /** 0–100, or null when the dimension is qualitative only (an item unanswered or skipped, or more than half mapped). */
  score: number | null;
  items: number;
  tapped: number;
  mapped: number;
  skipped: number;
  administration: Administration;
};

const toPercent = (mean: number) => Math.round(((mean - 1) / 4) * 100);
const administrationOf = (tapped: number, mapped: number): Administration =>
  mapped === 0 ? "tapped" : tapped === 0 ? "mapped" : "mixed";

/**
 * Scores per dimension (§三). A dimension gets a number only when every item has an answer and mapped answers are at most half; otherwise
 * `score` is null and the report says what it can in words. Values are scored per value from the pairs it appears in: leaning fully to a
 * value is 100, the middle 50.
 */
export function instrumentScores(answers: InstrumentAnswers, instrument: InstrumentId): DimensionScore[] {
  const items = PROFILE_ITEMS.filter((item) => item.instrument === instrument);
  const groups = new Map<string, Array<{ item: ScaleItem; side?: "left" | "right" }>>();
  for (const item of items) {
    if (instrument === "values") {
      const [left, right] = item.dimension.split("|") as [string, string];
      groups.set(left, [...(groups.get(left) ?? []), { item, side: "left" }]);
      groups.set(right, [...(groups.get(right) ?? []), { item, side: "right" }]);
    } else groups.set(item.dimension, [...(groups.get(item.dimension) ?? []), { item }]);
  }
  const labels = DIMENSION_LABEL[instrument];
  const order = Object.keys(labels);
  return [...groups.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([dimension, members]) => {
    let tapped = 0; let mapped = 0; let skipped = 0; const keyed: number[] = [];
    for (const { item, side } of members) {
      const answer = answers[item.id];
      if (!answer || answer.by === "skipped" || !validScore(answer.score)) { if (answer?.by === "skipped") skipped += 1; continue; }
      if (answer.by === "tapped") tapped += 1; else mapped += 1;
      const raw = item.reverse ? 6 - answer.score : answer.score;
      keyed.push(side === "left" ? 6 - raw : raw);
    }
    const complete = keyed.length === members.length;
    const score = complete && mapped * 2 <= members.length ? toPercent(keyed.reduce((sum, value) => sum + value, 0) / keyed.length) : null;
    return { instrument, dimension, label: labels[dimension] ?? dimension, score, items: members.length, tapped, mapped, skipped,
      administration: administrationOf(tapped, mapped) };
  });
}

/** How a dimension's score was arrived at, for the report: 「4 题点选」「3 题点选、1 题由文字折算」. */
export function administrationNote(score: DimensionScore): string {
  const parts = [score.tapped ? `${score.tapped} 题点选` : "", score.mapped ? `${score.mapped} 题由文字折算` : "",
    score.skipped ? `${score.skipped} 题跳过` : ""].filter(Boolean);
  const unanswered = score.items - score.tapped - score.mapped - score.skipped;
  if (unanswered > 0) parts.push(`${unanswered} 题未答`);
  return parts.join("、");
}

/**
 * The line a tapped item is sent as in the reply, read back by `readScaleAnswers` without the model. Words written in the card's box go
 * as an ordinary answer line under the card's title, which the extraction maps.
 */
export function scaleAnswerLine(item: ScaleItem, score: number): string {
  const label = score === 1 ? item.anchors[0] : score === 3 ? item.anchors[1] : score === 5 ? item.anchors[2] : "";
  return `【${item.text}${item.instrument === "values" ? `（${item.anchors[0]} / ${item.anchors[2]}）` : ""}】点选：${score}/5${label ? `（${label}）` : ""}`;
}

/** The line words written in a card's box are sent under: the card's title and its items, so the extraction knows what they answer. */
export const cardWordsHead = (card: Pick<ProfileCard, "title" | "items">): string =>
  `【${card.title}（${card.items.map((item) => item.text).join("／")}）】补充：`;

/**
 * What a reply says about the cards the last round offered: each item tapped, else `pending` when the card's box has words (the extraction
 * maps them), else `skipped` — a card the person passed over is not offered again. A reply that answers nothing of the round (no
 * 【…】 line at all: files added, dates read again, free words) says nothing about the cards, which are offered again.
 */
export function readCardAnswers(reply: string, cards: readonly ProfileCard[], at: string): ItemAnswer[] {
  if (!/^\s*【.+】/m.test(reply)) return [];
  const taps = readScaleAnswers(reply, cards.flatMap((card) => card.items.map((item) => item.id)), at);
  const tapped = new Set(taps.map((answer) => answer.itemId));
  const rest = cards.flatMap((card) => {
    const head = cardWordsHead(card);
    const words = reply.split(/\n+/).some((line) => line.trim().startsWith(head) && line.trim().length > head.length);
    return card.items.filter((item) => !tapped.has(item.id)).map((item): ItemAnswer => ({ itemId: item.id, by: words ? "pending" : "skipped", at }));
  });
  return [...taps, ...rest];
}

/** The taps in a reply, for the items a round offered. Lines whose text does not match an offered item are left to the extraction. */
export function readScaleAnswers(reply: string, offered: readonly string[], at: string): ItemAnswer[] {
  const out: ItemAnswer[] = [];
  const wanted = offered.map((id) => ITEMS_BY_ID.get(id)).filter((item): item is ScaleItem => Boolean(item));
  for (const line of reply.split(/\n+/)) {
    const match = /^【(.+)】点选：([1-5])\/5/.exec(line.trim());
    if (!match) continue;
    const [, head, digit] = match;
    const item = wanted.find((candidate) => scaleAnswerLine(candidate, 1).startsWith(`【${head}】`));
    if (item && !out.some((answer) => answer.itemId === item.id)) out.push({ itemId: item.id, score: Number(digit), by: "tapped", at });
  }
  return out;
}
