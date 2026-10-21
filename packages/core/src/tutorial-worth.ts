import { infoRequestTraits } from "./info-request";

/**
 * How much a task card gets prepared before its work starts (docs/task-preparation.md, 2026-10-21). A full tutorial — a designer run, a
 * web researcher per step and a writer per step, about 200–400k tokens — went to 43 runs in one week on the owner's account, nearly all
 * for 「整理……清单」「汇集……评分标准」「确认……」 kinds of work that needed no teaching. Three levels, decided by rules from the step plan
 * (no model call):
 * - `none`: nothing to prepare — a request for a fact or a send, or work the assistant does entirely;
 * - `steps`: the step plan is the guide (each step's 「先做」 first action, its done criterion and the tool to use, already on the card);
 *   no model run. The person can still ask for a tutorial on the task page;
 * - `tutorial`: a full tutorial, only where the person's own work needs knowledge or a method they do not yet have.
 *
 * `tutorial` needs one of:
 * - learning work (`LEARNING_ARCHETYPES`: course homework, exam revision, reading) with at least `TUTORIAL_LEARNING_MINUTES` of the
 *   person's own steps — new material every time, so having done the previous homework does not count;
 * - craft work (`CRAFT_ARCHETYPES`: writing, building, a deck, content, an application, investment research) with at least
 *   `TUTORIAL_CRAFT_MINUTES` in steps that take a method (`METHOD_ROLES`), and no accepted task of the same kind on the same line before
 *   (`doneBefore`) — someone who has done one does it again from the steps.
 * Everything else — deciding, gathering, confirming, contacting, admin, money, errands — is `steps`.
 */
export const TUTORIAL_MIN_MINUTES = 45;
export const TUTORIAL_LEARNING_MINUTES = 60;
export const TUTORIAL_CRAFT_MINUTES = 120;
export const LEARNING_ARCHETYPES = new Set(["problem_set", "exam_prep", "reading"]);
export const CRAFT_ARCHETYPES = new Set(["writing", "build", "presentation", "content", "application", "investment_research"]);
/** Step roles where knowing how matters: the minutes a craft task spends in these decide whether it gets a tutorial. */
export const METHOD_ROLES = new Set(["learn", "practice", "mock", "solve", "build", "test", "draft", "analyze", "rehearse"]);

export type PreparationLevel = "none" | "steps" | "tutorial";
export type Preparation = { level: PreparationLevel; reason: string };

type Step = { executor: string; schedulable: boolean; status: string; role?: string; estimate: { p50Minutes: number } };
type Task = { title: string; intent: string; p50Minutes: number; archetypeId?: string };

const minutes = (value: number) => value >= 60 ? `${Math.round(value / 6) / 10} 小时` : `${Math.round(value)} 分钟`;

export function taskPreparation(task: Task, steps?: readonly Step[], history: { doneBefore?: string } = {}): Preparation {
  if (infoRequestTraits({ title: task.title, intent: task.intent, p50Minutes: task.p50Minutes }).match)
    return { level: "none", reason: "只是问一件事或发一条消息，不备教程。" };
  if (steps?.length && !steps.some((step) => step.executor !== "agent"))
    return { level: "none", reason: "这件事由助手完成，本人只需看结果，不备教程。" };
  if (!steps?.length) return { level: "steps", reason: "步骤规划好后再决定是否准备教程。" };
  const own = steps.filter((step) => step.executor !== "agent" && step.schedulable);
  const ownMinutes = own.reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
  if (ownMinutes < TUTORIAL_MIN_MINUTES)
    return { level: "steps", reason: `本人的部分约 ${minutes(ownMinutes)}，按步骤和「先做」即可，不备教程。` };
  const archetype = task.archetypeId ?? "";
  if (LEARNING_ARCHETYPES.has(archetype)) {
    return ownMinutes >= TUTORIAL_LEARNING_MINUTES
      ? { level: "tutorial", reason: `要学新内容（本人约 ${minutes(ownMinutes)}），开工前备好教程。` }
      : { level: "steps", reason: `本人的部分约 ${minutes(ownMinutes)}，按步骤做即可，不备教程。` };
  }
  if (CRAFT_ARCHETYPES.has(archetype)) {
    const method = own.filter((step) => METHOD_ROLES.has(step.role ?? "")).reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
    if (method < TUTORIAL_CRAFT_MINUTES)
      return { level: "steps", reason: `需要方法的部分约 ${minutes(method)}，按步骤做即可，不备教程。` };
    if (history.doneBefore) return { level: "steps", reason: `做过同类任务（「${history.doneBefore}」），按当时的做法和步骤即可，不备教程。` };
    return { level: "tutorial", reason: `需要新方法的部分约 ${minutes(method)}，开工前备好教程。` };
  }
  return { level: "steps", reason: "整理、确认、决定、沟通或办理类的任务，按步骤做即可，不备教程。" };
}

/** Whether the system writes a tutorial by itself (`taskPreparation` says `tutorial`); the task page's button still makes one for any task. */
export function tutorialWorthIt(task: Task, steps?: readonly Step[], history: { doneBefore?: string } = {}): boolean {
  return taskPreparation(task, steps, history).level === "tutorial";
}
