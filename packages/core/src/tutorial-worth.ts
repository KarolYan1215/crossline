import { infoRequestTraits } from "./info-request";
import type { FamiliarityLevel } from "./familiarity";
import { tFor, type Locale, type Translate } from "./i18n";

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
 *
 * A plan whose steps name their product (`STEP_TYPES`, from 2026-10-22) is judged by that alone: a tutorial teaches, so only the
 * person's `ability` steps count, and only they get a section (`tutorialSteps`). Checking a delivery package, approving and sending, or
 * finding the cause of a failure in the person's own system produce an output or an act — the owner saw both get generic tutorials.
 *
 * Familiarity comes before all of that (`familiarityOf`, walkthrough W-154, 2026-10-29): work close to what the person knows (`near`)
 * never gets a tutorial however long it is, and work far from it (`far`) gets one once the person's own part reaches
 * `TUTORIAL_FAR_MINUTES` — a short judgement step in an unfamiliar field (choosing a first round of content topics) needs a page on how
 * to judge more than a long one in the person's own field. `mid` follows the rules above.
 */
export const TUTORIAL_FAR_MINUTES = 15;
export const TUTORIAL_MIN_MINUTES = 45;
export const TUTORIAL_LEARNING_MINUTES = 60;
export const TUTORIAL_CRAFT_MINUTES = 120;
export const LEARNING_ARCHETYPES = new Set(["problem_set", "exam_prep", "reading"]);
export const CRAFT_ARCHETYPES = new Set(["writing", "build", "presentation", "content", "application", "investment_research"]);
/** Step roles where knowing how matters: the minutes a craft task spends in these decide whether it gets a tutorial. */
export const METHOD_ROLES = new Set(["learn", "practice", "mock", "solve", "build", "test", "draft", "analyze", "rehearse"]);

export type PreparationLevel = "none" | "steps" | "tutorial";
export type Preparation = { level: PreparationLevel; reason: string };

type Step = { executor: string; schedulable: boolean; status: string; role?: string; product?: string; estimate: { p50Minutes: number } };
type Task = { title: string; intent: string; p50Minutes: number; archetypeId?: string };

const minutesIn = (t: Translate) => (value: number) => value >= 60 ? t("{{hours}} 小时", { hours: Math.round(value / 6) / 10 }) : t("{{minutes}} 分钟", { minutes: Math.round(value) });

/** `locale`: the reason is shown on the task (why it has a guide or not). */
export function taskPreparation(task: Task, steps?: readonly Step[], history: { doneBefore?: string; familiarity?: FamiliarityLevel } = {}, locale?: Locale): Preparation {
  const t = tFor(locale);
  const minutes = minutesIn(t);
  if (infoRequestTraits({ title: task.title, intent: task.intent, p50Minutes: task.p50Minutes }).match)
    return { level: "none", reason: t("只是问一件事或发一条消息，不备教程。") };
  if (steps?.length && !steps.some((step) => step.executor !== "agent"))
    return { level: "none", reason: t("这件事由助手完成，本人只需看结果，不备教程。") };
  if (!steps?.length) return { level: "steps", reason: t("步骤规划好后再决定是否准备教程。") };
  const own = steps.filter((step) => step.executor !== "agent" && step.schedulable);
  const ownMinutes = own.reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
  if (history.familiarity === "near")
    return { level: "steps", reason: t("熟悉的领域，按步骤和「先做」即可，不备教程。") };
  if (history.familiarity === "far" && ownMinutes >= TUTORIAL_FAR_MINUTES)
    return { level: "tutorial", reason: t("对本人是新领域（本人约 {{time}}），开工前备好讲解：术语、为什么、一个例子和常见错误。", { time: minutes(ownMinutes) }) };
  if (own.some((step) => step.product)) {
    const learning = tutorialSteps(own).reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
    return learning >= TUTORIAL_LEARNING_MINUTES
      ? { level: "tutorial", reason: t("有约 {{time}}要学新东西或练新方法，开工前备好这几步的教程。", { time: minutes(learning) }) }
      : { level: "steps", reason: learning ? t("要学的部分约 {{time}}，按步骤做即可，不备教程。", { time: minutes(learning) }) : t("这件事是产出或办理，不需要学新东西，按步骤做即可，不备教程。") };
  }
  if (ownMinutes < TUTORIAL_MIN_MINUTES)
    return { level: "steps", reason: t("本人的部分约 {{time}}，按步骤和「先做」即可，不备教程。", { time: minutes(ownMinutes) }) };
  const archetype = task.archetypeId ?? "";
  if (LEARNING_ARCHETYPES.has(archetype)) {
    return ownMinutes >= TUTORIAL_LEARNING_MINUTES
      ? { level: "tutorial", reason: t("要学新内容（本人约 {{time}}），开工前备好教程。", { time: minutes(ownMinutes) }) }
      : { level: "steps", reason: t("本人的部分约 {{time}}，按步骤做即可，不备教程。", { time: minutes(ownMinutes) }) };
  }
  if (CRAFT_ARCHETYPES.has(archetype)) {
    const method = own.filter((step) => METHOD_ROLES.has(step.role ?? "")).reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
    if (method < TUTORIAL_CRAFT_MINUTES)
      return { level: "steps", reason: t("需要方法的部分约 {{time}}，按步骤做即可，不备教程。", { time: minutes(method) }) };
    if (history.doneBefore) return { level: "steps", reason: t("做过同类任务（「{{task}}」），按当时的做法和步骤即可，不备教程。", { task: history.doneBefore }) };
    return { level: "tutorial", reason: t("需要新方法的部分约 {{time}}，开工前备好教程。", { time: minutes(method) }) };
  }
  return { level: "steps", reason: t("整理、确认、决定、沟通或办理类的任务，按步骤做即可，不备教程。") };
}

/**
 * The person's steps a tutorial is written for: those whose product is the person's ability (all of them on a plan from before products).
 * Work far from what the person knows (`familiarity` `far`) gets a section for every step of theirs: in a new field, producing an output
 * or acting needs explaining too (where to export a statement, how a content topic is judged).
 */
export function tutorialSteps<T extends { executor: string; product?: string }>(steps: readonly T[], familiarity?: FamiliarityLevel): T[] {
  const own = steps.filter((step) => step.executor !== "agent");
  if (familiarity === "far") return own;
  return own.some((step) => step.product) ? own.filter((step) => step.product === "ability") : own;
}

/** Whether the system writes a tutorial by itself (`taskPreparation` says `tutorial`); the task page's button still makes one for any task. */
export function tutorialWorthIt(task: Task, steps?: readonly Step[], history: { doneBefore?: string; familiarity?: FamiliarityLevel } = {}): boolean {
  return taskPreparation(task, steps, history).level === "tutorial";
}
