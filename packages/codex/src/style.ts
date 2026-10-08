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
  "- Questions, where the output asks any, are neutral and short (「每周可投入时长？」), never chatty.",
  "- Never invent facts about the person; state an assumption as an assumption."
].join("\n");
