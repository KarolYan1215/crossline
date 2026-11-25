import { clipWidth } from "./text-width";
import { tFor, type Locale } from "./i18n";
import { ARCHETYPE_IDS, PRODUCT_OWNER, STEP_PRODUCTS, STEP_ROLES, archetypeById, isStepRole, productOf, type Archetype, type StepProduct, type StepRole } from "./archetypes";
import { normalizeAiAssist } from "./ai-tools";
import { INFO_REQUEST_PERSON_MINUTES } from "./info-request";
import { COMPLETION_FIELD, type ModelCompletion } from "./completion";
import { WORK_OWNERS, workOwner, type WorkOwner } from "./work-owner";
import { EXTERNAL_FIELD } from "./external-action";
import { METHOD_QUESTION_ID, backedDrillForms, drillFormsIn, methodQuestion, screenDrillItems, stripDrillSentences } from "./drill-forms";
import { FAMILIARITY_FIELD, readModelFamiliarity, type ModelFamiliarity } from "./familiarity";

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
  /**
   * The model's reading (2026-11-22, replacing the verb list 「参加/出席…」): the step is going to an event at its own time (a talk, a
   * rehearsal, an exam sitting). It is never placed in free hours. Optional for plans stored before it; the schema requires it.
   */
  attends?: boolean;
  /**
   * The model's reading (2026-11-22, replacing the exercise word list): the step is physical exercise, so confirming it done on the
   * health line records a workout. Optional for plans stored before it; the schema requires it.
   */
  workout?: boolean;
  /**
   * The model's reading (2026-11-25, `external-action.ts`): the step leaves the machine or commits the person (sending, submitting,
   * contacting, attending, paying). It is then the person's. Optional for plans stored before it (the word list reads those); the schema
   * requires it.
   */
  external?: boolean;
};
/**
 * Material the task needs that the files and folders on record do not cover and that the person is known to have (their lecture notes,
 * the problem set behind their course login, a brief they received). Decided 2026-10-22, the owner: look in the person's files first,
 * then on the web for a tutorial or plan made for this very task, and only when neither is enough ask the person — and only for material
 * something on record says they have (`basis`: the fact, file or the task's own words that say so). A need with no basis is dropped.
 */
export type StepNeed = { id: string; what: string; why: string; basis: string;
  /**
   * `personal`: exists only with the person (their data, their logs, a link or file someone sent them, their own notes) — no web page can
   * stand in, so the person is asked at once. `reference`: content a public page may give as well (a course's lecture notes, past exams,
   * a standard) — looked for on the web first. Absent on plans from before it: `reference`. Found on 10-22: a CI run's own link was
   * "covered" by GitHub's general documentation.
   */
  kind?: "personal" | "reference" };
/**
 * One unit of the task's actual content, read from the person's material — a lecture, a chapter, a problem set, a section of a brief —
 * with the document and the verbatim line it was read from. Quantities are counted from these, never assumed (decided 2026-10-09: a
 * plan that counted 「3 个知识点」 for a course with a dozen lectures before the exam was worse than no plan).
 */
export type StepUnit = { id: string; title: string; docId: string; quote: string };
/** What a wrong assumption costs (docs/plans/attention-ledger-1120.md §7.1): minutes redone, what harm, and until when it can still be put right. */
export type QuestionHarm = "none" | "quality" | "deadline" | "external";
export type QuestionFixable = "before_step" | "after_submit" | "never";
export type StepQuestionCost = { waste: number; harm: QuestionHarm; fixable: QuestionFixable };
/**
 * What only the person can tell the planner (which lectures the exam covers, what they already know). Since 2026-11-20 each carries what
 * the plan assumes meanwhile (`assume`, one of `options`), the step that needs the answer (`neededBy`), what a wrong assumption costs
 * (`ifWrong`), and the model's own call whether it is worth the person's attention (`ask`). Code only checks the shape: an unasked
 * question is settled as its assumption; an asked one waits for the weekly review, or is put forward one or two days before its step.
 * The four fields are optional for plans stored before them.
 */
export type StepQuestion = { id: string; text: string; why: string; options: string[];
  assume?: string; neededBy?: string; ask?: boolean; ifWrong?: StepQuestionCost };
export const QUESTION_HARMS: readonly QuestionHarm[] = ["none", "quality", "deadline", "external"];
export const QUESTION_FIXABLE: readonly QuestionFixable[] = ["before_step", "after_submit", "never"];
/** A question the person must see now, not in the weekly review: a wrong guess does real harm and can never be put right. */
export const questionCannotWait = (question: Pick<StepQuestion, "ask" | "ifWrong">) =>
  question.ask === true && question.ifWrong?.fixable === "never" && (question.ifWrong.harm ?? "none") !== "none";
/**
 * The day a question's answer is needed (`YYYY-MM-DD`, "" when nothing dates it): its step's own earliest day, else the task's first
 * block (`schedule.orderStarts`, the web's record), else the task's due day. Two days before it the question leaves the weekly review
 * for 待确认; on it, unanswered, it is settled as its assumption.
 */
export function questionNeededDay(question: Pick<StepQuestion, "neededBy">, steps: ReadonlyArray<{ id: string; notBefore: string }>,
  orderStart: string | undefined, due: string | undefined): string {
  const step = question.neededBy ? steps.find((item) => item.id === question.neededBy) : undefined;
  const day = step?.notBefore || orderStart?.slice(0, 10) || due || "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}
/** How many days before its needed day an asked question comes to 待确认 (the person's choice, 2026-11-20: 开始前一两天提醒). */
export const QUESTION_LEAD_DAYS = 2;
/** The answer a question is settled with when nobody answers it. */
export const assumedAnswer = (question: Pick<StepQuestion, "assume" | "options">) =>
  question.assume && question.options.includes(question.assume) ? question.assume : question.options[0] ?? "";
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
   * How close the work is to what the person already knows, judged by the planner from their background (`familiarity.ts`; 2026-11-22,
   * replacing the rule score). The person's own choice still wins. Optional for plans stored before it; the schema requires it.
   */
  familiarity?: ModelFamiliarity;
  /**
   * The question the planner would ask about how the person usually does this kind of work, asked only when a drill form was cut and
   * nothing on record says how they work (`methodQuestion`; 2026-11-22, replacing the exam/writing word lists). Not stored.
   */
  methodQuestion?: { text: string; options: string[] };
  /**
   * How finishing the task is taken (`completion.ts`), judged with the task's material in hand. Kept on the task only when the task has no
   * judgement yet (one from a course's dates, or written before the field). Optional for plans stored before it; the schema requires it.
   */
  completion?: ModelCompletion;
  /**
   * The deliverable has no electronic form (a paper hand-in, an exam sat, an interview, a talk; 2026-11-21, §7.2 point 5): the system does
   * not check its content and waits for the outside result instead. Kept on the work order (`payload.offline`). Optional for plans stored
   * before it; the schema requires it.
   */
  offline?: boolean;
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
/** What names a secret — a password, a login credential, a code or key that signs someone in. Never asked for as an upload. */
const SECRET_MATERIAL = /凭据|凭证|密码(?!学)|口令|验证码|恢复代码|恢复码|密钥|私钥|助记词|\b(passwords?|passcodes?|credentials?|api[ -]?keys?|tokens?|recovery codes?|otp|2fa)\b/i;
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
  familiarity: FAMILIARITY_FIELD,
  methodQuestion: object({ text: str, options: { type: "array", items: str } }),
  completion: COMPLETION_FIELD,
  offline: { type: "boolean" },
  units: { type: "array", items: object({ id: str, title: str, docId: str, quote: str }) },
  questions: { type: "array", items: object({ id: str, text: str, why: str, options: { type: "array", items: str }, assume: str, neededBy: str,
    ask: { type: "boolean" }, ifWrong: object({ waste: num, harm: { type: "string", enum: [...QUESTION_HARMS] }, fixable: { type: "string", enum: [...QUESTION_FIXABLE] } }) }) },
  needs: { type: "array", items: object({ id: str, what: str, why: str, basis: str, kind: { type: "string", enum: ["personal", "reference"] } }) },
  steps: { type: "array", items: object({
    id: str, role: { type: "string", enum: Object.keys(STEP_ROLES) }, title: str, deliverable: str, doneCriterion: str, share: num,
    estimate: object({ p25Minutes: num, p50Minutes: num, p85Minutes: num }),
    dependsOn: { type: "array", items: str }, notBefore: str, dueBy: str, schedulable: { type: "boolean" },
    executor: { type: "string", enum: ["human", "agent", "mixed"] }, tickOutcome: str, covers: { type: "array", items: str }, why: str,
    aiAssist: object({ tool: str, how: str, minutesSaved: num }),
    firstAction: str,
    owner: { type: "string", enum: [...WORK_OWNERS] },
    product: { type: "string", enum: Object.keys(STEP_PRODUCTS) },
    uses: { type: "array", items: str },
    attends: { type: "boolean" },
    workout: { type: "boolean" },
    external: EXTERNAL_FIELD
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
  // The questions' shape (2026-11-20, §7.1): code checks, never rewrites; a wrong one goes back to the model with the reason.
  const ids = new Set(plan.steps.map((step) => step.id));
  const problems: string[] = [];
  for (const question of Array.isArray(plan.questions) ? plan.questions : []) {
    if (!question?.text) continue;
    const options = Array.isArray(question.options) ? question.options : [];
    // i18n-ignore-start: repair messages to the model
    if (options.length && question.assume !== undefined && !options.includes(question.assume)) problems.push(`问题「${question.text}」的 assume 必须是 options 之一`);
    if (question.neededBy && !ids.has(question.neededBy)) problems.push(`问题「${question.text}」的 neededBy「${question.neededBy}」不是本计划里的步骤 id`);
    if (question.ask === true && question.ifWrong && question.ifWrong.harm === "none" && !(question.ifWrong.waste > 0))
      problems.push(`问题「${question.text}」要问本人，ifWrong 却是没有代价（waste 0、harm none）：没有代价的就按 assume 做，ask 写 false`);
    // i18n-ignore-end
  }
  if (problems.length) throw Object.assign(new Error("STEP_QUESTION_INVALID"), { detail: problems.slice(0, 6).join("；") });
  return plan;
}

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
  ownerPreferences?: ReadonlyMap<string, "person" | "assistant">;
  /** The workspace's language: the provide steps written here are stored and shown to the person. */
  locale?: Locale | undefined;
  /**
   * The person's own words a drill form may rest on (`drill-forms.ts`): their confirmed facts, answers and preferences, and the words they
   * captured the task in. A drill form (订正, 错题本, 背诵, 打卡 …) none of them names is cut from the plan.
   */
  drillBacking?: readonly string[];
  /** Whether a fact already says how the person does this kind of work: then no method question is added when a drill form is cut. */
  methodKnown?: boolean } = {}): { plan: StepPlan; warnings: StepWarning[] } {
  const t = tFor(options.locale);
  const assistant = options.assistant !== false;
  const warnings: StepWarning[] = [];
  const idMap = new Map<string, string>();
  const drill = screenStepDrills(plan, options.drillBacking ?? [], warnings);
  const steps = drill.steps.map((step, index) => {
    const id = `s${index + 1}`;
    idMap.set(step.id, id);
    const raw = [step.estimate?.p25Minutes, step.estimate?.p50Minutes, step.estimate?.p85Minutes].map((value) =>
      Number.isFinite(value) && (value as number) > 0 ? Math.min(10_080, Math.round(value as number)) : 0);
    const p50 = raw[1] || raw[0] || raw[2] || 30;
    const p25 = Math.min(raw[0] || Math.round(p50 * 0.7), p50), p85 = Math.max(raw[2] || Math.round(p50 * 1.5), p50);
    if (!raw[1]) warnings.push({ code: "STEP_ESTIMATE_MISSING", detail: `「${step.title}」没有通常耗时，按 ${p50} 分钟计` }); // i18n-ignore
    return { ...step, id, title: step.title.trim().slice(0, 120), deliverable: text(step.deliverable).trim().slice(0, 300),
      doneCriterion: text(step.doneCriterion).trim().slice(0, 300), share: Number.isFinite(step.share) && step.share > 0 ? step.share : 0,
      estimate: { p25Minutes: p25, p50Minutes: p50, p85Minutes: p85 },
      notBefore: DAY.test(text(step.notBefore)) ? step.notBefore : "", dueBy: DAY.test(text(step.dueBy)) ? step.dueBy : "",
      schedulable: step.role === "wait" ? false : step.schedulable !== false,
      executor: (["human", "agent", "mixed"] as const).includes(step.executor) ? step.executor : "human",
      tickOutcome: text(step.tickOutcome).trim().slice(0, 120), dependsOn: list(step.dependsOn),
      covers: list(step.covers), why: text(step.why).trim().slice(0, 300),
      aiAssist: normalizeAiAssist(step.aiAssist, toolNames, p50),
      firstAction: clipWidth(text(step.firstAction).trim(), FIRST_ACTION_MAX),
      owner: (step.owner === "assistant" || step.owner === "ask" || step.owner === "person" ? step.owner : step.executor === "agent" ? "assistant" : "person") as WorkOwner,
      // No product named: what the model said about the doer picks among the role's products (the assistant's work is material).
      product: productOf(step.role, step.product ?? (step.executor === "agent" ? "material" : undefined)), uses: list(step.uses),
      ...(step.attends === true ? { attends: true } : {}), ...(step.workout === true ? { workout: true } : {}),
      ...(typeof step.external === "boolean" ? { external: step.external } : {}) };
  });
  // The person's own material first: each need becomes a provide step at the front (an upload box and 「没有」, no calendar time).
  // Only material something on record says the person has: a need without that is guessed, and asking for it wastes their time.
  // A secret is never material to hand over: the person signs in themselves (2026-11-17 live walk: 「提供Engineering VPN 登录凭据 · 上传文件」).
  const needs = (Array.isArray(plan.needs) ? plan.needs : []).filter((need) => need && text(need.what).trim() && text(need.basis).trim() && !SECRET_MATERIAL.test(text(need.what)))
    .slice(0, MAX_NEEDS)
    .map((need, index) => ({ id: String(need.id || `n${index + 1}`).slice(0, 40), what: text(need.what).trim().slice(0, 80), why: text(need.why).trim().slice(0, 200),
      basis: text(need.basis).trim().slice(0, 200), kind: need.kind === "personal" ? "personal" as const : "reference" as const }));
  const needIds = new Set(needs.map((need) => need.id));
  for (const step of steps) step.uses = step.uses.filter((id) => needIds.has(id));
  const provides = needs.map((need, index) => ({ id: `provide${index + 1}`, role: "prepare" as StepRole, title: t("提供{{what}}", { what: need.what }).slice(0, 120),
    deliverable: need.what, doneCriterion: t("已上传，或说明没有"), share: 0,
    estimate: { p25Minutes: PROVIDE_MINUTES, p50Minutes: PROVIDE_MINUTES, p85Minutes: PROVIDE_MINUTES * 2 }, dependsOn: [] as string[],
    notBefore: "", dueBy: "", schedulable: false, executor: "human" as StepExecutor, tickOutcome: "", covers: [] as string[], why: need.why,
    aiAssist: { tool: "", how: "", minutesSaved: 0 }, firstAction: t("上传文件，或点「没有」"), owner: "person" as WorkOwner,
    product: "material" as StepProduct, uses: [] as string[], provides: need.id }));
  for (const provide of provides) idMap.set(provide.id, provide.id);
  for (const step of steps) for (const need of step.uses) {
    const provide = provides.find((item) => item.provides === need)!;
    if (!step.dependsOn.includes(provide.id)) step.dependsOn.push(provide.id);
  }
  steps.unshift(...provides);
  const questions: StepQuestion[] = drill.questions.filter((question) => question && question.text).map((question, index) => {
    const options = (Array.isArray(question.options) ? question.options : list(question.options)).map((option) => String(option).trim().slice(0, 80)).filter(Boolean).slice(0, 8);
    const assume = typeof question.assume === "string" ? question.assume.trim().slice(0, 80) : undefined;
    const neededBy = typeof question.neededBy === "string" && question.neededBy ? idMap.get(question.neededBy) : undefined;
    const cost = question.ifWrong;
    return { id: String(question.id || `q${index + 1}`).slice(0, 40), text: String(question.text).trim().slice(0, 200), why: String(question.why ?? "").trim().slice(0, 300), options,
      ...(assume !== undefined ? { assume: options.includes(assume) ? assume : options[0] ?? "" } : {}), ...(neededBy ? { neededBy } : {}),
      ...(typeof question.ask === "boolean" ? { ask: question.ask } : {}),
      ...(cost ? { ifWrong: { waste: Math.max(0, Math.round(Number(cost.waste) || 0)), harm: QUESTION_HARMS.includes(cost.harm) ? cost.harm : "none",
        fixable: QUESTION_FIXABLE.includes(cost.fixable) ? cost.fixable : "before_step" } } : {}) };
  });
  const reviews = assignStepOwners(steps, questions, warnings, { assistant, locale: options.locale, ...(options.ownerPreferences ? { ownerPreferences: options.ownerPreferences } : {}) });
  // Dependencies: known ids only, then any edge that closes a cycle is dropped (the latest-listed edge first).
  for (const step of steps) {
    const known = step.dependsOn.map((dep) => idMap.get(dep)).filter((dep): dep is string => Boolean(dep) && dep !== step.id);
    if (known.length !== step.dependsOn.length) warnings.push({ code: "STEP_DEPENDENCY_UNKNOWN", detail: `「${step.title}」依赖了不存在的步骤，已忽略` }); // i18n-ignore
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
        warnings.push({ code: "STEP_CYCLE_BROKEN", detail: `「${step.title}」与前置步骤成环，已断开一条依赖` }); // i18n-ignore
      }
    }
  }
  foldReviews(steps, reviews, warnings, options.locale);
  const total = steps.reduce((sum, step) => sum + step.share, 0);
  if (total <= 0) {
    const minutes = steps.reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
    for (const step of steps) step.share = step.estimate.p50Minutes / minutes;
    warnings.push({ code: "STEP_SHARE_MISSING", detail: "步骤没有进度份额，已按耗时分配" }); // i18n-ignore
  } else {
    if (Math.abs(total - 1) > 0.05) warnings.push({ code: "STEP_SHARE_NORMALIZED", detail: `进度份额合计 ${total.toFixed(2)}，已归一` }); // i18n-ignore
    for (const step of steps) step.share = step.share / total;
  }
  for (const step of steps) step.share = Math.round(step.share * 1000) / 1000;
  const amount = Number.isFinite(plan.quantity?.amount) ? Math.max(0, plan.quantity.amount) : 0;
  const units = (Array.isArray(plan.units) ? plan.units : []).filter((unit) => unit && unit.id && unit.title)
    .map((unit) => ({ id: String(unit.id).slice(0, 40), title: String(unit.title).trim().slice(0, 160), docId: String(unit.docId ?? ""), quote: String(unit.quote ?? "").slice(0, 300) })).slice(0, 60);
  const unitIds = new Set(units.map((unit) => unit.id));
  for (const step of steps) step.covers = step.covers.filter((id) => unitIds.has(id));
  // A drill form was cut and nothing on record says how the person works: ask them, first, instead of guessing a method.
  if (drill.changed && !options.methodKnown && !questions.some((question) => question.id === METHOD_QUESTION_ID))
    // Only the person knows how they work (§7.1): the planner's own wording of the question, with the neutral answer assumed meanwhile.
    { const method = methodQuestion(plan.methodQuestion, options.locale);
      questions.unshift({ ...method, assume: method.options[0] ?? "", ask: true, ifWrong: { waste: 0, harm: "quality", fixable: "before_step" } }); }
  return { plan: { archetypeId: plan.archetypeId, rationale: stripDrillSentences(text(plan.rationale).trim(), drill.backed).slice(0, 600),
    quantity: { basis: text(plan.quantity?.basis).slice(0, 60), amount, unit: text(plan.quantity?.unit).slice(0, 12) }, units,
    questions, needs, steps, ...(readModelFamiliarity(plan.familiarity) ? { familiarity: readModelFamiliarity(plan.familiarity)! } : {}) }, warnings };
}

/**
 * The drill forms the model wrote without the person's words behind them (`drill-forms.ts`, the owner's rule of 2026-11-10): cut from
 * every step's text, a step that is only the drill dropped, a question that asks about one dropped and its options without them.
 */
function screenStepDrills(plan: StepPlan, backing: readonly string[], warnings: StepWarning[]) {
  const backed = backedDrillForms(backing);
  const raw = plan.steps.map((step) => ({ ...step, dependsOn: list(step.dependsOn) }));
  const { items: steps, stripped, dropped } = screenDrillItems(raw, backed, ["deliverable", "doneCriterion", "firstAction", "tickOutcome"]);
  const asked = (Array.isArray(plan.questions) ? plan.questions : []);
  const questions = asked.filter((question) => !question?.text || !drillFormsIn(String(question.text)).some((form) => !backed.has(form)))
    .map((question) => question && Array.isArray(question.options)
      ? { ...question, options: question.options.filter((option) => !drillFormsIn(String(option)).some((form) => !backed.has(form))) } : question);
  // i18n-ignore-start: warnings for the reviewer model
  if (stripped.length) warnings.push({ code: "STEP_DRILL_FORM_STRIPPED", detail: `「${stripped.join("」「")}」里的订正、错题、背诵、打卡一类做法本人没说过，已去掉` });
  if (dropped.length) warnings.push({ code: "STEP_DRILL_FORM_DROPPED", detail: `「${dropped.join("」「")}」只是一种本人没说过的练习形式，已删去` });
  // i18n-ignore-end
  return { steps, questions, backed, changed: stripped.length + dropped.length + (asked.length - questions.length) > 0 };
}

/**
 * Who does each step (docs/work-split.md): the person only for their own growth and core work. What the assistant can make from the
 * material is its step, and it never takes time on the person's calendar; what needs one fact only the person holds is a question plus the
 * assistant's step; reviewing the assistant's output is returned (the ids) to be folded into the first core step (`foldReviewSteps`).
 * Shared by `normalizeStepPlan` and the one-time reorganisation of plans already stored (`apps/worker/src/work-split-repair.ts`).
 */

/** The model's `external` on a step, when it gave one (a plan stored before the field has none: the word list reads its title). */
const externalOfStep = (step: { external?: boolean }) => typeof step.external === "boolean" ? { external: step.external } : {};

export function assignStepOwners(steps: PlannedStep[], questions: StepQuestion[], warnings: StepWarning[],
  options: { assistant?: boolean;
    /** Steps (of a stored plan being judged again) that come right after, or wait on, the assistant's already-finished work. */
    afterAgent?: ReadonlySet<string>;
    /** `role|product` → the owner the person chose for that kind of step (4A); never over what only the person may do. */
    ownerPreferences?: ReadonlyMap<string, "person" | "assistant">;
    /** The language of the questions written here (stored and shown to the person). */
    locale?: Locale | undefined } = {}): Set<string> {
  const t = tFor(options.locale);
  const assistant = options.assistant !== false;
  const reviews = new Set<string>();
  // A step the model made a question (`owner: ask`) carries the model's question (`neededBy` it); a plain one only when it wrote none.
  const askFor = (step: PlannedStep) => {
    if (questions.some((item) => item.neededBy === step.id)) return;
    const question = t("「{{title}}」需本人提供哪些信息？", { title: step.title });
    if (!questions.some((item) => item.text === question))
      questions.push({ id: `q${questions.length + 1}`, text: question, why: t("「{{title}}」需要本人持有的信息，答完由助手接着做", { title: step.title }), options: [],
        ask: true, neededBy: step.id, ifWrong: { waste: 0, harm: "quality", fixable: "before_step" } });
  };
  for (const step of steps) {
    if (!assistant) {
      if (step.executor === "agent") {
        step.executor = "human";
        step.schedulable = step.role !== "wait";
        warnings.push({ code: "STEP_NO_ASSISTANT", detail: `「${step.title}」改由本人完成：这个账号没有助手` }); // i18n-ignore: a warning for the log and the reviewer
      }
      step.owner = "person";
      if (step.role === "wait") step.firstAction = "";
      continue;
    }
    // Handing over material only the person has: theirs, an upload rather than work.
    if (step.provides) { step.executor = "human"; step.owner = "person"; step.schedulable = false; continue; }
    if (step.role !== "wait" && step.product) {
      const product = productOf(step.role, step.product);
      step.product = product;
      // The model names the step's product (and with it the owner, `PRODUCT_OWNER`) and may turn the assistant's material into a
      // question (`owner: ask`). Code keeps one floor: an act that leaves the machine is the person's (`workOwner`, 2026-11-22).
      const verdict = workOwner({ title: step.title, owner: "assistant", ...externalOfStep(step) }, options.locale);
      const forced = verdict.code === "external";
      // A check (the model's role) right after the assistant's work only looks it over: folded into the next core step. Since 2026-11-22 by
      // the role the plan gave it, no longer by the title's verb (验收, 批准, 核验 …) and a list of words that meant a judgement.
      if (!forced && step.executor !== "agent" && step.role === "check" && product !== "ability"
        && (step.dependsOn.some((dep) => steps.find((other) => other.id === dep)?.executor === "agent")
          || steps[steps.indexOf(step) - 1]?.executor === "agent" || options.afterAgent?.has(step.id))) { reviews.add(step.id); continue; }
      const preferred = options.ownerPreferences?.get(`${step.role}|${product}`);
      const table = PRODUCT_OWNER[product];
      const owner: WorkOwner = forced || step.role === "decide" ? "person" : preferred ?? (table === "assistant" && step.owner === "ask" ? "ask" : table);
      const was = step.executor;
      step.executor = owner === "person" ? (was === "agent" ? "human" : was) : "agent";
      if (owner === "person" && was === "agent") {
        step.schedulable = true;
        warnings.push({ code: "STEP_OWNER_PERSON", detail: `「${step.title}」改由本人完成：${forced ? verdict.reason : preferred ? "本人选择这类步骤自己做" : `产出是${STEP_PRODUCTS[product]}`}` }); // i18n-ignore: a warning for the log and the reviewer
      } else if (owner !== "person" && was !== "agent") warnings.push({ code: owner === "ask" ? "STEP_OWNER_ASK" : "STEP_TRIVIAL_TO_AGENT",
        detail: `「${step.title}」${owner === "ask" ? "改为问本人一句后由助手完成" : preferred ? "按本人的选择交给助手" : "产出是材料，改由助手完成"}` }); // i18n-ignore
      if (owner === "ask") askFor(step);
      step.owner = owner;
    } else if (step.role !== "wait") {
      // `executor: "agent"` is the model's word that the assistant does it, whatever `owner` it also wrote; `ask` stays a question.
      const verdict = workOwner({ title: step.title, owner: step.executor === "agent" && step.owner !== "ask" ? "assistant" : step.owner ?? "person",
        ...externalOfStep(step) }, options.locale);
      // Approving what the assistant just made (「验收定义稿」「批准可交付版本」「核验版本基线包」): the step before it, or one it waits on,
      // is the assistant's, and the step only checks that output. The real account kept a dozen of these after the first rule, which
      // asked for 「助手」 in the title; a judgement (结论, 边界, 权限), a decision or graded work is not folded.
      // A step the plan itself calls a decision is the person's, whatever its verb (「批准首轮试用候选人」 went to the assistant on 10-22).
      if (step.role === "decide") {
        if (step.executor === "agent") { step.executor = "human"; step.schedulable = true;
          warnings.push({ code: "STEP_OWNER_PERSON", detail: `「${step.title}」改由本人完成：有后果的选择由本人做` }); } // i18n-ignore: a warning for the log and the reviewer
        step.owner = "person";
        continue;
      }
      if (step.executor !== "agent" && step.role === "check" && verdict.code === "model"
        && (step.dependsOn.some((dep) => steps.find((other) => other.id === dep)?.executor === "agent")
          || steps[steps.indexOf(step) - 1]?.executor === "agent" || options.afterAgent?.has(step.id))) {
        reviews.add(step.id);
        continue;
      }
      // The older, narrower rule still holds where the new one has nothing to say; so does the plan's own role: a step it calls
      // gathering (「汇集候选人联系底稿」「取得小测3正式范围」) is the assistant's unless something about it is the person's.
      // A step the plan itself calls gathering is the assistant's unless something about it is the person's. The title list that used to
      // hand 「整理…」「收集…」 to the assistant by its verb is gone (2026-11-20): the model names the step's product and owner.
      const owner = verdict.code === "model" && verdict.owner === "person" && step.role === "gather" ? "assistant" : verdict.owner;
      if (owner === "person" && step.executor === "agent") {
        step.executor = "human";
        step.schedulable = true;
        warnings.push({ code: "STEP_OWNER_PERSON", detail: `「${step.title}」改由本人完成：${verdict.reason}` }); // i18n-ignore: a warning for the log and the reviewer
      } else if (owner === "assistant" && step.executor !== "agent") {
        step.executor = "agent";
        warnings.push({ code: "STEP_TRIVIAL_TO_AGENT", detail: `「${step.title}」是准备工作，改由助手完成` }); // i18n-ignore: a warning for the log and the reviewer
      } else if (owner === "ask") {
        step.executor = "agent";
        askFor(step);
        warnings.push({ code: "STEP_OWNER_ASK", detail: `「${step.title}」改为问本人一句后由助手完成` }); // i18n-ignore: a warning for the log and the reviewer
      }
      step.owner = step.executor === "agent" ? (owner === "ask" ? "ask" : "assistant") : "person";
    } else step.owner = "person";
    if (step.executor === "agent") step.schedulable = false;
    // Attending an event happens at the event's own time, never in free hours (W-274: 「参加 ECE 555 小测」 was placed as six work
    // blocks). The step stays; preparing for it is work. The model's `attends`, no longer the title's verb (2026-11-22).
    if (step.attends) step.schedulable = false;
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
export function resplitOpenSteps(open: readonly StoredStepLike[], questions: readonly StepQuestion[],
  /** The whole plan in its order (finished steps too), so a step approving what the assistant already made is still recognised. */
  plan: readonly Pick<StoredStepLike, "id" | "executor" | "dependsOn">[] = open, locale?: Locale):
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
  const reviews = assignStepOwners(steps, asked, warnings, { afterAgent, locale });
  const reviewed = steps.filter((step) => reviews.has(step.id)).map((step) => ({ id: step.id, title: step.title, executor: step.executor }));
  foldReviewSteps(steps, reviews, warnings, locale);
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
export const foldReviewSteps = (steps: PlannedStep[], reviews: ReadonlySet<string>, warnings: StepWarning[], locale?: Locale): void =>
  foldReviews(steps, reviews, warnings, locale);

/** How long a glance at the assistant's output takes inside the first core step (docs/work-split.md §3). */
export const REVIEW_GLANCE_MINUTES = 10;

/**
 * A person's step that only reviews the assistant's output (or writes an acceptance checklist) is not a step: the acceptance gate judges
 * the assistant's work, and the person glances at it when the core step that uses it begins. The glance becomes the start of that step's
 * `firstAction` and at most ten minutes of its estimate; the review step is removed, its dependants take its dependencies, and the ids are
 * numbered again. A review with no person's step to fold into is left to the assistant.
 */
function foldReviews(steps: PlannedStep[], reviews: ReadonlySet<string>, warnings: StepWarning[], locale?: Locale) {
  if (!reviews.size) return;
  const t = tFor(locale);
  const person = (step: PlannedStep) => !reviews.has(step.id) && step.executor !== "agent" && step.role !== "wait";
  for (const id of [...reviews]) {
    const index = steps.findIndex((step) => step.id === id);
    const review = steps[index]!;
    // Only a step that comes after: folding a final check into an earlier draft (seen on the real account) reads backwards; with none
    // after it, the check is the acceptance gate's.
    const target = steps.find((step) => person(step) && step.dependsOn.includes(id)) ?? steps.slice(index + 1).find(person);
    if (!target) {
      review.executor = "agent"; review.owner = "assistant"; review.schedulable = false; review.firstAction = "";
      warnings.push({ code: "STEP_TRIVIAL_TO_AGENT", detail: `「${review.title}」只是验收，交给验收关卡` }); // i18n-ignore: a warning for the log and the reviewer
      continue;
    }
    const source = steps.find((step) => review.dependsOn.includes(step.id) && step.executor === "agent");
    const glance = source ? t("先用 {{minutes}} 分钟扫一眼「{{title}}」的产出；", { minutes: REVIEW_GLANCE_MINUTES, title: source.title.slice(0, 16) })
      : t("先用 {{minutes}} 分钟扫一眼助手备好的材料；", { minutes: REVIEW_GLANCE_MINUTES });
    target.firstAction = `${glance}${target.firstAction ?? ""}`.slice(0, FIRST_ACTION_MAX);
    const added = Math.min(REVIEW_GLANCE_MINUTES, review.estimate.p50Minutes);
    target.estimate = { p25Minutes: target.estimate.p25Minutes + added, p50Minutes: target.estimate.p50Minutes + added, p85Minutes: target.estimate.p85Minutes + added };
    target.share += review.share;
    for (const step of steps) if (step.dependsOn.includes(id))
      step.dependsOn = [...new Set([...step.dependsOn.filter((dep) => dep !== id), ...review.dependsOn])].filter((dep) => dep !== step.id);
    steps.splice(index, 1);
    warnings.push({ code: "STEP_REVIEW_FOLDED", detail: `「${review.title}」不单列为步骤：并入「${target.title}」开始时的 ${REVIEW_GLANCE_MINUTES} 分钟` }); // i18n-ignore: a warning for the log and the reviewer
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
  for (const step of plan.steps) {
    // A request for a fact is a quarter of an hour by design (info-request.ts), not a step too short to schedule.
    if (step.schedulable && step.estimate.p50Minutes < 15 && !(step.estimate.p50Minutes <= INFO_REQUEST_PERSON_MINUTES && step.role === "contact")) warnings.push({ code: "STEP_TOO_SHORT", detail: `「${step.title}」只有 ${step.estimate.p50Minutes} 分钟，不足一个工作时段` }); // i18n-ignore
    if (!step.doneCriterion) warnings.push({ code: "STEP_DONE_CRITERION_MISSING", detail: `「${step.title}」没有完成标准` }); // i18n-ignore
  }
  // The archetype's required roles, its order (「先解后查」) and its usual last step are no longer warnings (2026-11-20, near-term doc §3.3):
  // the person's work is one step per deliverable with 提交 folded into its done criterion, so 「完成作业 4」 alone is a whole plan. The
  // archetypes still describe the usual parts to the model (`archetypeBrief`), as guidance. A step whose role is outside the archetype's
  // usual list is not a warning either (2026-11-22): the eighteen archetypes are non-binding hints, and a role the
  // work needs is the planner's to choose. They still pick the sizing (`quantify`) and the tutorial's parts.
  const p50 = plan.steps.filter((step) => step.schedulable).reduce((sum, step) => sum + step.estimate.p50Minutes, 0);
  if (plan.quantity.amount > 0) {
    const [low, high] = archetype.quantify.minutesPerUnit;
    if (p50 < plan.quantity.amount * low * 0.5 || p50 > plan.quantity.amount * high * 1.5)
      warnings.push({ code: "STEP_TOTAL_OFF_QUANTITY", detail: `合计 ${p50} 分钟，按 ${plan.quantity.amount}${plan.quantity.unit} 估算应在 ${plan.quantity.amount * low}–${plan.quantity.amount * high} 分钟` }); // i18n-ignore
  }
  if (window.availableMinutes !== undefined && p50 > window.availableMinutes)
    warnings.push({ code: "STEP_WINDOW_TOO_SMALL", detail: `合计 ${p50} 分钟，可用时段只有 ${window.availableMinutes} 分钟` }); // i18n-ignore
  for (const step of plan.steps) {
    if (window.dueBy && step.dueBy && step.dueBy > window.dueBy) warnings.push({ code: "STEP_AFTER_DUE", detail: `「${step.title}」晚于截止日` }); // i18n-ignore
    if (window.notBefore && step.notBefore && step.notBefore < window.notBefore) warnings.push({ code: "STEP_BEFORE_RELEASE", detail: `「${step.title}」早于开始日` }); // i18n-ignore
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
