import { ARCHETYPE_IDS, PRODUCT_OWNER, STEP_PRODUCTS, STEP_ROLES, archetypeById, isStepRole, productOf, type Archetype, type StepProduct, type StepRole } from "./archetypes";
import { normalizeAiAssist } from "./ai-tools";
import { INFO_REQUEST_PERSON_MINUTES, infoRequestTraits } from "./info-request";
import { COMPLETION_FIELD, type ModelCompletion } from "./completion";
import { WORK_OWNERS, workOwner, type WorkOwner } from "./work-owner";

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
  /**
   * The AI tool that takes the drudgery out of a step the person does (docs/skills-library.md §7): which of the person's tools, how in one
   * concrete line, and the minutes it saves against doing it by hand — the estimate is already the time with it. Empty tool: none fits.
   * Optional for plans stored before it; the schema requires it.
   */
  aiAssist?: { tool: string; how: string; minutesSaved: number };
  /**
   * The concrete first move of a person's step, five minutes at most (「打开讲义第 3 章，读第一页」): what makes a step easy to begin
   * (docs/energy-and-ecosystem.md §6). "" for the assistant's steps and waits. Optional in the type for plans stored before it; the
   * schema requires it. Not `opener`: that names the day's first message.
   */
  firstAction?: string;
  /**
   * Who does it (`work-owner.ts`): `person`, `assistant`, or `ask` (one question to the person, then the assistant). The model gives it,
   * normalization corrects it and keeps `executor` in step with it. Optional for plans stored before it; the schema requires it.
   */
  owner?: WorkOwner;
  /**
   * What the step produces (`STEP_TYPES` in archetypes.ts): who does it follows from it, and only `ability` steps get a tutorial.
   * Optional for plans stored before it (2026-10-22); the schema requires it and normalization fills a role's default.
   */
  product?: StepProduct;
  /** Ids of the plan's `needs` this step cannot be done (or prepared for) without. */
  uses?: string[];
  /** On the step that asks the person for a need: that need's id (the step shows an upload box and 「没有」). */
  provides?: string;
};
/**
 * Material the task needs that the files and folders on record do not cover and that the person is known to have (their lecture notes,
 * the problem set behind their course login, a brief they received). Decided 2026-10-22, the owner: look in the person's files first,
 * then on the web for a tutorial or plan made for this very task, and only when neither is enough ask the person — and only for material
 * something on record says they have (`basis`: the fact, file or the task's own words that say so). A need with no basis is dropped.
 */
export type StepNeed = { id: string; what: string; why: string; basis: string };
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
  /**
   * How finishing the task is taken (`completion.ts`), judged with the task's material in hand. Kept on the task only when the task has no
   * judgement yet (one from a course's dates, or written before the field). Optional for plans stored before it; the schema requires it.
   */
  completion?: ModelCompletion;
  units: StepUnit[];
  questions: StepQuestion[];
  /** Optional for plans stored before it; the schema requires it. */
  needs?: StepNeed[];
  steps: PlannedStep[];
  /**
   * The short ids of the facts, preferences and lessons (「[f3]」「[p1]」「[l2]」) the plan really rests on, counted as used when it is saved
   * (migration 20). Not stored with the plan; the schema requires it.
   */
  usedRefs?: string[];
};
export type StepWarning = { code: string; detail: string };

const str = { type: "string" };
const num = { type: "number" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

/** At most this many of the person's materials are asked for in one plan; a provide step takes this long (finding and uploading a file). */
export const MAX_NEEDS = 4;
export const PROVIDE_MINUTES = 5;
/** The key under which the person's choice of who does a kind of step is kept (setting `steps.ownerPreferences`): line, role, product. */
export const ownerPreferenceKey = (lineId: string, role: string, product: StepProduct) => `${lineId}|${role}|${product}`;

/** A first move is one short line: anything longer is a step of its own. */
export const FIRST_ACTION_MAX = 80;

/** The step plan schema; `extraIds` adds the archetypes learned for this workspace to the ones the answer may name. */
export const stepPlanSchema = (extraIds: readonly string[] = []) => object({
  archetypeId: { type: "string", enum: [...ARCHETYPE_IDS, ...extraIds] },
  quantity: object({ basis: str, amount: num, unit: str }),
  rationale: str,
  importance: object({ longTerm: { type: "boolean" }, why: str }),
  completion: COMPLETION_FIELD,
  units: { type: "array", items: object({ id: str, title: str, docId: str, quote: str }) },
  questions: { type: "array", items: object({ id: str, text: str, why: str, options: { type: "array", items: str } }) },
  needs: { type: "array", items: object({ id: str, what: str, why: str, basis: str }) },
  steps: { type: "array", items: object({
    id: str, role: { type: "string", enum: Object.keys(STEP_ROLES) }, title: str, deliverable: str, doneCriterion: str, share: num,
    estimate: object({ p25Minutes: num, p50Minutes: num, p85Minutes: num }),
    dependsOn: { type: "array", items: str }, notBefore: str, dueBy: str, schedulable: { type: "boolean" },
    executor: { type: "string", enum: ["human", "agent", "mixed"] }, tickOutcome: str, covers: { type: "array", items: str }, why: str,
    aiAssist: object({ tool: str, how: str, minutesSaved: num }),
    firstAction: str,
    owner: { type: "string", enum: [...WORK_OWNERS] },
    product: { type: "string", enum: Object.keys(STEP_PRODUCTS) },
    uses: { type: "array", items: str }
  }) },
  usedRefs: { type: "array", items: str }
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
/**
 * A field as the plan's type says it is. Through another provider's chat bridge the schema is only described to the model, never
 * enforced, so a list can arrive as one string and a text as a number: GLM-5.3-Flash gave `dependsOn: "s1"` on a real task on
 * 2026-10-20, normalization threw on `.map`, and the planner failed after a paid run instead of keeping the plan.
 */
const text = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
  : typeof value === "string" ? value.split(/[\s,，、;；]+/).filter(Boolean) : [];

export function normalizeStepPlan(plan: StepPlan, toolNames?: string[], options: {
  /** False only where no assistant can take a step: every step is then the person's (or mixed). Every account has one now (tools mode). */
  assistant?: boolean;
  /** The person's own choices of who does a kind of step (`role|product` → owner), applied where nothing forces the person. */
  ownerPreferences?: ReadonlyMap<string, "person" | "assistant"> } = {}): { plan: StepPlan; warnings: StepWarning[] } {
  const assistant = options.assistant !== false;
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
    return { ...step, id, title: step.title.trim().slice(0, 120), deliverable: text(step.deliverable).trim().slice(0, 300),
      doneCriterion: text(step.doneCriterion).trim().slice(0, 300), share: Number.isFinite(step.share) && step.share > 0 ? step.share : 0,
      estimate: { p25Minutes: p25, p50Minutes: p50, p85Minutes: p85 },
      notBefore: DAY.test(text(step.notBefore)) ? step.notBefore : "", dueBy: DAY.test(text(step.dueBy)) ? step.dueBy : "",
      schedulable: step.role === "wait" ? false : step.schedulable !== false,
      executor: (["human", "agent", "mixed"] as const).includes(step.executor) ? step.executor : "human",
      tickOutcome: text(step.tickOutcome).trim().slice(0, 120), dependsOn: list(step.dependsOn),
      covers: list(step.covers), why: text(step.why).trim().slice(0, 300),
      aiAssist: normalizeAiAssist(step.aiAssist, toolNames, p50),
      firstAction: text(step.firstAction).trim().slice(0, FIRST_ACTION_MAX),
      owner: (step.owner === "assistant" || step.owner === "ask" || step.owner === "person" ? step.owner : step.executor === "agent" ? "assistant" : "person") as WorkOwner,
      // No product named: what the model said about the doer picks among the role's products (the assistant's work is material).
      product: productOf(step.role, step.product ?? (step.executor === "agent" ? "material" : undefined)), uses: list(step.uses) };
  });
  // The person's own material first: each need becomes a provide step at the front (an upload box and 「没有」, no calendar time).
  // Only material something on record says the person has: a need without that is guessed, and asking for it wastes their time.
  const needs = (Array.isArray(plan.needs) ? plan.needs : []).filter((need) => need && text(need.what).trim() && text(need.basis).trim()).slice(0, MAX_NEEDS)
    .map((need, index) => ({ id: String(need.id || `n${index + 1}`).slice(0, 40), what: text(need.what).trim().slice(0, 80), why: text(need.why).trim().slice(0, 200),
      basis: text(need.basis).trim().slice(0, 200) }));
  const needIds = new Set(needs.map((need) => need.id));
  for (const step of steps) step.uses = step.uses.filter((id) => needIds.has(id));
  const provides = needs.map((need, index) => ({ id: `provide${index + 1}`, role: "prepare" as StepRole, title: `提供${need.what}`.slice(0, 120),
    deliverable: need.what, doneCriterion: "已上传，或说明没有", share: 0,
    estimate: { p25Minutes: PROVIDE_MINUTES, p50Minutes: PROVIDE_MINUTES, p85Minutes: PROVIDE_MINUTES * 2 }, dependsOn: [] as string[],
    notBefore: "", dueBy: "", schedulable: false, executor: "human" as StepExecutor, tickOutcome: "", covers: [] as string[], why: need.why,
    aiAssist: { tool: "", how: "", minutesSaved: 0 }, firstAction: "上传文件，或点「没有」", owner: "person" as WorkOwner,
    product: "material" as StepProduct, uses: [] as string[], provides: need.id }));
  for (const provide of provides) idMap.set(provide.id, provide.id);
  for (const step of steps) for (const need of step.uses) {
    const provide = provides.find((item) => item.provides === need)!;
    if (!step.dependsOn.includes(provide.id)) step.dependsOn.push(provide.id);
  }
  steps.unshift(...provides);
  const questions = (Array.isArray(plan.questions) ? plan.questions : []).filter((question) => question && question.text)
    .map((question, index) => ({ id: String(question.id || `q${index + 1}`).slice(0, 40), text: String(question.text).trim().slice(0, 200),
      why: String(question.why ?? "").trim().slice(0, 300), options: (Array.isArray(question.options) ? question.options : list(question.options))
        .map((option) => String(option).trim().slice(0, 80)).filter(Boolean).slice(0, 8) }));
  const reviews = assignStepOwners(steps, questions, warnings, { assistant, ...(options.ownerPreferences ? { ownerPreferences: options.ownerPreferences } : {}) });
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
  foldReviews(steps, reviews, warnings);
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
  return { plan: { archetypeId: plan.archetypeId, rationale: text(plan.rationale).trim().slice(0, 600),
    quantity: { basis: text(plan.quantity?.basis).slice(0, 60), amount, unit: text(plan.quantity?.unit).slice(0, 12) }, units,
    questions: questions.slice(0, 5), needs, steps }, warnings };
}

/**
 * Who does each step (docs/work-split.md): the person only for their own growth and core work. What the assistant can make from the
 * material is its step, and it never takes time on the person's calendar; what needs one fact only the person holds is a question plus the
 * assistant's step; reviewing the assistant's output is returned (the ids) to be folded into the first core step (`foldReviewSteps`).
 * Shared by `normalizeStepPlan` and the one-time reorganisation of plans already stored (`apps/worker/src/work-split-repair.ts`).
 */
const ACCEPTS_OUTPUT = /^(?:验收|批准|审核|审阅|核验|核对|复核|定稿|审定)/;
const JUDGES = /结论|科学|正确|边界|权限|规则|选定|决定|取舍/;

export function assignStepOwners(steps: PlannedStep[], questions: StepQuestion[], warnings: StepWarning[],
  options: { assistant?: boolean; /** The task's title: a step of graded homework touching its problems stays the person's. */ taskTitle?: string;
    /** Steps (of a stored plan being judged again) that come right after, or wait on, the assistant's already-finished work. */
    afterAgent?: ReadonlySet<string>;
    /** `role|product` → the owner the person chose for that kind of step (4A); never over what only the person may do. */
    ownerPreferences?: ReadonlyMap<string, "person" | "assistant"> } = {}): Set<string> {
  const assistant = options.assistant !== false;
  const reviews = new Set<string>();
  for (const step of steps) {
    if (!assistant) {
      if (step.executor === "agent") {
        step.executor = "human";
        step.schedulable = step.role !== "wait";
        warnings.push({ code: "STEP_NO_ASSISTANT", detail: `「${step.title}」改由本人完成：这个账号没有助手` });
      }
      step.owner = "person";
      if (step.role === "wait") step.firstAction = "";
      continue;
    }
    // Asking someone for a fact: the assistant drafts the message, the person sends it — sending is an external act (info-request.ts).
    const request = step.role === "prepare" || /草稿|起草/.test(step.title) ? null : infoRequestTraits({ title: step.title, p50Minutes: step.estimate.p50Minutes }).request;
    if (request?.kind === "ask_person" && step.executor !== "human") {
      step.executor = "human";
      step.schedulable = true;
      step.owner = "person";
      warnings.push({ code: "STEP_INFO_REQUEST_PERSON", detail: `「${step.title}」要向别人发出询问，改由本人检查草稿后发送` });
      continue;
    }
    // Handing over material only the person has: theirs, an upload rather than work.
    if (step.provides) { step.executor = "human"; step.owner = "person"; step.schedulable = false; continue; }
    if (step.role !== "wait" && step.product) {
      const product = productOf(step.role, step.product);
      step.product = product;
      // The wording rules are a cross-check now: they can only force the person (acts, choices, graded answers, practice), fold a
      // review, or turn the assistant's step into a question; the table decides the rest.
      const verdict = workOwner({ title: step.title, owner: PRODUCT_OWNER[product], ...(options.taskTitle ? { taskTitle: options.taskTitle } : {}) });
      const forced = ["external", "decision", "graded", "person_skill"].includes(verdict.code) && verdict.owner === "person";
      if (!forced && step.executor !== "agent" && verdict.code === "review_only") { reviews.add(step.id); continue; }
      if (!forced && step.executor !== "agent" && ACCEPTS_OUTPUT.test(step.title) && !JUDGES.test(step.title) && product !== "ability"
        && (step.dependsOn.some((dep) => steps.find((other) => other.id === dep)?.executor === "agent")
          || steps[steps.indexOf(step) - 1]?.executor === "agent" || options.afterAgent?.has(step.id))) { reviews.add(step.id); continue; }
      const preferred = options.ownerPreferences?.get(`${step.role}|${product}`);
      const table = PRODUCT_OWNER[product];
      const owner: WorkOwner = forced || step.role === "decide" ? "person" : preferred ?? (table === "assistant" && verdict.owner === "ask" ? "ask" : table);
      if (!forced && !preferred && (verdict.code === "design" || verdict.code === "static_artifact") && verdict.owner !== table)
        warnings.push({ code: "STEP_OWNER_TABLE", detail: `「${step.title}」按产出（${STEP_PRODUCTS[product]}）由${table === "person" ? "本人" : "助手"}做，措辞规则判为${verdict.owner === "person" ? "本人" : "助手"}` });
      const was = step.executor;
      step.executor = owner === "person" ? (was === "agent" ? "human" : was) : "agent";
      if (owner === "person" && was === "agent") {
        step.schedulable = true;
        warnings.push({ code: "STEP_OWNER_PERSON", detail: `「${step.title}」改由本人完成：${forced ? verdict.reason : preferred ? "本人选择这类步骤自己做" : `产出是${STEP_PRODUCTS[product]}`}` });
      } else if (owner !== "person" && was !== "agent") warnings.push({ code: owner === "ask" ? "STEP_OWNER_ASK" : "STEP_TRIVIAL_TO_AGENT",
        detail: `「${step.title}」${owner === "ask" ? "改为问本人一句后由助手完成" : preferred ? "按本人的选择交给助手" : "产出是材料，改由助手完成"}` });
      if (owner === "ask") {
        const question = verdict.question ?? `「${step.title}」需本人提供哪些信息？`;
        if (questions.length < 5 && !questions.some((item) => item.text === question))
          questions.push({ id: `q${questions.length + 1}`, text: question, why: `「${step.title}」需要本人持有的信息，答完由助手接着做`, options: [] });
      }
      step.owner = owner;
    } else if (step.role !== "wait") {
      // `executor: "agent"` is the model's word that the assistant does it, whatever `owner` it also wrote; `ask` stays a question.
      const verdict = workOwner({ title: step.title, owner: step.executor === "agent" && step.owner !== "ask" ? "assistant" : step.owner ?? "person",
        ...(options.taskTitle ? { taskTitle: options.taskTitle } : {}) });
      // Approving what the assistant just made (「验收定义稿」「批准可交付版本」「核验版本基线包」): the step before it, or one it waits on,
      // is the assistant's, and the step only checks that output. The real account kept a dozen of these after the first rule, which
      // asked for 「助手」 in the title; a judgement (结论, 边界, 权限), a decision or graded work is not folded.
      // A step the plan itself calls a decision is the person's, whatever its verb (「批准首轮试用候选人」 went to the assistant on 10-22).
      if (step.role === "decide") {
        if (step.executor === "agent") { step.executor = "human"; step.schedulable = true;
          warnings.push({ code: "STEP_OWNER_PERSON", detail: `「${step.title}」改由本人完成：有后果的选择由本人做` }); }
        step.owner = "person";
        continue;
      }
      if (step.executor !== "agent" && ACCEPTS_OUTPUT.test(step.title) && !JUDGES.test(step.title) && verdict.code === "model"
        && (step.dependsOn.some((dep) => steps.find((other) => other.id === dep)?.executor === "agent")
          || steps[steps.indexOf(step) - 1]?.executor === "agent" || options.afterAgent?.has(step.id))) {
        reviews.add(step.id);
        continue;
      }
      // The older, narrower rule still holds where the new one has nothing to say; so does the plan's own role: a step it calls
      // gathering (「汇集候选人联系底稿」「取得小测3正式范围」) is the assistant's unless something about it is the person's.
      const owner = verdict.code === "model" && verdict.owner === "person" && (TRIVIAL_STEP.test(step.title) || step.role === "gather") ? "assistant" : verdict.owner;
      if (owner === "person" && step.executor === "agent") {
        step.executor = "human";
        step.schedulable = true;
        warnings.push({ code: "STEP_OWNER_PERSON", detail: `「${step.title}」改由本人完成：${verdict.reason}` });
      } else if (owner === "assistant" && verdict.code === "review_only" && step.executor !== "agent") {
        reviews.add(step.id);
      } else if (owner === "assistant" && step.executor !== "agent") {
        step.executor = "agent";
        warnings.push({ code: "STEP_TRIVIAL_TO_AGENT", detail: `「${step.title}」是准备工作，改由助手完成` });
      } else if (owner === "ask") {
        step.executor = "agent";
        const question = verdict.question ?? `「${step.title}」需本人提供哪些信息？`;
        if (questions.length < 5 && !questions.some((item) => item.text === question))
          questions.push({ id: `q${questions.length + 1}`, text: question, why: `「${step.title}」需要本人持有的信息，答完由助手接着做`, options: [] });
        warnings.push({ code: "STEP_OWNER_ASK", detail: `「${step.title}」改为问本人一句后由助手完成` });
      }
      step.owner = step.executor === "agent" ? (owner === "ask" ? "ask" : "assistant") : "person";
    } else step.owner = "person";
    if (step.executor === "agent") step.schedulable = false;
    // A first move is the person's: the assistant's steps and waits have none.
    if (step.executor === "agent" || step.role === "wait") step.firstAction = "";
  }
  return reviews;
}

/** A step whose doer changed when a stored plan was judged again: to another executor, or folded into a person's step as a glance. */
export type StepOwnerChange = { stepId: string; title: string; from: StepExecutor; to: StepExecutor | "folded"; into?: string };
type StoredStepLike = Omit<PlannedStep, "role" | "covers" | "why"> & { role: string; covers?: string[]; why?: string };

/**
 * The open steps of a plan already stored, judged again by the rules a new plan goes through (`assignStepOwners`, `foldReviewSteps`):
 * the assistant's work becomes its step (off the calendar), a step needing the person's data becomes the assistant's plus a question, and
 * a review-only step is folded into the next person's step. Done steps are not passed and not touched; a dependency on one is kept. The
 * shares are not normalized: the removed review's share moves to the step it folds into, so the task's progress is unchanged.
 */
export function resplitOpenSteps(open: readonly StoredStepLike[], questions: readonly StepQuestion[], taskTitle?: string,
  /** The whole plan in its order (finished steps too), so a step approving what the assistant already made is still recognised. */
  plan: readonly Pick<StoredStepLike, "id" | "executor" | "dependsOn">[] = open):
  { steps: PlannedStep[]; questions: StepQuestion[]; changes: StepOwnerChange[] } {
  const steps: PlannedStep[] = open.map((step) => ({ ...step, role: step.role as StepRole, covers: step.covers ?? [], why: step.why ?? "", dependsOn: [...step.dependsOn],
    estimate: { ...step.estimate }, owner: step.owner ?? (step.executor === "agent" ? "assistant" : "person") }));
  const before = new Map(steps.map((step) => [step.title, step.executor]));
  const asked = questions.map((question) => ({ ...question, options: [...question.options] }));
  const warnings: StepWarning[] = [];
  const openIds = new Set(open.map((step) => step.id));
  const agentDone = new Set(plan.filter((step) => !openIds.has(step.id) && step.executor === "agent").map((step) => step.id));
  const order = plan.map((step) => step.id);
  const afterAgent = new Set(open.filter((step) => step.dependsOn.some((dep) => agentDone.has(dep))
    || agentDone.has(order[order.indexOf(step.id) - 1] ?? "")).map((step) => step.id));
  const reviews = assignStepOwners(steps, asked, warnings, { ...(taskTitle ? { taskTitle } : {}), afterAgent });
  const reviewed = steps.filter((step) => reviews.has(step.id)).map((step) => ({ id: step.id, title: step.title, executor: step.executor }));
  foldReviewSteps(steps, reviews, warnings);
  const changes: StepOwnerChange[] = [];
  for (const review of reviewed) {
    if (steps.some((step) => step.title === review.title)) continue;
    const into = warnings.find((warning) => warning.code === "STEP_REVIEW_FOLDED" && warning.detail.startsWith(`「${review.title}」`))?.detail.match(/并入「(.+)」开始时/)?.[1];
    changes.push({ stepId: review.id, title: review.title, from: review.executor, to: "folded", ...(into ? { into } : {}) });
  }
  for (const step of steps) {
    const was = before.get(step.title);
    if (was && was !== step.executor) changes.push({ stepId: step.id, title: step.title, from: was, to: step.executor });
  }
  return { steps, questions: asked, changes };
}

/** Folds review-only steps (from `assignStepOwners`) into the first core step that uses them; see `foldReviews`. */
export const foldReviewSteps = (steps: PlannedStep[], reviews: ReadonlySet<string>, warnings: StepWarning[]): void => foldReviews(steps, reviews, warnings);

/** How long a glance at the assistant's output takes inside the first core step (docs/work-split.md §3). */
export const REVIEW_GLANCE_MINUTES = 10;

/**
 * A person's step that only reviews the assistant's output (or writes an acceptance checklist) is not a step: the acceptance gate judges
 * the assistant's work, and the person glances at it when the core step that uses it begins. The glance becomes the start of that step's
 * `firstAction` and at most ten minutes of its estimate; the review step is removed, its dependants take its dependencies, and the ids are
 * numbered again. A review with no person's step to fold into is left to the assistant.
 */
function foldReviews(steps: PlannedStep[], reviews: ReadonlySet<string>, warnings: StepWarning[]) {
  if (!reviews.size) return;
  const person = (step: PlannedStep) => !reviews.has(step.id) && step.executor !== "agent" && step.role !== "wait";
  for (const id of [...reviews]) {
    const index = steps.findIndex((step) => step.id === id);
    const review = steps[index]!;
    // Only a step that comes after: folding a final check into an earlier draft (seen on the real account) reads backwards; with none
    // after it, the check is the acceptance gate's.
    const target = steps.find((step) => person(step) && step.dependsOn.includes(id)) ?? steps.slice(index + 1).find(person);
    if (!target) {
      review.executor = "agent"; review.owner = "assistant"; review.schedulable = false; review.firstAction = "";
      warnings.push({ code: "STEP_TRIVIAL_TO_AGENT", detail: `「${review.title}」只是验收，交给验收关卡` });
      continue;
    }
    const source = steps.find((step) => review.dependsOn.includes(step.id) && step.executor === "agent");
    const glance = `先用 ${REVIEW_GLANCE_MINUTES} 分钟扫一眼${source ? `「${source.title.slice(0, 16)}」的产出` : "助手备好的材料"}；`;
    target.firstAction = `${glance}${target.firstAction ?? ""}`.slice(0, FIRST_ACTION_MAX);
    const added = Math.min(REVIEW_GLANCE_MINUTES, review.estimate.p50Minutes);
    target.estimate = { p25Minutes: target.estimate.p25Minutes + added, p50Minutes: target.estimate.p50Minutes + added, p85Minutes: target.estimate.p85Minutes + added };
    target.share += review.share;
    for (const step of steps) if (step.dependsOn.includes(id))
      step.dependsOn = [...new Set([...step.dependsOn.filter((dep) => dep !== id), ...review.dependsOn])].filter((dep) => dep !== step.id);
    steps.splice(index, 1);
    warnings.push({ code: "STEP_REVIEW_FOLDED", detail: `「${review.title}」不单列为步骤：并入「${target.title}」开始时的 ${REVIEW_GLANCE_MINUTES} 分钟` });
  }
  const renumber = new Map(steps.map((step, index) => [step.id, `s${index + 1}`]));
  for (const step of steps) { step.id = renumber.get(step.id)!; step.dependsOn = step.dependsOn.map((dep) => renumber.get(dep) ?? dep); }
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
    // A request for a fact is a quarter of an hour by design (info-request.ts), not a step too short to schedule.
    if (step.schedulable && step.estimate.p50Minutes < 15 && !(step.estimate.p50Minutes <= INFO_REQUEST_PERSON_MINUTES && infoRequestTraits({ title: step.title }).match)) warnings.push({ code: "STEP_TOO_SHORT", detail: `「${step.title}」只有 ${step.estimate.p50Minutes} 分钟，不足一个工作时段` });
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

/**
 * The steps as shown for a task in `state`: an accepted task's open steps read as done (walkthrough W-16 — a task finished with 完成 still
 * showed 0/3 with step 1 「当前」). Acceptance now marks them in the ledger too; this covers tasks accepted before that.
 */
export function finishedSteps<T extends { status: StepStatus; progressQuarter: number }>(state: string, steps: readonly T[]): T[] {
  return state === "accepted" ? steps.map((step) => step.status === "planned" ? { ...step, status: "done" as const, progressQuarter: 4 } : step) : [...steps];
}
