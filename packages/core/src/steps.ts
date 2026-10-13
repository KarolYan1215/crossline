import { ARCHETYPE_IDS, STEP_ROLES, archetypeById, isStepRole, type Archetype, type StepRole } from "./archetypes";

/**
 * A task's step graph: the step planner's wire contract, the normalization that makes any answer usable, the warnings a reviewer
 * model then looks at, and the task's progress.
 *
 * Only the shape is a hard check (a malformed answer is repaired in the same thread). Everything about content — a role outside the
 * archetype, an ordering rule broken, shares that do not add up, a total that does not fit the window — is normalized where it can be
 * and reported as a warning, never a refusal: the plan is saved and scheduled, and `crossline-validation-reviewer` decides whether to
 * dismiss the warning or have the plan redone.
 */

export type StepExecutor = "human" | "agent" | "mixed";
export type PlannedStep = {
  id: string; role: StepRole; title: string; deliverable: string; doneCriterion: string;
  /** This step's part of the task's progress; all shares sum to 1 after normalization. */
  share: number;
  estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  dependsOn: string[];
  /** YYYY-MM-DD or "". */
  notBefore: string; dueBy: string;
  /** False for waiting: it takes no time on the calendar. */
  schedulable: boolean;
  /** Whether the system could do it. Never shown as a label; it decides whether 「交给 Agent」 appears. */
  executor: StepExecutor;
  /** The near-term result this step puts on the milestone axis, "" when it is not a tick. */
  tickOutcome: string;
  /** Ids of the content units (`StepPlan.units`) this step works on: what it is about, from the person's own material. */
  covers: string[];
  /** Why this step, for this person: the fact or material it rests on (their level, the weight of the part, the exam format). */
  why: string;
};
/**
 * One unit of the task's actual content, read from the person's material — a lecture, a chapter, a problem set, a section of a brief —
 * with the document and the verbatim line it was read from. Quantities are counted from these, never assumed (decided 2026-10-09: a
 * plan that counted 「3 个知识点」 for a course with a dozen lectures before the exam was worse than no plan).
 */
export type StepUnit = { id: string; title: string; docId: string; quote: string };
/** What only the person can tell the planner (which lectures the exam covers, what they already know): asked on 待决事项, then replanned. */
export type StepQuestion = { id: string; text: string; why: string; options: string[] };
/** The person's answer to a plan question is a confirmed fact under this slot prefix (plus a hash of the question), read by every later plan. */
export const STEP_ANSWER_SLOT = "step_answer_";
export const stepAnswerSlot = (question: string) => `${STEP_ANSWER_SLOT}${[...question].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) >>> 0, 7).toString(36)}`;
export type StepPlan = {
  archetypeId: string;
  quantity: { basis: string; amount: number; unit: string };
  rationale: string;
  /**
   * The planner's judgement of whether this task matters to the person's long-term plan (docs/review-2026-10-13.md §11): only an
   * important task's questions are put to the person; a minor one's are settled as assumptions. Optional in the type for plans stored
   * before it; the schema requires it.
   */
  importance?: { longTerm: boolean; why: string };
  units: StepUnit[];
  questions: StepQuestion[];
  steps: PlannedStep[];
};
export type StepWarning = { code: string; detail: string };

const str = { type: "string" };
const num = { type: "number" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

/** The step plan schema; `extraIds` adds the archetypes learned for this workspace to the ones the answer may name. */
export const stepPlanSchema = (extraIds: readonly string[] = []) => object({
  archetypeId: { type: "string", enum: [...ARCHETYPE_IDS, ...extraIds] },
  quantity: object({ basis: str, amount: num, unit: str }),
  rationale: str,
  importance: object({ longTerm: { type: "boolean" }, why: str }),
  units: { type: "array", items: object({ id: str, title: str, docId: str, quote: str }) },
  questions: { type: "array", items: object({ id: str, text: str, why: str, options: { type: "array", items: str } }) },
  steps: { type: "array", items: object({
    id: str, role: { type: "string", enum: Object.keys(STEP_ROLES) }, title: str, deliverable: str, doneCriterion: str, share: num,
    estimate: object({ p25Minutes: num, p50Minutes: num, p85Minutes: num }),
    dependsOn: { type: "array", items: str }, notBefore: str, dueBy: str, schedulable: { type: "boolean" },
    executor: { type: "string", enum: ["human", "agent", "mixed"] }, tickOutcome: str, covers: { type: "array", items: str }, why: str
  }) }
});
export const STEP_PLAN_SCHEMA = stepPlanSchema();

/** The reviewer's answer to a set of warnings (Skill `crossline-validation-reviewer`). */
export type ValidationReview = { verdict: "dismiss" | "redo"; notes: string };
export const VALIDATION_REVIEW_SCHEMA = object({ verdict: { type: "string", enum: ["dismiss", "redo"] }, notes: str });
export function validateValidationReview(value: unknown): ValidationReview {
  const review = value as ValidationReview | undefined;
  if (!review || !["dismiss", "redo"].includes(review.verdict) || typeof review.notes !== "string") throw new Error("VALIDATION_REVIEW_INVALID");
  return { verdict: review.verdict, notes: review.notes.trim().slice(0, 1200) };
}

/**
 * A progress report read against the task's steps and standards (Skill `crossline-progress-judge`): the person says in their own words
 * how far they are, and each step and standard gets a reading in quarters. Only what the report or its files support moves.
 */
export type ProgressAssessment = {
  steps: Array<{ stepId: string; quarters: number }>;
  criteria: Array<{ criterionId: string; quarters: number; note: string }>;
  summary: string;
};
export const PROGRESS_ASSESSMENT_SCHEMA = object({
  steps: { type: "array", items: object({ stepId: str, quarters: num }) },
  criteria: { type: "array", items: object({ criterionId: str, quarters: num, note: str }) },
  summary: str
});
export function validateProgressAssessment(value: unknown, stepIds: string[], criterionIds: string[]): ProgressAssessment {
  const answer = value as ProgressAssessment | undefined;
  if (!answer || !Array.isArray(answer.steps) || !Array.isArray(answer.criteria) || typeof answer.summary !== "string") throw new Error("PROGRESS_ASSESSMENT_INVALID");
  const quarters = (value: number) => Math.max(0, Math.min(4, Math.round(Number(value) || 0)));
  return {
    steps: answer.steps.filter((item) => stepIds.includes(item.stepId)).map((item) => ({ stepId: item.stepId, quarters: quarters(item.quarters) })),
    criteria: answer.criteria.filter((item) => criterionIds.includes(item.criterionId))
      .map((item) => ({ criterionId: item.criterionId, quarters: quarters(item.quarters), note: String(item.note ?? "").trim().slice(0, 300) })),
    summary: answer.summary.trim().slice(0, 600)
  };
}

export const MAX_STEPS = 40;
/** A task is 30 minutes to 8 hours of usual work (longer work is split into tasks); a step is 5 minutes to 4 hours. */
export const TASK_MINUTES = { min: 30, max: 480 } as const;
export const STEP_MINUTES = { min: 5, max: 240 } as const;
/** What the person may set by hand on a task or a step: 15 minutes to 8 hours (the slider's range; decided 2026-10-10). */
export const EDIT_MINUTES = { min: 15, max: 480 } as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The hard check: the shape. Throws so the runner sends the problem back on the same thread. */
export function validateStepPlanShape(value: unknown, extra: readonly Archetype[] = []): StepPlan {
  const plan = value as StepPlan | undefined;
  if (!plan || !archetypeById(plan.archetypeId, extra) || !Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > MAX_STEPS)
    throw new Error("STEP_PLAN_SCHEMA_INVALID");
  for (const step of plan.steps) {
    if (!step || typeof step.id !== "string" || !step.id.trim() || !isStepRole(step.role) || typeof step.title !== "string" || !step.title.trim())
      throw new Error("STEP_PLAN_STEP_INVALID");
  }
  return plan;
}

/**
 * Preparation that is not the person's to do (decided 2026-10-09: the person's attention goes to the intellectual core; the assistant
 * does the rest and puts the result in front of them). A step of the person's whose title is only collecting, listing, sorting or
 * filing material is handed to the assistant by normalization, whatever the model said.
 */
export const TRIVIAL_STEP = /^(清点|整理(材料|资料|文件|课程材料)|收集|汇总|列出|归档|登记|下载|查找资料|检索|建立(材料|资料)?清单|准备材料|标注课程|核对(文件|材料)归属)/;

/** A unit's quote must be in the document it names (letters and digits in order, ignoring spacing and punctuation). */
export function unverifiedUnits(units: StepUnit[], documents: Array<{ id: string; text: string }>): StepUnit[] {
  const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const texts = new Map(documents.map((doc) => [doc.id, squash(doc.text)]));
  return units.filter((unit) => { const text = texts.get(unit.docId); const quote = squash(unit.quote); return !text || quote.length < 2 || !text.includes(quote); });
}

/**
 * Makes any shape-valid plan usable: unique safe ids, ordered estimates, dependencies only on known earlier-or-later steps with cycles
 * broken, shares normalized, dates kept only when they are dates. Returns what it had to change as warnings.
 */
export function normalizeStepPlan(plan: StepPlan): { plan: StepPlan; warnings: StepWarning[] } {
  const warnings: StepWarning[] = [];
  const idMap = new Map<string, string>();
  const steps = plan.steps.map((step, index) => {
    const id = `s${index + 1}`;
    idMap.set(step.id, id);
    const raw = [step.estimate?.p25Minutes, step.estimate?.p50Minutes, step.estimate?.p85Minutes].map((value) =>
      Number.isFinite(value) && (value as number) > 0 ? Math.min(10_080, Math.round(value as number)) : 0);
    const p50 = raw[1] || raw[0] || raw[2] || 30;
    const p25 = Math.min(raw[0] || Math.round(p50 * 0.7), p50), p85 = Math.max(raw[2] || Math.round(p50 * 1.5), p50);
    if (!raw[1]) warnings.push({ code: "STEP_ESTIMATE_MISSING", detail: `「${step.title}」没有通常耗时，按 ${p50} 分钟计` });
    return { ...step, id, title: step.title.trim().slice(0, 120), deliverable: (step.deliverable ?? "").trim().slice(0, 300),
      doneCriterion: (step.doneCriterion ?? "").trim().slice(0, 300), share: Number.isFinite(step.share) && step.share > 0 ? step.share : 0,
      estimate: { p25Minutes: p25, p50Minutes: p50, p85Minutes: p85 },
      notBefore: DAY.test(step.notBefore ?? "") ? step.notBefore : "", dueBy: DAY.test(step.dueBy ?? "") ? step.dueBy : "",
      schedulable: step.role === "wait" ? false : step.schedulable !== false,
      executor: (["human", "agent", "mixed"] as const).includes(step.executor) ? step.executor : "human",
      tickOutcome: (step.tickOutcome ?? "").trim().slice(0, 120), dependsOn: step.dependsOn ?? [],
      covers: Array.isArray(step.covers) ? step.covers.filter((id) => typeof id === "string") : [], why: (step.why ?? "").trim().slice(0, 300) };
  });
  // Preparation is the assistant's: a person's step that only gathers or files material moves to it, and the assistant's steps never
  // take time on the person's calendar.
  for (const step of steps) {
    if (step.executor !== "agent" && step.role !== "wait" && TRIVIAL_STEP.test(step.title)) {
      step.executor = "agent";
      warnings.push({ code: "STEP_TRIVIAL_TO_AGENT", detail: `「${step.title}」是准备工作，改由助手完成` });
    }
    if (step.executor === "agent") step.schedulable = false;
  }
  // Dependencies: known ids only, then any edge that closes a cycle is dropped (the latest-listed edge first).
  for (const step of steps) {
    const known = step.dependsOn.map((dep) => idMap.get(dep)).filter((dep): dep is string => Boolean(dep) && dep !== step.id);
    if (known.length !== step.dependsOn.length) warnings.push({ code: "STEP_DEPENDENCY_UNKNOWN", detail: `「${step.title}」依赖了不存在的步骤，已忽略` });
    step.dependsOn = [...new Set(known)];
  }
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (steps.find((step) => step.id === from)?.dependsOn ?? []).some((dep) => reaches(dep, to, seen));
  };
  for (const step of steps) {
    for (const dep of [...step.dependsOn].reverse()) {
      if (reaches(dep, step.id)) {
        step.dependsOn = step.dependsOn.filter((item) => item !== dep);
        warnings.push({ code: "STEP_CYCLE_BROKEN", detail: `「${step.title}」与前置步骤成环，已断开一条依赖` });
      }
    }
  }
  const total = steps.reduce((sum, step) => sum + step.share, 0);
  if (total <= 0) {
    const minutes = steps.reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
    for (const step of steps) step.share = step.estimate.p50Minutes / minutes;
    warnings.push({ code: "STEP_SHARE_MISSING", detail: "步骤没有进度份额，已按耗时分配" });
  } else {
    if (Math.abs(total - 1) > 0.05) warnings.push({ code: "STEP_SHARE_NORMALIZED", detail: `进度份额合计 ${total.toFixed(2)}，已归一` });
    for (const step of steps) step.share = step.share / total;
  }
  for (const step of steps) step.share = Math.round(step.share * 1000) / 1000;
  const amount = Number.isFinite(plan.quantity?.amount) ? Math.max(0, plan.quantity.amount) : 0;
  const units = (Array.isArray(plan.units) ? plan.units : []).filter((unit) => unit && unit.id && unit.title)
    .map((unit) => ({ id: String(unit.id).slice(0, 40), title: String(unit.title).trim().slice(0, 160), docId: String(unit.docId ?? ""), quote: String(unit.quote ?? "").slice(0, 300) })).slice(0, 60);
  const unitIds = new Set(units.map((unit) => unit.id));
  for (const step of steps) step.covers = step.covers.filter((id) => unitIds.has(id));
  const questions = (Array.isArray(plan.questions) ? plan.questions : []).filter((question) => question && question.text)
    .map((question, index) => ({ id: String(question.id || `q${index + 1}`).slice(0, 40), text: String(question.text).trim().slice(0, 200),
      why: String(question.why ?? "").trim().slice(0, 300), options: (question.options ?? []).map((option) => String(option).trim().slice(0, 80)).filter(Boolean).slice(0, 8) })).slice(0, 5);
  return { plan: { archetypeId: plan.archetypeId, rationale: (plan.rationale ?? "").trim().slice(0, 600),
    quantity: { basis: (plan.quantity?.basis ?? "").slice(0, 60), amount, unit: (plan.quantity?.unit ?? "").slice(0, 12) }, units, questions, steps }, warnings };
}

/**
 * Content checks against the archetype and the task's window. `availableMinutes` is the working time between the window's start and
 * end (omitted when unknown). Warnings only.
 */
export function stepPlanWarnings(plan: StepPlan, window: { notBefore?: string; dueBy?: string; availableMinutes?: number } = {},
  extra: readonly Archetype[] = []): StepWarning[] {
  const archetype = archetypeById(plan.archetypeId, extra);
  if (!archetype) return [{ code: "STEP_ARCHETYPE_UNKNOWN", detail: plan.archetypeId }];
  const warnings: StepWarning[] = [];
  const roles = plan.steps.map((step) => step.role);
  for (const step of plan.steps) {
    if (step.schedulable && step.estimate.p50Minutes < 15) warnings.push({ code: "STEP_TOO_SHORT", detail: `「${step.title}」只有 ${step.estimate.p50Minutes} 分钟，不足一个工作时段` });
    if (!archetype.roles.includes(step.role)) warnings.push({ code: "STEP_ROLE_OUTSIDE_ARCHETYPE", detail: `「${step.title}」的类型「${STEP_ROLES[step.role]}」不在「${archetype.label}」的常见步骤中` });
    if (!step.doneCriterion) warnings.push({ code: "STEP_DONE_CRITERION_MISSING", detail: `「${step.title}」没有完成标准` });
  }
  for (const role of archetype.requires) if (!roles.includes(role)) warnings.push({ code: "STEP_REQUIRED_ROLE_MISSING", detail: `缺少「${STEP_ROLES[role]}」步骤` });
  for (const [before, after] of archetype.firstBefore) {
    const a = roles.indexOf(before), b = roles.indexOf(after);
    if (a >= 0 && b >= 0 && a > b) warnings.push({ code: "STEP_ORDER_RULE", detail: `首个「${STEP_ROLES[before]}」应在首个「${STEP_ROLES[after]}」之前` });
  }
  if (archetype.endsWith?.length && !archetype.endsWith.includes(roles.at(-1)!))
    warnings.push({ code: "STEP_END_RULE", detail: `最后一步通常是${archetype.endsWith.map((role) => `「${STEP_ROLES[role]}」`).join("或")}` });
  const p50 = plan.steps.filter((step) => step.schedulable).reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
  if (plan.quantity.amount > 0) {
    const [low, high] = archetype.quantify.minutesPerUnit;
    if (p50 < plan.quantity.amount * low * 0.5 || p50 > plan.quantity.amount * high * 1.5)
      warnings.push({ code: "STEP_TOTAL_OFF_QUANTITY", detail: `合计 ${p50} 分钟，按 ${plan.quantity.amount}${plan.quantity.unit} 估算应在 ${plan.quantity.amount * low}–${plan.quantity.amount * high} 分钟` });
  }
  if (window.availableMinutes !== undefined && p50 > window.availableMinutes)
    warnings.push({ code: "STEP_WINDOW_TOO_SMALL", detail: `合计 ${p50} 分钟，可用时段只有 ${window.availableMinutes} 分钟` });
  for (const step of plan.steps) {
    if (window.dueBy && step.dueBy && step.dueBy > window.dueBy) warnings.push({ code: "STEP_AFTER_DUE", detail: `「${step.title}」晚于截止日` });
    if (window.notBefore && step.notBefore && step.notBefore < window.notBefore) warnings.push({ code: "STEP_BEFORE_RELEASE", detail: `「${step.title}」早于开始日` });
  }
  return warnings;
}

export type StepStatus = "planned" | "done" | "skipped";
/** Progress of the whole task: done steps' shares, plus a started step's share × its quarters. */
export function taskProgress(steps: ReadonlyArray<{ share: number; status: StepStatus; progressQuarter: number }>): number {
  const value = steps.reduce((sum, step) => sum + (step.status === "done" || step.status === "skipped" ? step.share
    : step.share * Math.max(0, Math.min(4, step.progressQuarter)) / 4), 0);
  return Math.max(0, Math.min(1, value));
}
