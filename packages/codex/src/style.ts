/**
 * How every Skill writes for the person (decided 2026-10-07), appended to every run's developer instructions so no Skill can drift
 * from it: concise standard Chinese, objective third person, the fixed vocabulary, no conversational padding. Questions in the
 * interview are phrased as neutral questions, not as chat.
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

export const STYLE_INSTRUCTIONS = [
  "Writing style for every human-readable field:",
  "- Simplified Chinese, concise, in standard academic or workplace register; prefer noun phrases with figures over sentences.",
  "- Objective third person. Do not address the reader as 你/您 and do not speak as 我; no greetings, apologies, encouragement or filler.",
  "- Fixed vocabulary: 主线 (line), 里程碑 (milestone), 任务 (task), 步骤 (step), 长期目标 (long-term goal), 分数线 (score line); verbs 批准, 验收, 撤销.",
  "- The hierarchy, named the same way everywhere: a 主线 is an identity noun (研究者, 创作者, 投资者); a 长期目标 is 「成为 ___ 的 <身份>」 (who the person is becoming; never dated, never \"done\"), its blank short adjectives in the person's own words (「严谨、高产的研究者」), never an achievement or an action (「发表三篇论文的」「能独立立项的」 are milestones or 「独立的」); a 里程碑 states an achieved, checkable state (「ECE 555 总评达到 A−」「首条小红书笔记获得 50 次收藏」); a 任务's name is a short action starting with its verb (「完成 ECE 555 作业 2」「起草 MVP 访谈提纲」, at most 24 characters) while its description is free; a 步骤 is a concrete, schedulable action.",
  "- Questions, where the output asks any, are neutral and short (「每周可投入时长？」), never chatty.",
  "- No internal field names or statistics jargon in text the person reads: not p25/p50/p85, not ids, codes or JSON keys. Say 「通常 180 分钟」「保守 4 小时」 instead of 「p50 180」.",
  "- Never invent facts about the person; state an assumption as an assumption.",
  ...PLAIN_VOICE
].join("\n");
