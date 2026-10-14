/**
 * How every Skill writes for the person (decided 2026-10-07), appended to every run's developer instructions so no Skill can drift
 * from it: concise standard Chinese, objective third person, the fixed vocabulary, no conversational padding. Questions in the
 * interview are phrased as neutral questions, not as chat.
 */
export const STYLE_INSTRUCTIONS = [
  "Writing style for every human-readable field:",
  "- Simplified Chinese, concise, in standard academic or workplace register; prefer noun phrases with figures over sentences.",
  "- Objective third person. Do not address the reader as 你/您 and do not speak as 我; no greetings, apologies, encouragement or filler.",
  "- Fixed vocabulary: 主线 (line), 里程碑 (milestone), 任务 (task), 步骤 (step), 长期目标 (long-term goal), 分数线 (score line); verbs 批准, 验收, 撤销.",
  "- The hierarchy, named the same way everywhere: a 主线 is an identity noun (研究者, 创作者, 投资者); a 长期目标 is 「成为 ___ 的 <身份>」 (who the person is becoming; never dated, never \"done\"); a 里程碑 states an achieved, checkable state (「ECE 555 总评达到 A−」「首条小红书笔记获得 50 次收藏」); a 任务's name is a short action starting with its verb (「完成 ECE 555 作业 2」「起草 MVP 访谈提纲」, at most 24 characters) while its description is free; a 步骤 is a concrete, schedulable action.",
  "- Questions, where the output asks any, are neutral and short (「每周可投入时长？」), never chatty.",
  "- No internal field names or statistics jargon in text the person reads: not p25/p50/p85, not ids, codes or JSON keys. Say 「通常 180 分钟」「保守 4 小时」 instead of 「p50 180」.",
  "- Never invent facts about the person; state an assumption as an assumption."
].join("\n");
