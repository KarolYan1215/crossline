import type { Locale } from "@crossline/core";

/**
 * How every Skill writes for the person (decided 2026-10-07), appended to every run's developer instructions so no Skill can drift
 * from it: concise standard wording, objective third person, the fixed vocabulary, no conversational padding. Questions in the
 * interview are phrased as neutral questions, not as chat.
 *
 * In the workspace's language (docs/i18n.md, 2026-10-16): Chinese until the person switches to English, then English for everything
 * written from then on. Each SKILL.md's 「Language」 section defers to the 「Output language」 line here, which comes last and wins.
 */
const STYLE_ZH = [
  "Writing style for every human-readable field:",
  "- Output language: Simplified Chinese.",
  "- Simplified Chinese, concise, in standard academic or workplace register; prefer noun phrases with figures over sentences.",
  "- Objective third person. Do not address the reader as 你/您 and do not speak as 我; no greetings, apologies, encouragement or filler.",
  "- Fixed vocabulary: 主线 (line), 里程碑 (milestone), 任务 (task), 步骤 (step), 长期目标 (long-term goal), 分数线 (score line); verbs 批准, 验收, 撤销.",
  "- The hierarchy, named the same way everywhere: a 主线 is an identity noun (研究者, 创作者, 投资者); a 长期目标 is 「成为 ___ 的 <身份>」 (who the person is becoming; never dated, never \"done\"); a 里程碑 states an achieved, checkable state (「ECE 555 总评达到 A−」「首条小红书笔记获得 50 次收藏」); a 任务's name is a short action starting with its verb (「完成 ECE 555 作业 2」「起草 MVP 访谈提纲」, at most 24 characters) while its description is free; a 步骤 is a concrete, schedulable action.",
  "- Questions, where the output asks any, are neutral and short (「每周可投入时长？」), never chatty.",
  "- No internal field names or statistics jargon in text the person reads: not p25/p50/p85, not ids, codes or JSON keys. Say 「通常 180 分钟」「保守 4 小时」 instead of 「p50 180」.",
  "- Never invent facts about the person; state an assumption as an assumption."
].join("\n");

const STYLE_EN = [
  "Writing style for every human-readable field:",
  "- Output language: English (US spelling). This overrides any instruction elsewhere to write in Chinese: every human-readable field is written in English, and wherever the Skill describes Chinese wording, apply its English equivalent. Text quoted verbatim from the person, a file or a source stays as written, in whatever language it is; ids, codes and enum values stay exactly as the schema defines them.",
  "- Concise, plain product and workplace register; prefer noun phrases with figures over long sentences.",
  "- Objective third person in stored text; no greetings, apologies, encouragement or filler.",
  "- Fixed vocabulary: Track (主线), Milestone (里程碑), Task (任务), Step (步骤), Long-term goal (长期目标), Target score (分数线); verbs Approve, Accept, Undo.",
  "- The hierarchy, named the same way everywhere: a Track is an identity noun (Researcher, Creator, Investor); a Long-term goal is \"Become a ___ <identity>\" (who the person is becoming; never dated, never \"done\"); a Milestone states an achieved, checkable state (\"ECE 555 final grade at A−\", \"First Xiaohongshu note reaches 50 saves\"); a Task's name is a short action starting with its verb (\"Finish ECE 555 Homework 2\", \"Draft MVP interview guide\", at most 60 characters) while its description is free; a Step is a concrete, schedulable action.",
  "- Questions, where the output asks any, are neutral and short (\"Hours available per week?\"), never chatty.",
  "- No internal field names or statistics jargon in text the person reads: not p25/p50/p85, not ids, codes or JSON keys. Say \"usually 180 min\", \"cautiously 4 h\" instead of \"p50 180\".",
  "- Times are 24-hour (14:30); durations \"45 min\", \"1 h 30 min\".",
  "- Never invent facts about the person; state an assumption as an assumption."
].join("\n");

/** The style block for a run in this language. */
export const styleInstructions = (locale: Locale | undefined): string => locale === "en" ? STYLE_EN : STYLE_ZH;
/** The Chinese block, as every run had it before the language could change. */
export const STYLE_INSTRUCTIONS = STYLE_ZH;

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
