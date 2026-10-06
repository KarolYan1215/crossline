/**
 * Which work the assistant may take, and what to hand it.
 *
 * A work order already says, in the analysis the person approved, which parts a machine can prepare (`automationParts`) and which only
 * the person can do (`humanCore`). Dispatch reads that split and does not second-guess it: the assistant is given the first as its task
 * and the second as the thing it must leave alone. What this adds is the kind of work (each kind is approved once, and earns trust on
 * its own) and one rule the split cannot know: graded coursework is learning aid only, whatever the analysis called automatable.
 */
export const AGENT_CATEGORIES = {
  data_code_sim: "数据、代码、仿真",
  read_research_organize: "阅读、调研、整理",
  draft_text: "起草文字（不发送）",
  files_calendar_prep: "文件整理和日程准备"
} as const;
export type AgentCategory = keyof typeof AGENT_CATEGORIES;
export const isAgentCategory = (value: unknown): value is AgentCategory => typeof value === "string" && value in AGENT_CATEGORIES;

/** What each kind of work is for, said to the person when it asks to start for the first time. */
export const AGENT_CATEGORY_EXPLAINED: Record<AgentCategory, string> = {
  data_code_sim: "清洗数据、写和改脚本与代码（在项目分支里）、跑已有的仿真和批处理、画图表。产出是脚本、代码和图。",
  read_research_organize: "读文献和资料做带引文的摘要和对照笔记、查公开信息并核实来源、整理会议和课程材料。产出是笔记和清单。",
  draft_text: "起草邮件、报告、帖子和申请材料。只放在产出目录里，不会发送；改完由你自己发。",
  files_calendar_prep: "归档和重命名文件、会前把材料备齐、在 Crossline 日历上排自己的工作块。不动你的原文件。"
};

/** Ordered: a tie goes to the earlier kind, because code and data are the most specific words. */
const KEYWORDS: Array<[AgentCategory, RegExp]> = [
  ["data_code_sim", /代码|脚本|程序|编程|仿真|模拟|数据|绘图|画图|图表|可视化|python|matlab|neurosim|spice|netlist|matplotlib|调试|重构|单元测试|批处理|跑一遍|拟合/i],
  ["read_research_organize", /阅读|读一?[遍下]|文献|调研|检索|搜索|查找|查证|核实|整理|摘要|总结|笔记|资料|对照|清单|综述|梳理|纪要/],
  ["draft_text", /起草|草稿|撰写|拟写|润色|改写|邮件|报告|帖子|文案|申请材料|说明书|提纲/],
  ["files_calendar_prep", /归档|重命名|文件夹|整理文件|日程|会前|备齐|备料|准备材料|检查表|模板/]
];

const GRADED = /作业|小测|测验|考试|期中|期末|课程项目|大作业|实验报告|homework|\bhw\s?\d|quiz|exam|midterm|final project|\blab\b|assignment|take-?home/i;

export type DispatchableOrder = {
  id: string; intent: string; state: string; projectId: string;
  payload: unknown;
};
export type AssistantPlan =
  | { fit: false; reason: string }
  | { fit: true; category: AgentCategory | undefined; why: string; what: string; humanPart: string; graded: boolean; notes: string };

type Part = { intent?: string; rationale?: string };
const parts = (value: unknown): Part[] => Array.isArray(value) ? value as Part[] : [];

/**
 * Whether a work order has anything the assistant can take, and in what words to hand it over. `category` is `undefined` when the
 * wording does not point at one kind: the person chooses at dispatch, and nothing starts by itself.
 */
export function planAssistantTask(order: DispatchableOrder, context: { projectIsCourse: boolean; milestoneTitle?: string }): AssistantPlan {
  const payload = (order.payload ?? {}) as { automationParts?: unknown; humanCore?: unknown; materialContract?: unknown };
  const ai = parts(payload.automationParts).filter((part) => part.intent?.trim());
  const human = parts(payload.humanCore).filter((part) => part.intent?.trim());
  if (!ai.length) return { fit: false, reason: "分析认为这件事里没有可以交给助手的部分，都需要你自己做。" };

  const wording = ai.map((part) => part.intent!).join("；");
  const scored = KEYWORDS.map(([category, pattern]) => ({ category, hits: (wording.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? []).length }));
  const best = scored.filter((entry) => entry.hits > 0).sort((a, b) => b.hits - a.hits)[0];

  const text = `${order.intent} ${wording} ${human.map((part) => part.intent).join(" ")} ${context.milestoneTitle ?? ""}`;
  const graded = context.projectIsCourse && GRADED.test(text);
  const contract = Array.isArray(payload.materialContract) ? (payload.materialContract as Array<{ description?: string }>).map((item) => item.description).filter(Boolean) : [];
  return {
    fit: true,
    category: best?.category,
    why: best ? `AI 部分的描述指向「${AGENT_CATEGORIES[best.category]}」。` : "AI 部分的描述没有明确指向某一类，需要你选。",
    what: [`目标：${order.intent}`, `请完成其中可由 AI 准备的部分：${ai.map((part, i) => `${i + 1}) ${part.intent}`).join("；")}`,
      contract.length ? `需要的材料或证据：${contract.join("；")}` : ""].filter(Boolean).join("\n"),
    humanPart: human.length ? human.map((part) => part.intent).join("；") : "审阅并决定如何使用产出",
    graded,
    notes: graded ? "这是带评分的课程工作：只做学习辅助（讲解、你自己设计的练习、检查你写的、整理资料），不要生成可提交的答案、代码、报告或图表。" : ""
  };
}

/** The states a work order can be in for the assistant to prepare it: approved, before the person has started it. */
export const DISPATCH_STATES = new Set(["approved", "preparing", "ready_for_human"]);
