// i18n-exempt: instructions to every model run (the style block), never shown to the person
import type { Locale } from "@crossline/core";

/**
 * How every Skill writes for the person (decided 2026-10-07), appended to every run's developer instructions so no Skill can drift
 * from it: concise standard wording, objective third person, the fixed vocabulary, no conversational padding. Questions in the
 * interview are phrased as neutral questions, not as chat.
 *
 * In the workspace's language (docs/i18n.md, 2026-10-16): Chinese until the person switches to English, then English for everything
 * written from then on. Each SKILL.md's 「Language」 section defers to the 「Output language」 line here, which comes last and wins.
 */
/**
 * Plain voice (2026-10-18, the owner's direction after reading six models' sample interviews): text should read as a person who knows the
 * facts, not as a model. Each rule names what to write instead, because a bare ban leaves the model to improvise the same shape again.
 * The patterns are the ones Wikipedia's 「Signs of AI writing」 and the Chinese humanizer checklists list (negative parallelism, em dashes,
 * aphorism, grouped threes, summary endings), and the ones counted in the candidates' replies.
 */
export const PLAIN_VOICE = [
  "Plain voice (every sentence a person will read):",
  "- No dashes as connectors (——, —, –). Write two sentences, or join with a comma or a colon.",
  "- No contrast frames: 不是……而是……, 不是……是……, 与其……不如……, 并非……, 不在于……而在于……, 不只是……更是……, 真正的……是……. Say the point itself as a plain statement: write 「三条线共用晚上的时间，每天切换多次。」, not 「真正卡住你的不是线太多，而是切换」.",
  "- No figures of speech: no 框, 地基, 底色, 双刃剑, 燃料, 杠杆, 飞轮, 账, 锚, 缝, 土壤, 碎片. Use the literal words (时间, 截止, 每周小时数, 进度). Terms the app itself uses (主线, 底座 for the line the person chose as base) are fine.",
  "- No coaching formulas: 先别……, 先把……算清/理清/看清, ……才是关键, 落地, 本质上, 说明你……. Ask the question or state the fact directly.",
  "- No aphorisms, no grouped threes for rhythm, no closing line that sums up or lifts the tone, no repeating the person's own words back as an opening. One or two sentences that add something are better than four that restate.",
  "- Prefer the person's concrete facts (dates, hours, counts, names they used) over adjectives. Short sentences; ordinary words."
];

const styleZh = (address: string) => [
  "Writing style for every human-readable field:",
  "- Output language: Simplified Chinese.",
  "- Simplified Chinese, concise, in standard academic or workplace register; prefer noun phrases with figures over sentences.",
  address,
  "- Fixed vocabulary: 主线 (line), 里程碑 (milestone), 任务 (task), 步骤 (step), 长期目标 (long-term goal), 分数线 (score line); verbs 批准, 验收, 撤销.",
  "- The hierarchy, named the same way everywhere: a 主线 is an identity noun (研究者, 创作者, 投资者); a 长期目标 is 「成为 ___ 的 <身份>」 (who the person is becoming; never dated, never \"done\"), its blank short adjectives in the person's own words (「严谨、高产的研究者」), never an achievement or an action (「发表三篇论文的」「能独立立项的」 are milestones or 「独立的」); a 里程碑 states an achieved, checkable state (「ECE 555 总评达到 A−」「首条小红书笔记获得 50 次收藏」); a 任务's name is a short action starting with its verb (「完成 ECE 555 作业 2」「起草 MVP 访谈提纲」, at most 24 characters) while its description is free; a 步骤 is a concrete, schedulable action.",
  "- Questions, where the output asks any, are neutral and short (「每周可投入时长？」), never chatty.",
  "- No internal field names or statistics jargon in text the person reads: not p25/p50/p85, not ids (doc-2, s5, q1, a line's id), codes or the input's keys (materials, units, person.answers, mustDeliver, systemMayPrepare). Name the thing as the person knows it: 「课程大纲」 for doc-1, 「第 5 步」 for s5, 「第 1 个问题」 for q1, 「任务材料」 for materials, and 「通常 180 分钟」「保守 4 小时」 instead of 「p50 180」.",
  "- Do not narrate the rules you were given or how you applied them (「units 计 0」「按 0 个办理环节计数」「按规则先清空内容单元」). Say what the result rests on; when there was nothing to count, say nothing about counting.",
  "- Never invent facts about the person; state an assumption as an assumption.",
  ...PLAIN_VOICE
].join("\n");

/** The same plain voice for English output: the shapes that read as machine-made in English, each with what to write instead. */
const PLAIN_VOICE_EN = [
  "Plain voice (every sentence a person will read):",
  "- No dashes as connectors (—, –). Write two sentences, or join with a comma or a colon.",
  "- No contrast frames: \"not X but Y\", \"it's not X, it's Y\", \"rather than X, Y\", \"the real X is Y\", \"more than just X\". Say the point itself as a plain statement: write \"The three tracks share the evenings and switch several times a day.\", not \"What really holds you back isn't the number of tracks, it's the switching\".",
  "- No figures of speech (framework, foundation, double-edged sword, fuel, lever, flywheel, anchor, soil). Use the literal words (time, deadline, hours per week, progress). Terms the app itself uses (Track, base for the track the person chose as base) are fine.",
  "- No coaching formulas: \"first, let's...\", \"get clear on...\", \"... is the key\", \"at its core\", \"this shows that you...\". Ask the question or state the fact directly.",
  "- No aphorisms, no grouped threes for rhythm, no closing line that sums up or lifts the tone, no repeating the person's own words back as an opening. One or two sentences that add something are better than four that restate.",
  "- Prefer the person's concrete facts (dates, hours, counts, names they used) over adjectives. Short sentences; ordinary words."
];

const styleEn = (address: string) => [
  "Writing style for every human-readable field:",
  "- Output language: English (US spelling). This overrides any instruction elsewhere to write in Chinese: every human-readable field is written in English, and wherever the Skill describes Chinese wording, apply its English equivalent. Text quoted verbatim from the person, a file or a source stays as written, in whatever language it is; ids, codes and enum values stay exactly as the schema defines them.",
  "- Concise, plain product and workplace register; prefer noun phrases with figures over long sentences.",
  address,
  "- Fixed vocabulary: Track (主线), Milestone (里程碑), Task (任务), Step (步骤), Long-term goal (长期目标), Target score (分数线); verbs Approve, Accept, Undo.",
  "- The hierarchy, named the same way everywhere: a Track is an identity noun (Researcher, Creator, Investor); a Long-term goal is \"Become a ___ <identity>\" (who the person is becoming; never dated, never \"done\"), its blank short adjectives in the person's own words (\"rigorous, prolific researcher\"), never an achievement or an action (\"who has published three papers\", \"able to start projects independently\" are milestones or \"independent\"); a Milestone states an achieved, checkable state (\"ECE 555 final grade at A−\", \"First Xiaohongshu note reaches 50 saves\"); a Task's name is a short action starting with its verb (\"Finish ECE 555 Homework 2\", \"Draft MVP interview guide\", at most 60 characters) while its description is free; a Step is a concrete, schedulable action.",
  "- Questions, where the output asks any, are neutral and short (\"Hours available per week?\"), never chatty.",
  "- No internal field names or statistics jargon in text the person reads: not p25/p50/p85, not ids (doc-2, s5, q1, a line's id), codes or the input's keys (materials, units, person.answers, mustDeliver, systemMayPrepare). Name the thing as the person knows it: \"the syllabus\" for doc-1, \"step 5\" for s5, \"question 1\" for q1, \"the task's materials\" for materials, and \"usually 180 min\", \"cautiously 4 h\" instead of \"p50 180\".",
  "- Do not narrate the rules you were given or how you applied them (\"units counted as 0\", \"cleared the content units per the rules\"). Say what the result rests on; when there was nothing to count, say nothing about counting.",
  "- Times are 24-hour (14:30); durations \"45 min\", \"1 h 30 min\".",
  "- Never invent facts about the person; state an assumption as an assumption.",
  ...PLAIN_VOICE_EN
].join("\n");

const THIRD_PERSON_ZH = "- Objective third person. Do not address the reader as 你/您 and do not speak as 我; no greetings, apologies, encouragement or filler.";
const THIRD_PERSON_EN = "- Objective third person in stored text; no greetings, apologies, encouragement or filler.";

/**
 * The address line for a run whose Skill speaks to the person in some fields (the interview's `reply` and questions, the portrait's
 * `type.summary`). Named here, in the one place the third-person rule lives, so the model is not handed two rules that contradict each
 * other and left to decide which one a Skill's 「this overrides」 sentence beats (found 2026-10-31).
 */
const addressZh = (fields: string[]) => `- Fields ${fields.map((field) => `\`${field}\``).join(", ")} speak to the person as 你 (never 您), as the Skill describes; `
  + "every other field, and everything stored about the person, is objective third person. Never speak as 我; no greetings, apologies, praise or filler.";
const addressEn = (fields: string[]) => `- Fields ${fields.map((field) => `\`${field}\``).join(", ")} speak to the person as "you", as the Skill describes; `
  + "every other field, and everything stored about the person, is objective third person. Never speak as \"I\"; no greetings, apologies, praise or filler.";

/**
 * The style block for a run in this language. `secondPerson` names the fields that address the person directly; without it every field
 * is third person, as for every Skill but the interview and the portrait.
 */
export const styleInstructions = (locale: Locale | undefined, secondPerson: string[] = []): string => locale === "en"
  ? styleEn(secondPerson.length ? addressEn(secondPerson) : THIRD_PERSON_EN)
  : styleZh(secondPerson.length ? addressZh(secondPerson) : THIRD_PERSON_ZH);
/** The Chinese block, as every run had it before the language could change. */
export const STYLE_INSTRUCTIONS = styleInstructions("zh");

/** One line for the assistant's shell thread, which carries no style block: the files it writes for the person follow the language. */
export const agentLanguageLine = (locale: Locale | undefined): string => locale === "en"
  ? "Language: write everything meant for the person (notes, reports, summaries, notDone/assumptions/needsHuman) in English (US). Keep quotes, file names and code as they are."
  : "Language: write everything meant for the person in Simplified Chinese. Keep quotes, file names and code as they are.";

let localeProvider: ((workspaceId: string | undefined) => Locale | undefined) | undefined;
/**
 * Where a run learns its workspace's language when the caller did not say (the worker reads the ledger's `ui.locale`). Read per run,
 * so a switch takes effect on the next Skill run without restarting anything.
 */
export function setLocaleProvider(provider: ((workspaceId: string | undefined) => Locale | undefined) | undefined): void { localeProvider = provider; }

/** The language of a run: the caller's (the interview's locked one), else the workspace's, else Chinese. */
export function runLocale(explicit: Locale | undefined, workspaceId: string | undefined): Locale {
  if (explicit) return explicit;
  try { return localeProvider?.(workspaceId) ?? "zh"; } catch { return "zh"; }
}

/** How much longer English text runs than the Chinese a limit was set for (one Chinese character ≈ two to three letters). */
export const ENGLISH_LENGTH_FACTOR = 2.5;

/**
 * The output schema as sent for this language. Every `maxLength` in the schemas was set against Chinese; an English answer of the same
 * substance is about 2.5 times as many characters, and strict decoding would cut it off or the validator refuse it. In English each string
 * limit is widened; formats are held by their own `pattern`/`enum` and by the validators, so widening ids and dates loses nothing. Chinese
 * gets the schema untouched.
 */
export function schemaForLocale(schema: unknown, locale: Locale | undefined): unknown {
  if (locale !== "en") return schema;
  const widen = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(widen);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = key === "maxLength" && typeof value === "number" ? Math.ceil(value * ENGLISH_LENGTH_FACTOR) : widen(value);
    }
    return out;
  };
  return widen(schema);
}
