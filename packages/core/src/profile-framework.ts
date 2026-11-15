// i18n-exempt: the portrait framework, instructions to the interview's model runs (never shown to the person)

/**
 * The ten dimensions of the portrait (D0–D9) with how each is asked and observed: one copy, appended to the developer instructions of
 * every run that reasons about them (the interview, the extraction, research, the portrait writer). It used to live in the interview
 * Skill alone, and the extraction and research Skills pointed at it although those runs never load that Skill
 * (docs/onboarding-agent-session.md, the empty references E:186 and R:12).
 */
export const PROFILE_FRAMEWORK = `## 画像框架

骨架是 McAdams 的三层（特质、特征性适应、叙事身份）加情境层；贯穿其中的是 if-then 行为签名（Mischel & Shoda）和「目标进展 → 情绪」回路（Carver & Scheier）；最后用改写的 5P 个案公式化收口。每个维度既有自上而下的问法，也有自下而上的行为探针：

| 维度 | 是什么 | 自上而下问 | 见微知著看 |
|---|---|---|---|
| D0 背景与约束 | 人生阶段、学业、签证、家庭、经济、可用资源 | 现在的处境和硬约束 | 日历里的固定事项、实际可支配时间 |
| D1 行为签名 | 「如果情境 X，那么行为 Y」 | 压力下、被评价时、独处时一般怎样 | 什么情况下准时、拖延、求助、超时；有截止 vs 没截止，有人看 vs 没人看 |
| D2 内隐动机 | 成就、亲和、权力 | 想要什么、什么算成功（这只是外显动机） | 高峰和低谷场景里的内容、没人要求时自发做什么、最放不下的事、嫉妒谁 |
| D3 基本需求 | 自主、胜任、关系；动机质量 | 每条主线「为什么做」，追问到第三层 | 是否常要别人批准才动手、是否回避被评价、做完是「松口气」还是「满足」 |
| D4 价值与三观 | Schwartz 价值、对人性/社会/成功的看法 | 两难时的取舍排序（强迫选择，不逐项打分） | 时间、钱、注意力的实际去向；两难时选了什么；后悔什么 |
| D5 理想与应该自我 | 分层目标、希望的自我和害怕的自我、理想自我和应该自我 | 理想 → 成为谁 → 做什么 → 本周；别人期望你成为什么、是谁的期望 | 推进速度和情绪、只做到及格线的目标、被放弃的目标 |
| D6 核心信念 | 关于自己、他人、世界的信念，「如果……就……」的规则 | 你相信关于自己的哪些事；成功的人是什么样 | 对具体情绪事件往下追问「这意味着什么」；跨场景重复的「必须 / 应该」 |
| D7 情绪模式 | 常见情绪和调节方式 | 什么让你兴奋或厌倦 | 近一年最生气、最羞愧、最嫉妒、最骄傲的场景各一个 |
| D8 叙事身份 | 人生章节、高峰、低谷、转折、下一章 | 用一句话讲你的人生故事 | 场景里是自己扛还是有人帮（能动 vs 交融）、坏事有没有变成好事（救赎 vs 污染） |
| D9 维持循环 | 个案公式化：驱动、阻碍、维持、资源 | 收尾时和本人核对 | 把 D1 的 if-then 和 D5 的进展—情绪回路连成可检验的回路：「截止前焦虑 → 逃避 → 进度更慢 → 更焦虑」 |`;

/** A run's developer instructions with the framework appended. */
export const withProfileFramework = (instructions: string): string => `${instructions}\n\n${PROFILE_FRAMEWORK}`;
