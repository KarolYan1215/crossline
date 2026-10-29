import { searchTerms, type SearchTerms } from "./context-selection";
import { tFor, type Locale } from "./i18n";

/**
 * How close a piece of work is to what the person already knows (walkthrough W-154, 2026-10-29): `near`, `mid` or `far`. The owner's
 * words: 「距离我现在已有认知的 domain 越远的东西需要越详细的解释和材料，越近的则应该越简洁明了」. It decides how much a task is
 * prepared (`taskPreparation`: far gets a tutorial even when short, near never does) and how the step planner and the tutorial writer
 * write (near: the key points and the first move, no basics, no general guides; far: terms explained, why, one worked example and the
 * common mistakes, material from the start to enough).
 *
 * Why it matters (the expertise reversal effect, Kalyuga 2007, Educational Psychology Review 19(4)): worked examples and full
 * explanations help a novice and *hurt* someone who already knows the domain — they must reconcile the guidance with what they know,
 * which is load without learning. So the same tutorial is wrong at both ends: a device researcher handed NASA's and MIT's design-review
 * guides for their own review, and an engineer new to content work given no word on how topics are chosen (the live walk of 10-29).
 *
 * Rules only, no model call, from what is on record:
 * - the person's own choice for this line and kind of work (`override`), which wins;
 * - accepted tasks of the same kind on the same line (two or more: +2, one: +1), and an accepted task on the line sharing the task's terms (+1);
 * - the person's confirmed facts about their background (degree, field, job, skills, experience) sharing the task's terms (two or more: +2,
 *   one: +1);
 * - a confirmed fact on this line saying they are new to it (新手、零基础、第一次…): −3;
 * - a domain line (health or money, the lite edition) with nothing in the background facts about it: −1; a line with no accepted work at
 *   all when the background facts on record are about something else: −1 (no background facts at all says nothing either way).
 * Three or more is `near`, −1 or less `far`, the rest `mid` (the rules as they were).
 */
export type FamiliarityLevel = "near" | "mid" | "far";
export const FAMILIARITY_LEVELS: readonly FamiliarityLevel[] = ["near", "mid", "far"];
export type Familiarity = {
  level: FamiliarityLevel;
  /** `person` when the person chose it for this line and kind of work, else `rules`. */
  by: "person" | "rules";
  /** What the level rests on, in plain English for the model (never shown as UI text). */
  basis: string[];
};

export type FamiliarityFact = { identityId: string; slot: string; value: string; status: string };
export type FamiliarityInput = {
  task: { title: string; intent: string };
  lineId: string;
  /** The line's life domain (`wellness`/`wealth`) when it has one. */
  lineDomain?: string | undefined;
  /** Confirmed facts of the person (`person`) and of this line. Others are ignored. */
  facts: readonly FamiliarityFact[];
  /** Accepted tasks of this line and archetype. */
  sameKindDone: number;
  /** Accepted tasks on this line, of any kind. */
  lineDone: number;
  /** Short names of accepted tasks on this line. */
  doneTitles?: readonly string[];
  override?: FamiliarityLevel | undefined;
};

/** The setting holding the person's own choices, keyed `<line>|<archetype>` (archetype `*` when the task has none yet). */
export const FAMILIARITY_SETTING = "tasks.familiarity";
export const familiarityKey = (lineId: string, archetypeId: string | undefined) => `${lineId}|${archetypeId || "*"}`;

/** The person's choice for a line and kind of work: the exact kind first, then the whole line (`*`). */
export function familiarityOverride(raw: string | undefined, lineId: string, archetypeId: string | undefined): FamiliarityLevel | undefined {
  let map: Record<string, unknown> = {};
  try { map = JSON.parse(raw ?? "{}") as Record<string, unknown>; } catch { return undefined; }
  if (!map || typeof map !== "object") return undefined;
  for (const key of [familiarityKey(lineId, archetypeId), familiarityKey(lineId, undefined)]) {
    const value = map[key];
    if (typeof value === "string" && (FAMILIARITY_LEVELS as readonly string[]).includes(value)) return value as FamiliarityLevel;
  }
  return undefined;
}

// i18n-ignore-start: patterns read from the person's own facts
/** A fact about the person's background: the slot names it, or the value says a degree, field, job or skill. */
const BACKGROUND_SLOT = /expert|skill|background|degree|major|educat|experience|strength|occupation|job|role|field|profession|research|专业|背景|技能|经历|学历|职业|方向|擅长/i;
const BACKGROUND_VALUE = /博士|硕士|学位|本科|专业|多年|擅长|熟悉|精通|经验|从事|研究方向|工程师|研究员|PhD|Ph\.D|master|bachelor|engineer|years? of/i;
const BEGINNER = /新手|零基础|刚开始|刚入门|初学|没有经验|没经验|不熟|不太懂|不懂|第一次|从没|从未|小白|beginner|new to|never (?:done|tried)/i;
/** Verbs and generic nouns every task carries: matching them says nothing about the domain. */
const GENERIC = new Set(["确认", "选定", "设计", "打开", "写下", "列出", "汇集", "安排", "时间", "本周", "今天", "明天", "查看", "核对", "决定",
  "评估", "检查", "开始", "首轮", "第一", "版本", "清单", "计划", "目标", "问题", "结果", "方案", "草稿", "review", "plan", "draft", "list", "check"]);
// i18n-ignore-end

const hitsIn = (text: string, terms: SearchTerms) => {
  const lower = text.toLowerCase();
  return [...terms.long, ...terms.short].filter((term) => !GENERIC.has(term) && lower.includes(term));
};

export function familiarityOf(input: FamiliarityInput): Familiarity {
  const terms = searchTerms(`${input.task.title} ${input.task.intent}`);
  const own = input.facts.filter((fact) => fact.status === "confirmed" && !fact.value.startsWith("假设") // i18n-ignore: the stored 「假设」 marker
    && (fact.identityId === "person" || fact.identityId === input.lineId));
  const background = own.filter((fact) => BACKGROUND_SLOT.test(fact.slot) || BACKGROUND_VALUE.test(fact.value));
  const expertise = [...new Set(background.flatMap((fact) => hitsIn(`${fact.slot} ${fact.value}`, terms)))];
  const beginner = own.find((fact) => fact.identityId === input.lineId && BEGINNER.test(fact.value));
  const similarDone = (input.doneTitles ?? []).find((title) => hitsIn(title, terms).length >= 2);
  const basis: string[] = [];
  let score = 0;
  if (input.sameKindDone > 0) { score += Math.min(2, input.sameKindDone); basis.push(`${input.sameKindDone} accepted task(s) of this kind on this line`); }
  if (similarDone) { score += 1; basis.push(`an accepted task on this line shares its terms: ${similarDone}`); }
  if (expertise.length) { score += Math.min(2, expertise.length); basis.push(`the person's background facts mention: ${expertise.slice(0, 4).join(", ")}`); }
  if (beginner) { score -= 3; basis.push(`the person said about this line: ${beginner.value.slice(0, 60)}`); }
  if (input.lineDomain && !expertise.length) { score -= 1; basis.push(`a ${input.lineDomain} line with nothing in the person's background about it`); }
  // Known to work in another field (background facts on record, none about this task) and nothing done on this line yet. With no
  // background facts at all nothing is known either way: a new account's work stays `mid`, so it is not all given tutorials.
  if (input.lineDone === 0 && !expertise.length && background.length) { score -= 1; basis.push("the person's background is in another field and nothing on this line is done yet"); }
  const ruled: FamiliarityLevel = score >= 3 ? "near" : score <= -1 ? "far" : "mid";
  if (input.override) return { level: input.override, by: "person", basis: [`the person set this line and kind of work as ${input.override}`, ...basis] };
  return { level: ruled, by: "rules", basis: basis.length ? basis : ["nothing on record either way"] };
}

/** The tag on the task: what the level means for how much is explained. */
export function familiarityLabel(level: FamiliarityLevel, locale?: Locale): string {
  const t = tFor(locale);
  return level === "near" ? t("熟悉领域·从简") : level === "far" ? t("新领域·附讲解") : t("一般熟悉·按步骤");
}

/**
 * What the step planner and the tutorial writer are told for each level (the same sentence both read beside `familiarity` in their
 * input). Kept here so the two prompts and the tests agree.
 */
export const FAMILIARITY_INSTRUCTIONS = "`familiarity.level` says how close this work is to what the person already knows. "
  + "near: give the key points and the first move only; do not explain basic concepts the person's field already covers, do not cite "
  + "general authoritative guides (a NASA or MIT design-review guide for a researcher's own review), keep each step short. "
  + "far: explain each term the first time it is used, say why each step is done, give one concrete worked example and the common "
  + "mistakes, and list material from an introduction to just enough (a few sources, the most useful first; say where to get what the "
  + "person must supply, such as where to export a statement). mid: as usual.";
