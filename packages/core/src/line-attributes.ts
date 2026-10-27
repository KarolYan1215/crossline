/**
 * A line's long-term goal built from atomic attributes (decided 2026-10-10, docs/flywheel-and-views.md §4.1).
 *
 * The interview used to propose whole sentences 「成为 ___ 的 <身份>」, at most six of up to 120 characters, and the model filled them
 * by permuting the same few attributes: the candidates repeated each other and their combinations were often odd. It now proposes 3–12
 * mutually independent attributes per line, each cited to the reply or file it came from and labelled with its kind, each an adjective or
 * a short field qualifier from the person's own words, never an action or an achievement (`attributeProblem`); the person picks
 * any number of them, the system orders them as Chinese attributives are ordered (领域 → 能力 → 状态), the person may drag them into
 * another order or reword one, and 「采用」 writes the chosen parts (`goalParts`) plus the sentence composed from them (`goals[0]`), so
 * every reader of `goals` keeps working.
 */
import { joinList, tFor, type Locale } from "./i18n";

export const ATTRIBUTE_KINDS = ["domain", "ability", "state"] as const;
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];
export const ATTRIBUTE_KIND_LABEL: Record<AttributeKind, string> = { domain: "领域", ability: "能力", state: "状态" };
/** One attribute the interview proposed: `sourceRef` is the `reply-N` or `src-N` it was drawn from (`goal` when split from an adopted goal). */
export type AttributeCandidate = { text: string; kind: AttributeKind; sourceRef: string };
/** What `lines.profiles[line]` holds. `goalCandidates` is the whole-sentence form written before attributes existed, read for compatibility. */
export type StoredLineProfile = { description?: string; attributes?: AttributeCandidate[]; goalCandidates?: string[] };
/** A change of a line's goal the person asked for in the interview, waiting for their click (`lines.goalEdits[line]`). */
export type PendingGoalEdit = { parts: string[]; sourceRef: string; at: string };

/** Where the interview keeps each line's description and attribute candidates. */
export const LINE_PROFILES_SETTING = "lines.profiles";
/** Where a goal change the person asked for in the interview waits for their click, by line. */
export const GOAL_EDITS_SETTING = "lines.goalEdits";

/** The longest an attribute may be: a phrase, not a sentence. */
export const ATTRIBUTE_MAX_LENGTH = 40;
/** How many attributes one line's candidates hold when the interview writes them (0 = keep the ones already there). */
// Three, not six (2026-10-19, live walkthrough on the developer's model): asked for six and told to leave the list empty when it could not,
// the extraction gave three, was sent back, and then left every line empty — the start standard needs candidates, so the interview never
// reached 「开始使用」. Three is enough to compose a goal from, and the person can add their own. A model's answer is asked for three; a
// list pruned below it (an action or an achievement dropped, `attributeProblem`) is still kept for a line that has no more on record.
export const ATTRIBUTE_CANDIDATES_MIN = 3;
export const ATTRIBUTE_CANDIDATES_MAX = 12;

const KIND_RANK: Record<AttributeKind, number> = { domain: 0, ability: 1, state: 2 };
const PUNCTUATION = /[^\p{L}\p{N}]+/gu;

/** A leading 「成为」 or "become (a/an/the)" — the goal's verb, not part of what it says about the person. */
const BECOME = /^(成为|become(\s+(an?|the))?\b)\s*/i;

/** An attribute as kept: trimmed, without a leading 「成为」 (or "become a") or a trailing 「的」, inner whitespace collapsed. */
export function cleanAttribute(text: string): string {
  let value = text.replace(/\s+/g, " ").trim();
  value = value.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
  value = value.replace(BECOME, "");
  while (value.endsWith("的")) value = value.slice(0, -1).trimEnd(); // i18n-ignore: grammar of the text itself
  return value.replace(/[\s\p{P}\p{S}]+$/gu, "").slice(0, ATTRIBUTE_MAX_LENGTH);
}

/** What two attributes are compared by: no 「的」, no punctuation, no whitespace. */
export const attributeKey = (text: string) => text.replace(/的/g, "").replace(PUNCTUATION, "").toLowerCase();

/** Pairs that say the same thing: after removing 「的」 and punctuation one contains the other. */
/**
 * The shorter key's characters all appear in order in the longer one, and it is most of it: 「外推知识边界」 inside 「外推人类知识边界」 says the
 * same thing (a real split offered both on 2026-10-10). Keys of four characters or fewer only count when one plainly contains the other.
 */
function nearlyContained(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length <= 4 || short.length / long.length < 0.6) return false;
  let at = 0;
  for (const char of long) if (char === short[at]) at += 1;
  return at === short.length;
}

export function duplicateAttributes(texts: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = attributeKey(texts[i]!), b = attributeKey(texts[j]!);
      if (a && b && (a.includes(b) || b.includes(a) || nearlyContained(a, b))) pairs.push([texts[i]!, texts[j]!]);
    }
  }
  return pairs;
}

/** One attribute that is really two (「严谨、高产」, "rigorous, prolific"): an enumeration comma or a clause break inside it. */
export const notAtomic = (text: string) => /[、，,；;／/]|以及|并且|\b(as well as|and also)\b/i.test(text);

/**
 * How long an attribute reads: a CJK character counts one, a run of Latin letters or digits counts one (「AI 教育方向」 is 5). The interview
 * aims at `ATTRIBUTE_SHORT`; past `ATTRIBUTE_LONGEST` a candidate is a sentence and is refused (`attributeProblem`).
 */
export const attributeLength = (text: string) => (text.match(/[A-Za-z0-9]+|[^\s\p{P}\p{S}A-Za-z0-9]/gu) ?? []).length;
export const ATTRIBUTE_SHORT = 8;
export const ATTRIBUTE_LONGEST = 12;

// 「能/会/可以/善于/擅长/懂得…」 followed by a verb: an action. Not the nouns and idioms that start with the same characters (能源, 能量, 能力,
// 能动性, 会计, 会员, 能言善辩 …).
const ABILITY_VERB = /^(能够|能|会|可以|善于|擅长|懂得|学会)(?!源|量|力|效|耗|级|动|言善辩|说会道|屈能伸|文能武|计|展|员|议|所|话)(?=\S)/u;
// A count: 三篇, 10 万, 两个, Top 3, 5 年, 10w+. Not the idioms and names that contain a numeral (十项全能, 百家号 …).
const COUNT = /(\d+(\.\d+)?|[一二两三四五六七八九十百千万亿几]+)\s*(篇|个|本|次|场|位|名|家|门|项|款|份|条|部|套|期|届|年|月|天|周|小时|万|千|百|亿|倍|[kw]|%|＋|\+)|top\s*\d/iu;
const COUNT_IDIOM = /十项全能|三位一体|一家之言|一门心思|一本正经|独一份|百家号|百家讲坛/u;
// A leading action verb, a preposition that starts a how-or-why phrase, or a habit: an activity or an achievement, never a quality.
// Not the nouns made of the same characters (写作, 写手, 完成度, 获得感, 开发者, 出版业 …).
/* i18n-ignore-start: patterns read against what a model wrote */
const ACTION_LEAD = new RegExp("^(发表|做出|做成|做到|完成(?!度)|写出|写(?!作|手|实|意)|推出|发布|拿到|拿下|获得(?!感)|取得|赢得|赚(?!头)|开发(?!者|能力)|建立|打造|搭建"
  + "|出版(?!业|界|行业|方向|领域)|上线|达到|实现|外推|创办|创立|攻克|融到|卖出|带出|带领|培养|推动|帮助|坚持|每天|每周|每月|每年|把(?!握|关)|以(?!人为本|身作则)|通过|借助|为了)(?=\\S)", "u");
/* i18n-ignore-end */
/**
 * The same two rules in English, where they are cheap and certain: "able to …" / "good at …" is an ability with its verb (「能/会/善于」),
 * and a phrase that leads with an achieving verb ("publish …", "launch …", "win …") is an activity or an achievement. An English
 * attribute is an adjective ("rigorous", "independent") or a field ("signal processing"), so neither can be one.
 */
const ABILITY_VERB_EN = /^(able to|can|capable of|good at|skilled at)\s+(\S+)/i;
const ACTION_LEAD_EN = /^(publish|publishing|launch|launching|win|winning|earn|earning|get|getting|land|landing|ship|shipping|found|founding|reach|reaching|achieve|achieving|complete|completing)\s+\S/i;
// Ends in an achievement: 毕业, 上市, 获奖, 立项 … — a milestone, not who the person becomes.
const ACHIEVEMENT_END = /(毕业|上市|获奖|发表|出版|上线|中稿|夺冠|晋升|升职|立项|拿奖|变现|转正|录用|入选|过审)$/u;

/**
 * Why a proposed attribute is not one, or undefined (2026-10-19, the owner's rule: 「长期目标是形容词，不要把动词之类的强行组合成形容词」).
 * An attribute completes 「成为 ___ 的<身份>」: an adjective or a short adjectival phrase in the person's own words (严谨, 高产, 独立,
 * 有影响力, 值得信赖, 受学生欢迎) or a short field qualifier (器件物理方向). Only the clear cases are caught, each with how to write it
 * instead: 「能/会/善于…」 plus a verb, a count, a leading action verb or an achievement at the end, and a sentence-length phrase. Applied to
 * the candidates a model proposes, never to what the person wrote or chose themselves (a goal edit, a split of an adopted goal, a part
 * typed in the picker): their wording is theirs.
 */
// Repair messages to the model that proposed the candidates, not interface text.
/* i18n-ignore-start */
export function attributeProblem(raw: string): string | undefined {
  const text = cleanAttribute(raw);
  if (!text) return undefined;
  const abilityEn = text.match(ABILITY_VERB_EN);
  if (abilityEn) return `"${text}" is "${abilityEn[1]}" plus an action: write the quality it shows ("able to lead projects" → "independent")`;
  const leadEn = text.match(ACTION_LEAD_EN);
  if (leadEn) return `"${text}" starts with "${leadEn[1]}": an activity or an achievement, which belongs in a milestone`;
  const ability = text.match(ABILITY_VERB);
  if (ability) return `「${text}」是「${ability[1]}」加动作：写成它体现的品质（「能独立立项」→「独立」）`;
  if (COUNT.test(text) && !COUNT_IDIOM.test(text)) return `「${text}」带数量，是成就，属于里程碑`;
  const lead = text.match(ACTION_LEAD);
  if (lead) return `「${text}」以「${lead[1]}」开头，是活动或成就`;
  const end = text.match(ACHIEVEMENT_END);
  if (end) return `「${text}」以「${end[1]}」结尾，是成就，属于里程碑`;
  const length = attributeLength(text);
  if (length > ATTRIBUTE_LONGEST) return `「${text}」有 ${length} 个字，是一句话：缩到 ${ATTRIBUTE_SHORT} 个字以内`;
  return undefined;
}
/* i18n-ignore-end */

// Qualities of how someone works, and the endings that make a phrase one (判断力强, 做事严谨, 表达清晰): abilities, not fields, so they do
// not share a 「的」 with a field when the goal is composed.
const TRAIT_WORD = /^(严谨|高产|多产|高效|独立|专业|扎实|敏锐|专注|务实|细致|全面|博学|深刻|清晰|果断|理性|冷静|自律|勤奋|勤勉|耐心|稳健|创新|原创|开放|包容|真诚|坦诚|大胆|有趣|幽默|犀利|硬核|专精|干练|全能|一流)$/u;
const TRAIT_END = /([力感性]强|扎实|过硬|出色|突出|严谨|高效|细致|敏锐|清晰|果断|靠得住)$/u;

/**
 * The kind of an attribute nobody labelled (one the person typed, or one read from an old whole-sentence candidate). A rule, not a
 * model: 「能/会/善于…」, 「…能力」 and words for how someone works (严谨, 高产, 判断力强) are abilities; words describing a lasting
 * condition or standing are states; anything else names a field.
 */
export function guessKind(text: string): AttributeKind {
  if (/^(能|会|可以|善于|擅长|懂得|具备|拥有.*能力)|能力|水平$|技能/.test(text)) return "ability";
  if (/^[被受]|稳定|持续|长期|自由|从容|平衡|健康|有影响力|认可|信任|信赖|尊重|知名|领先|自洽|松弛|坚定|可靠|靠谱|独当一面|值得|欢迎|口碑|话语权|声望|权威/.test(text)) return "state";
  // The same rule in English: "able to…", "good at…", "…skills" are abilities; a lasting condition is a state.
  if (/^(able to|can|good at|skilled (at|in)|capable of|knows? how)\b|\b(ability|abilities|skills?|skilled|proficien\w*|expertise)\b/i.test(text)) return "ability";
  if (/^(trusted|respected|recogni[sz]ed) by\b|\b(stable|steady|sustained|sustainable|long-term|free|independent|calm|balanced|healthy|influential|well-known|renowned|leading|confident|reliable|dependable|self-sufficient|at ease)\b/i.test(text)) return "state";
  if (TRAIT_WORD.test(text) || TRAIT_END.test(text)) return "ability";
  return "domain";
}

/** Sorted by the order Chinese attributives take — 领域, 能力, 状态 — keeping the given order within a kind. */
export function orderAttributes<T extends { kind: AttributeKind }>(list: T[]): T[] {
  return list.map((item, index) => ({ item, index })).sort((a, b) => KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind] || a.index - b.index).map(({ item }) => item);
}

/**
 * Where a newly picked attribute goes in an order the person may already have rearranged: after the last chosen one whose kind does not
 * come later, so a pick never undoes a drag.
 */
export function insertByKind(selected: string[], text: string, kindOf: (text: string) => AttributeKind): string[] {
  const rank = KIND_RANK[kindOf(text)];
  let at = 0;
  selected.forEach((item, index) => { if (KIND_RANK[kindOf(item)] <= rank) at = index + 1; });
  return [...selected.slice(0, at), text, ...selected.slice(at)];
}

/**
 * 「成为 A 的、B 的<身份>」 exactly as the parts say it ("Become a A, B and C <noun>" in English): what a split must add up to
 * (`recomposes`, which reads both forms, so a goal written in either language is checked the same way) and what goals were stored as
 * before.
 */
export function plainComposeGoal(parts: string[], noun: string, locale?: Locale): string {
  const clean = parts.map(cleanAttribute).filter(Boolean);
  if (!clean.length) return "";
  if (locale === "en") return englishGoal(clean, noun);
  return `成为${clean.map((part) => `${part}的`).join("、")}${noun}`; // i18n-ignore: the Chinese sentence's own grammar, built per locale above
}

/** "Become a A, B and C <noun>": English needs none of the Chinese attributive's grouping. */
function englishGoal(clean: string[], noun: string): string {
  const article = /^[aeiou]/i.test(clean[0]!) ? "an" : "a";
  return `Become ${article} ${joinList("en", clean)}${noun ? ` ${noun}` : ""}`;
}

/** The identity noun without its 「者/人/家」: what an attribute that ends with it repeats (「公众号长文创作」 before 「创作者」). */
const nounStem = (noun: string) => { const stem = noun.replace(/[者人家师员]$/, ""); return stem.length >= 2 && stem !== noun ? stem : ""; };

/**
 * The goal as it reads (2026-10-17 walkthrough, W-24: 「成为即刻内容创作的、公众号长文创作的创作者」). Parts of one kind in a row share one
 * 「的」 and are joined by 「、」 (「即刻内容、公众号长文的」), parts of different kinds keep their own (「器件物理方向的、能独立立项的」); a part that
 * ends with the noun's own stem drops it, since the noun says it next; a part starting with a Latin letter or a digit gets a space after
 * 「成为」, as the parts themselves write 「AI 排班」. Empty when nothing is chosen.
 */
export function composeGoal(parts: string[], noun: string, locale?: Locale): string {
  if (locale === "en") { const clean = parts.map(cleanAttribute).filter(Boolean); return clean.length ? englishGoal(clean, noun) : ""; }
  const stem = nounStem(noun);
  const clean = parts.map(cleanAttribute).filter(Boolean)
    .map((part) => stem && part.endsWith(stem) && part.length - stem.length >= 2 ? cleanAttribute(part.slice(0, -stem.length)) : part)
    // 「产品设计能力的产品人」 reads as a noun stacked on a noun; 「有产品设计能力的」 is what is meant (2026-10-18 walkthrough, W-47).
    .map((part) => part.endsWith("能力") && !/^(有|具备|能|会)/.test(part) ? `有${part}` : part); // i18n-ignore: Chinese grammar
  if (!clean.length) return "";
  const groups: string[][] = [];
  let kind: AttributeKind | undefined;
  for (const part of clean) {
    const next = guessKind(part);
    if (groups.length && next === kind) groups.at(-1)!.push(part); else groups.push([part]);
    kind = next;
  }
  // The Chinese sentence's own grammar; English is built above.
  /* i18n-ignore-start */
  const middle = groups.map((group) => `${group.join("、")}的`).join("、");
  return `成为${/^[A-Za-z0-9]/.test(middle) ? " " : ""}${middle}${noun}`;
  /* i18n-ignore-end */
}

/** A whole goal sentence's middle, without 「成为」 and 「…的<身份>」: what it says about the person. */
export function goalCore(sentence: string, noun: string): string {
  let value = sentence.replace(/\s+/g, " ").trim().replace(/[\s\p{P}\p{S}]+$/gu, "");
  value = value.replace(BECOME, "");
  if (noun && value.toLowerCase().endsWith(noun.toLowerCase())) value = value.slice(0, -noun.length);
  return cleanAttribute(value);
}

/**
 * A goal compared for content: no whitespace, punctuation, leading 「成为」 / "become a" or 「的」 / "and" — what changes when parts are
 * joined is only those.
 */
const looseGoal = (text: string) => text.replace(/\s+/g, " ").trim().replace(BECOME, "").replace(/的/g, "").replace(/\band\b/gi, "")
  .replace(PUNCTUATION, "").toLowerCase();

/** Whether these parts, joined, say exactly what the original sentence said (the check a split must pass). */
export function recomposes(parts: string[], noun: string, original: string): boolean {
  return parts.length > 0 && looseGoal(plainComposeGoal(parts, noun)) === looseGoal(original);
}

/**
 * The candidates to show for a line: the stored attributes, or — for a line whose interview ran before attributes existed — its old
 * whole-sentence candidates read as one attribute each.
 */
export function lineAttributes(profile: StoredLineProfile | undefined, noun: string): AttributeCandidate[] {
  if (profile?.attributes?.length) return profile.attributes.filter((item) => item && typeof item.text === "string" && item.text.trim())
    .map((item) => ({ text: item.text, kind: ATTRIBUTE_KINDS.includes(item.kind) ? item.kind : guessKind(item.text), sourceRef: item.sourceRef ?? "" }));
  const seen = new Set<string>();
  return (profile?.goalCandidates ?? []).map((goal) => goalCore(goal, noun)).filter((text) => text && !seen.has(text) && Boolean(seen.add(text)))
    .map((text) => ({ text, kind: guessKind(text), sourceRef: "" }));
}

/**
 * Checks the chosen parts a person (or the interview) wants as a goal. Returns the parts as kept, or a code with the reason in words:
 * none chosen, too many, one that is really two, or two that say the same thing.
 */
export function checkGoalParts(parts: unknown, locale?: Locale): { ok: true; parts: string[] } | { ok: false; code: string; message: string } {
  const t = tFor(locale);
  if (!Array.isArray(parts)) return { ok: false, code: "LINE_GOAL_PARTS_INVALID", message: t("定语格式不正确") };
  const clean = parts.filter((part): part is string => typeof part === "string").map(cleanAttribute).filter(Boolean);
  if (!clean.length) return { ok: false, code: "LINE_GOAL_PARTS_EMPTY", message: t("至少选一个定语") };
  if (clean.length > 12) return { ok: false, code: "LINE_GOAL_PARTS_TOO_MANY", message: t("定语最多 12 个") };
  const duplicate = duplicateAttributes(clean)[0];
  if (duplicate) return { ok: false, code: "LINE_GOAL_PARTS_DUPLICATE", message: t("「{{a}}」与「{{b}}」重复", { a: duplicate[0], b: duplicate[1] }) };
  return { ok: true, parts: clean };
}

function reject(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

/**
 * Splitting a goal adopted before attributes existed (§4.1: 「已采用的整句由模型拆成定语，并保持选中，组合结果与原句一致」). The model is
 * given each line's goals and returns each goal's parts in order; the code checks that the parts, joined, are the sentence again.
 */
export type GoalSplitContext = { version: "crossline.goal-split.v1"; lines: Array<{ id: string; label: string; goals: string[] }> };
export type GoalSplit = { lines: Array<{ lineId: string; goals: Array<{ goal: string; parts: Array<{ text: string; kind: AttributeKind }> }> }> };

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const ATTRIBUTE_KIND_FIELD = { type: "string", enum: [...ATTRIBUTE_KINDS] } as const;

export const GOAL_SPLIT_SCHEMA = object({
  lines: { type: "array", maxItems: 12, items: object({
    lineId: { type: "string", minLength: 1, maxLength: 80 },
    goals: { type: "array", maxItems: 8, items: object({
      goal: { type: "string", minLength: 1, maxLength: 200 },
      parts: { type: "array", maxItems: 12, items: object({ text: { type: "string", minLength: 1, maxLength: ATTRIBUTE_MAX_LENGTH }, kind: ATTRIBUTE_KIND_FIELD }) }
    }) }
  }) }
});

/** Every goal given comes back with parts that recompose it; anything else is sent back naming the goal. */
/* i18n-ignore-start: repair messages sent back to the model */
export function validateGoalSplit(value: unknown, context: GoalSplitContext): GoalSplit {
  const answer = value as GoalSplit | undefined;
  if (!answer || !Array.isArray(answer.lines)) reject("GOAL_SPLIT_SCHEMA_INVALID", "输出结构不符合要求。");
  const kept: GoalSplit = { lines: [] };
  for (const line of context.lines) {
    const answered = answer.lines.find((item) => item.lineId === line.id);
    if (!answered) reject("GOAL_SPLIT_LINE_MISSING", `缺少主线「${line.id}」的拆分。`);
    const goals: GoalSplit["lines"][number]["goals"] = [];
    for (const goal of line.goals) {
      const split = answered.goals.find((item) => item.goal.trim() === goal.trim());
      if (!split) reject("GOAL_SPLIT_GOAL_MISSING", `缺少长期目标「${goal}」的拆分；goal 字段须逐字照抄原句。`);
      const parts = split.parts.map((part) => ({ text: cleanAttribute(part.text), kind: ATTRIBUTE_KINDS.includes(part.kind) ? part.kind : guessKind(part.text) })).filter((part) => part.text);
      if (!parts.length) reject("GOAL_SPLIT_EMPTY", `「${goal}」没有拆出任何定语。`);
      const duplicate = duplicateAttributes(parts.map((part) => part.text))[0];
      if (duplicate) reject("GOAL_SPLIT_DUPLICATE", `「${goal}」的定语「${duplicate[0]}」与「${duplicate[1]}」重复。`);
      const atomless = parts.find((part) => notAtomic(part.text));
      if (atomless && parts.length > 1) reject("GOAL_SPLIT_NOT_ATOMIC", `定语「${atomless.text}」含有并列，应拆成两个。`);
      if (!recomposes(parts.map((part) => part.text), line.label, goal)) {
        reject("GOAL_SPLIT_NOT_RECOMPOSED", `「${goal}」拆成的定语按顺序组合为「${composeGoal(parts.map((part) => part.text), line.label)}」，与原句不一致：只能切分原句的文字，不增删改。`);
      }
      goals.push({ goal, parts });
    }
    kept.lines.push({ lineId: line.id, goals });
  }
  return kept;
}
/* i18n-ignore-end */

/** The goal kept whole, as one attribute: what a goal becomes when no split of it recomposes. */
export const wholeGoalPart = (goal: string, noun: string) => {
  const text = goalCore(goal, noun) || cleanAttribute(goal);
  return { text, kind: guessKind(text) };
};

/**
 * When the repairs ran out: every goal whose split passes on its own keeps it, every other one is kept whole as a single attribute
 * (§4.1's fallback — the person's own wording is never replaced by a split that does not say the same thing).
 */
export function keepGoalSplit(value: unknown, context: GoalSplitContext): GoalSplit {
  const answer = (value ?? {}) as Partial<GoalSplit>;
  return { lines: context.lines.map((line) => ({ lineId: line.id, goals: line.goals.map((goal) => {
    const split = (Array.isArray(answer.lines) ? answer.lines : []).find((item) => item?.lineId === line.id)?.goals?.find((item) => item?.goal?.trim() === goal.trim());
    try {
      if (split) return validateGoalSplit({ lines: [{ lineId: line.id, goals: [split] }] }, { ...context, lines: [{ ...line, goals: [goal] }] }).lines[0]!.goals[0]!;
    } catch { /* falls through to the whole goal */ }
    return { goal, parts: [wholeGoalPart(goal, line.label)] };
  }) })) };
}
