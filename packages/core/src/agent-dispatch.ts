import { mentionsExternalAction } from "./external-action";
import { AGENT_MAX_RUNS, classifyAgentFailure } from "./agent-failure";

/**
 * Which work the assistant may take, and what to hand it.
 *
 * A work order already says, in the analysis the person approved, which parts a machine can prepare (`automationParts`) and which only
 * the person can do (`humanCore`). Dispatch reads that split and does not second-guess it: the assistant is given the first as its task
 * and the second as the thing it must leave alone. What this adds is the kind of work (each kind is approved once, and earns trust on
 * its own) and one rule the split cannot know: graded coursework is learning aid only, whatever the analysis called automatable.
 *
 * **Whole-task delegation.** A step worked backwards from a milestone carries no split at all (`automationParts: []`), so on the real
 * account the assistant never took a single task. A small, internal piece of work — preparing, gathering, checking; nothing sent,
 * published, submitted or paid; not graded coursework — is now handed over whole, the way Muse or OpenClaw take an errand: the
 * assistant does it, its files become the order's evidence, and the milestone gate judges them (`delegated: true`). What only the
 * person knows is reported back (`needsHuman`), never invented, and such a result waits for the person instead of being delivered.
 */
export const AGENT_CATEGORIES = {
  data_code_sim: "数据、代码、仿真",
  read_research_organize: "阅读、调研、整理",
  draft_text: "起草文字（不发送）",
  files_calendar_prep: "文件整理和日程准备",
  media_edit: "剪辑音视频和图片（不发布）"
} as const;
export type AgentCategory = keyof typeof AGENT_CATEGORIES;
export const isAgentCategory = (value: unknown): value is AgentCategory => typeof value === "string" && value in AGENT_CATEGORIES;

/** What each kind of work is for, said to the person when it asks to start for the first time. */
export const AGENT_CATEGORY_EXPLAINED: Record<AgentCategory, string> = {
  data_code_sim: "清洗数据、写和改脚本与代码（在项目分支里）、跑已有的仿真和批处理、画图表。产出是脚本、代码和图。",
  read_research_organize: "读文献和资料做带引文的摘要和对照笔记、查公开信息并核实来源、整理会议和课程材料。产出是笔记和清单。",
  draft_text: "起草邮件、报告、帖子和申请材料；只存放在产出目录，不发送，由本人修改后发出。",
  files_calendar_prep: "归档与重命名文件、会前备齐材料、在 Crossline 日历排工作块；不改动原文件。",
  media_edit: "按本人的素材剪辑视频与音频、加字幕、转码、裁图和做封面；成片只存放在产出目录，不上传不发布，由本人发出。"
};

/** Ordered: a tie goes to the earlier kind, because code and data are the most specific words. */
const KEYWORDS: Array<[AgentCategory, RegExp]> = [
  // Before code: 「用脚本剪视频」 is editing, and the words for it are the more specific ones.
  ["media_edit", /剪辑|剪视频|剪片|粗剪|精剪|成片|视频|音频|配音|字幕|转码|封面图|裁图|抠图|ffmpeg|vlog/i],
  ["data_code_sim", /代码|脚本|程序|编程|仿真|模拟|数据|绘图|画图|图表|可视化|python|matlab|neurosim|spice|netlist|matplotlib|调试|重构|单元测试|批处理|跑一遍|拟合/i],
  ["read_research_organize", /阅读|读一?[遍下]|文献|调研|检索|搜索|查找|查证|核实|整理|摘要|总结|笔记|资料|对照|清单|综述|梳理|纪要/],
  ["draft_text", /起草|草稿|撰写|拟写|润色|改写|邮件|报告|帖子|文案|申请材料|说明书|提纲/],
  ["files_calendar_prep", /归档|重命名|文件夹|整理文件|日程|会前|备齐|备料|准备材料|检查表|模板/]
];

/** The kind of work a sentence points at (the first keyword list it matches), or undefined when it points at none. */
export const categoryFromWording = (text: string): AgentCategory | undefined => KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0];

const PERSONS_CALL = /选定|选出|挑选|决定|拍板|亲自|本人确认|和.{0,8}(谈|聊|面谈)/;
const GRADED = /作业|小测|测验|考试|期中|期末|课程项目|大作业|实验报告|homework|\bhw\s?\d|quiz|exam|midterm|final project|\blab\b|assignment|take-?home/i;

export type DispatchableOrder = {
  id: string; intent: string; state: string; projectId: string;
  payload: unknown;
};
export type AssistantPlan =
  | { fit: false; reason: string }
  | { fit: true; category: AgentCategory | undefined; why: string; what: string; humanPart: string; graded: boolean; notes: string;
      /** The whole order is the assistant's: its result is delivered as the order's evidence (see above). */
      delegated: boolean };

type Part = { intent?: string; rationale?: string };
const parts = (value: unknown): Part[] => Array.isArray(value) ? value as Part[] : [];

/**
 * Whether a work order has anything the assistant can take, and in what words to hand it over. `category` is `undefined` when the
 * wording does not point at one kind: the person chooses at dispatch, and nothing starts by itself.
 */
export function planAssistantTask(order: DispatchableOrder, context: { projectIsCourse: boolean; milestoneTitle?: string }): AssistantPlan {
  const payload = (order.payload ?? {}) as { automationParts?: unknown; humanCore?: unknown; materialContract?: unknown; evidenceContract?: unknown;
    family?: string; riskTier?: string };
  const ai = parts(payload.automationParts).filter((part) => part.intent?.trim());
  const human = parts(payload.humanCore).filter((part) => part.intent?.trim());
  if (!ai.length) return delegateWhole(order, human, context);

  const wording = ai.map((part) => part.intent!).join("；");
  const scored = KEYWORDS.map(([category, pattern]) => ({ category, hits: (wording.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? []).length }));
  const best = scored.filter((entry) => entry.hits > 0).sort((a, b) => b.hits - a.hits)[0];

  const text = `${order.intent} ${wording} ${human.map((part) => part.intent).join(" ")} ${context.milestoneTitle ?? ""}`;
  const graded = context.projectIsCourse && GRADED.test(text);
  const contract = Array.isArray(payload.materialContract) ? (payload.materialContract as Array<{ description?: string }>).map((item) => item.description).filter(Boolean) : [];
  return {
    fit: true,
    category: best?.category,
    why: best ? `AI 部分的描述指向「${AGENT_CATEGORIES[best.category]}」。` : "可自动部分未明确对应某一类工作，需本人选择。",
    what: [`目标：${order.intent}`, `请完成其中可由 AI 准备的部分：${ai.map((part, i) => `${i + 1}) ${part.intent}`).join("；")}`,
      contract.length ? `需要的材料或证据：${contract.join("；")}` : ""].filter(Boolean).join("\n"),
    humanPart: human.length ? human.map((part) => part.intent).join("；") : "审阅并决定如何使用产出",
    graded,
    notes: graded ? "这是带评分的课程工作：只做学习辅助（讲解、你自己设计的练习、检查你写的、整理资料），不要生成可提交的答案、代码、报告或图表。" : "",
    delegated: false
  };
}

const categoryOf = (text: string): AgentCategory | undefined => KEYWORDS
  .map(([category, pattern]) => ({ category, hits: (text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? []).length }))
  .filter((entry) => entry.hits > 0).sort((a, b) => b.hits - a.hits)[0]?.category;

/** An errand small and internal enough to hand over whole (see the file comment); anything else stays the person's. */
function delegateWhole(order: DispatchableOrder, human: Part[], context: { projectIsCourse: boolean; milestoneTitle?: string }): AssistantPlan {
  const nothing = { fit: false as const, reason: "该任务没有可交给助手的部分，需本人完成。" };
  const payload = (order.payload ?? {}) as { family?: string; evidenceContract?: unknown };
  if (payload.family !== "preparation" && payload.family !== "review") return nothing;
  const text = `${order.intent} ${human.map((part) => part.intent).join(" ")} ${context.milestoneTitle ?? ""}`;
  if (mentionsExternalAction(order.intent, ...human.map((part) => part.intent))) return { fit: false, reason: "这件事要对外（发送、提交、发布等），不整件交给助手。" };
  if (context.projectIsCourse && GRADED.test(text)) return { fit: false, reason: "这是带评分的课程工作，不整件交给助手。" };
  // Choosing, deciding, doing it in person: the step *is* the person's judgement. One real run was handed 「选定一项创始人正在处理的
  // 真实事项」 and chose for them — and chose the app itself.
  if (PERSONS_CALL.test(order.intent)) return { fit: false, reason: "该步骤需本人选择或决定，不整件交给助手。" };
  const evidence = Array.isArray(payload.evidenceContract)
    ? (payload.evidenceContract as Array<{ description?: string }>).map((item) => item.description).filter(Boolean) : [];
  const category = categoryOf(order.intent) ?? "read_research_organize";
  return {
    fit: true, category, delegated: true, graded: false, notes: "",
    why: `这是一件内部的${payload.family === "review" ? "检查" : "准备"}工作，整件交给助手做，做完的文件直接作为证据交验收。`,
    what: [`这件事整件交给你做：${order.intent}`,
      evidence.length ? `交付物必须满足：${evidence.join("；")}` : "交付物：一份能直接用的文件",
      "只用你查得到、读得到的内容；需要本人才知道的事实（他的经历、别人的回复、私有数据），写进 needsHuman 说明缺什么，绝不编造。",
      "交付物写成 Markdown 或纯文本文件，放在工作目录里，并在 artifacts 里列出。"].join("\n"),
    humanPart: "审阅产出，决定用不用"
  };
}

/** The states a work order can be in for the assistant to prepare it: approved, before the person has started it. */
export const DISPATCH_STATES = new Set(["approved", "preparing", "ready_for_human"]);

/**
 * A run that was interrupted (a stall, a restart, a cancelled turn) is tried again, up to this many runs in all; one that failed for a
 * reason of its own is not. The one rule for every run of the assistant is `agentChains` (`agent-failure.ts`); this is kept for callers
 * that only have a list of runs, without backoff.
 */
export const PREP_STEP_MAX_RUNS = AGENT_MAX_RUNS;
export const lostToRuntime = (run: { status: string; blockerCode?: string | undefined }) =>
  (run.status === "stale" || run.status === "blocked") && classifyAgentFailure({ status: run.status, blockerCode: run.blockerCode ?? "", blockerMessage: "" }).retry;
/** Whether a step whose runs so far are these will be run again by itself. */
export const prepStepRetried = (runs: Array<{ status: string; blockerCode?: string | undefined }>) =>
  runs.length > 0 && runs.length < PREP_STEP_MAX_RUNS && runs.every(lostToRuntime);

/** The kind of work a step is, read from its role, for handing one step over (「交给 Agent」 on a step, or the worker by itself). */
export const STEP_CATEGORY: Record<string, AgentCategory> = {
  gather: "read_research_organize", read: "read_research_organize", compare: "read_research_organize", analyze: "read_research_organize",
  summarize: "read_research_organize", record: "read_research_organize", learn: "read_research_organize",
  outline: "draft_text", draft: "draft_text", revise: "draft_text", check: "draft_text",
  build: "data_code_sim", test: "data_code_sim", prepare: "files_calendar_prep", book: "files_calendar_prep", handle: "files_calendar_prep"
};
/** A step's kind: its role's, else — for a step the planner gave the assistant outright — reading and organising. */
export const stepCategory = (step: { role: string; executor: string }): AgentCategory | undefined =>
  STEP_CATEGORY[step.role] ?? (step.executor === "agent" ? "read_research_organize" : undefined);

/**
 * 「自动交给 Agent」 (decided 2026-10-10, default off). The assistant's own preparation steps (`executor: "agent"`) take no calendar time
 * and are always picked up by themselves (decided 2026-10-09). This switch covers the rest of what the system can do: a step on the
 * calendar that the step planner judged the system can do (`executor: "mixed"`). With it on, the worker starts such a step without a
 * click when its block comes up, or earlier when the assistant has nothing else to do; with it off, those steps wait for 「交给 Agent」.
 */
export const AUTO_HANDOFF_SETTING = "agent.autoHandoff";
/**
 * Where each step's next block starts, as instants: `{ "<orderId>#<stepId>": ISO }`. The schedule is derived on read in the web app and
 * never stored, so the web's attention timer (every ten minutes) writes this for the coming seven days; the worker reads it.
 */
export const STEP_STARTS_SETTING = "schedule.stepStarts";
/**
 * How long each order was planned for on a day: `schedule.minutes:<YYYY-MM-DD>` → `{ [orderId]: minutes }`, written by the same timer.
 * Read by the plan page's plan-vs-actual chart and by the portrait's say–do reading (`sayDoFor`).
 */
export const scheduledMinutesKey = (day: string) => `schedule.minutes:${day}`;
/** A block counts as come up this many minutes before it starts: the run gets a head start on the time the plan set aside for it. */
export const AUTO_HANDOFF_LEAD_MINUTES = 30;

/**
 * When a step handed over by itself may start, against now. `due`: its next block starts within the lead time, or has already started
 * (a start that passed is still due — the assistant may have been busy with another run). `early`: it has a block later in the coming
 * week, started ahead of time only when the assistant has nothing else to do. `unscheduled`: no block (a task-library step), which stays
 * the person's to hand over, since nothing says when it is wanted.
 */
export function autoHandoffTiming(startsAt: string | undefined, now: Date, leadMinutes = AUTO_HANDOFF_LEAD_MINUTES): "due" | "early" | "unscheduled" {
  const at = startsAt ? Date.parse(startsAt) : NaN;
  if (!Number.isFinite(at)) return "unscheduled";
  return at - now.getTime() <= leadMinutes * 60_000 ? "due" : "early";
}
