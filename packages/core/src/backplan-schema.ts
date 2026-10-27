/**
 * The goal backplanner's wire contract: steps worked backwards from an approved milestone. It lives here,
 * next to every other Skill's schema, so `structured-output.test.ts` holds it to the strict-mode rules by
 * discovery — it used to sit in the worker, where nothing checked it.
 *
 * `family` is required for the same reason analysis returns one: a backplanned order without it never
 * produced a duration observation, so it could not teach the estimate anything.
 *
 * A blocker names **what** is missing and **who has it**: the first real refusal (「未提供实测 MoS₂ 参数数据…；未提供目标
 * NeuroSim 版本…」) was one joined sentence, which could be logged but not asked about. With the two fields the worker
 * can ask the person about each missing thing, and re-run in the mode where a missing input becomes the first step
 * (`acquires` names which missing input a step obtains; "" for an ordinary step).
 */
import { TASK_MINUTES } from "./steps";
import { cleanTaskTitle } from "./task-title";
import { COMPLETION_FIELD, readModelCompletion, type ModelCompletion } from "./completion";
import { tFor, type Locale } from "./i18n";
import { textWidth } from "./text-width";
import { isWorkOwner, workOwner, WORK_OWNERS, type WorkOwner, type WorkOwnerCode } from "./work-owner";
export type BackplanStep = { id: string; title: string; intent: string; sourceQuote: string; rationale: string; dependsOn: string[];
  estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  energy: "low" | "medium" | "high"; interruptible: boolean;
  family: "preparation" | "review" | "deep_work";
  riskTier: "routine" | "milestone" | "high_risk"; evidence: string;
  /** The id of the missing input this step obtains or confirms, "" when it is an ordinary step. */
  acquires: string;
  /** The artifact (another line is promised it) this task's deliverable is, "" when none (docs/flywheel-and-views.md §5.5). */
  produces: string;
  /** Other lines' artifacts this task works with; it is scheduled after the task producing each, and handed its files. */
  uses: string[];
  /** How finishing it is taken (`completion.ts`). Optional for answers recorded before it; the schema requires it. */
  completion?: ModelCompletion;
  /** The open task (an `existingTasks` id) this item only adds to, "" when it is new work: it is folded into that task, not created. */
  extendsTaskId?: string;
  /**
   * Who does it (`work-owner.ts`, docs/work-split.md): the person's core task, the assistant's preparation for one, or a question to the
   * person after which the assistant does it. Optional for answers recorded before it; the schema requires it.
   */
  owner?: WorkOwner;
  /** For the assistant's items and the questions: the id of the person's core item this prepares, "" when none. */
  prepares?: string;
  /** For `ask`: the one question to the person (at most two facts, ten minutes of theirs), "" otherwise. */
  question?: string };
/** The cross-line artifacts a milestone's tasks produce and use: from its anchor's `outputs`/`inputs`, less what existing work covers. */
export type BackplanArtifacts = { produce: string[]; use: string[] };
export type BackplanBlocker = { code: string; message: string; what: string; whoHas: string };
/** Something a milestone's steps need that the system does not have: data, a specification, someone's decision. */
export type MissingInput = { id: string; what: string; whoHas: string; message: string };

/**
 * The missing inputs a `goal.backplan_blocked` event records. Older events carry only the joined message, so
 * each of its sentences (the model wrote one per missing thing, joined with 「；」) becomes one input.
 */
export function missingInputsOf(payload: unknown): MissingInput[] {
  const value = payload as { missing?: MissingInput[]; message?: string; code?: string } | undefined;
  if (Array.isArray(value?.missing) && value.missing.length) return value.missing;
  if (value?.code !== "BACKPLAN_INPUT_BLOCKED") return [];
  return String(value?.message ?? "").split("；").map((part) => part.trim()).filter(Boolean)
    .map((message, index) => ({ id: `m${index + 1}`, what: message.slice(0, 120), whoHas: "", message }));
}
export type BackplanAnswer = { steps: BackplanStep[]; dateCandidates: Array<{ date: string; quote: string }>;
  blockers: BackplanBlocker[] };
const str = { type: "string" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
export const BACKPLAN_SCHEMA = object({ steps: { type: "array", items: object({
  id: str, title: str, intent: str, sourceQuote: str, rationale: str,
  dependsOn: { type: "array", items: str },
  estimate: object({ p25Minutes: { type: "number" }, p50Minutes: { type: "number" }, p85Minutes: { type: "number" } }),
  energy: { type: "string", enum: ["low", "medium", "high"] }, interruptible: { type: "boolean" },
  family: { type: "string", enum: ["preparation", "review", "deep_work"] },
  riskTier: { type: "string", enum: ["routine", "milestone", "high_risk"] }, evidence: str, acquires: str,
  produces: str, uses: { type: "array", items: str }, completion: COMPLETION_FIELD, extendsTaskId: str,
  owner: { type: "string", enum: [...WORK_OWNERS] }, prepares: str, question: str
}) }, dateCandidates: { type: "array", items: object({ date: str, quote: str }) },
  blockers: { type: "array", items: object({ code: str, message: str, what: str, whoHas: str }) } });

/**
 * `missingIds`: the ids of the missing inputs given to an assumptive run — a step may say it `acquires` one of them.
 * Outside that mode no step may claim to acquire anything. Blockers are returned, not thrown: the caller decides
 * whether they stop the run (they do not in the assumptive mode, where they are more things to ask about).
 */
export function validateBackplan(value: unknown, sources: string[], dateSources = sources, missingIds: string[] = [],
  artifacts: BackplanArtifacts = { produce: [], use: [] }, existingIds: readonly string[] = [],
  /** `requireCore: false` keeps an answer with no core task of the person's (the runner's fallback after the repairs). */
  options: { requireCore?: boolean } = {}): BackplanAnswer {
  const answer = value as BackplanAnswer | undefined;
  if (!answer || !Array.isArray(answer.steps) || !Array.isArray(answer.dateCandidates)
    || !Array.isArray(answer.blockers) || answer.steps.length > 20
    || answer.dateCandidates.length > 5 || answer.blockers.length > 10) throw new Error("BACKPLAN_SCHEMA_INVALID");
  for (const blocker of answer.blockers) {
    if (!blocker || typeof blocker.message !== "string" || !blocker.message.trim() || typeof blocker.what !== "string"
      || !blocker.what.trim() || textWidth(blocker.what) > 120 || typeof blocker.whoHas !== "string" || textWidth(blocker.whoHas) > 60)
      throw new Error("BACKPLAN_BLOCKER_INVALID");
  }
  for (const candidate of answer.dateCandidates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)
      || !Number.isFinite(Date.parse(`${candidate.date}T00:00:00Z`))
      || new Date(`${candidate.date}T00:00:00Z`).toISOString().slice(0, 10) !== candidate.date
      || !candidate.quote?.trim() || !dateSources.some((source) => source.includes(candidate.quote)))
      throw new Error("BACKPLAN_DATE_SOURCE_INVALID");
  }
  const seen = new Set<string>();
  for (const step of answer.steps) {
    if (!step || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) || seen.has(step.id)
      || !step.intent?.trim() || textWidth(step.intent) > 200 || !step.rationale?.trim()
      || !step.evidence?.trim() || !step.sourceQuote?.trim()
      || !sources.some((source) => source.includes(step.sourceQuote))) throw new Error("BACKPLAN_SOURCE_INVALID");
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some((id) => !seen.has(id)))
      throw new Error("BACKPLAN_DEPENDENCY_INVALID");
    // The task's name (a short action from its verb); an answer recorded before names existed gets the first clause of its intent.
    step.title = cleanTaskTitle(typeof step.title === "string" ? step.title : "") || cleanTaskTitle(step.intent);
    const { p25Minutes, p50Minutes, p85Minutes } = step.estimate ?? {};
    if (![p25Minutes, p50Minutes, p85Minutes].every((minutes) => Number.isFinite(minutes) && minutes > 0 && minutes <= 10080)
      || p25Minutes > p50Minutes || p50Minutes > p85Minutes) throw new Error("BACKPLAN_ESTIMATE_INVALID");
    // A task is 30 minutes to 8 hours of usual work. The detail names the task, so a repair can split or merge exactly that one.
    if (p50Minutes < TASK_MINUTES.min || p50Minutes > TASK_MINUTES.max)
      throw new Error(`BACKPLAN_TASK_SIZE: ${step.id} 的 p50 为 ${p50Minutes} 分钟；任务的通常时长须在 ${TASK_MINUTES.min}–${TASK_MINUTES.max} 分钟之间，超过的拆成多个任务，不足的并入相邻任务`); // i18n-ignore
    if (!["low", "medium", "high"].includes(step.energy)
      || !["routine", "milestone", "high_risk"].includes(step.riskTier)
      || !["preparation", "review", "deep_work"].includes(step.family)
      || typeof step.interruptible !== "boolean") throw new Error("BACKPLAN_SCHEMA_INVALID");
    if (typeof step.acquires !== "string" || (step.acquires && !missingIds.includes(step.acquires)))
      throw new Error("BACKPLAN_ACQUIRES_INVALID");
    // Answers recorded before artifacts existed carry neither field: they produce and use nothing.
    step.produces = typeof step.produces === "string" ? step.produces.trim() : "";
    step.uses = Array.isArray(step.uses) ? step.uses.filter((id): id is string => typeof id === "string" && Boolean(id.trim())) : [];
    if (step.produces && !artifacts.produce.includes(step.produces))
      throw new Error(`BACKPLAN_ARTIFACT_UNKNOWN: ${step.id} 的 produces「${step.produces}」不在 artifacts.produce 里；可选：${artifacts.produce.join("、") || "（无）"}`); // i18n-ignore
    const unknown = step.uses.find((id) => !artifacts.use.includes(id));
    if (unknown) throw new Error(`BACKPLAN_ARTIFACT_UNKNOWN: ${step.id} 的 uses「${unknown}」不在 artifacts.use 里；可选：${artifacts.use.join("、") || "（无）"}`); // i18n-ignore
    // An answer recorded before these existed has neither; an id that was not offered is new work (the code-level check still runs).
    const completion = readModelCompletion(step.completion);
    if (completion) step.completion = completion; else delete step.completion;
    step.extendsTaskId = typeof step.extendsTaskId === "string" && existingIds.includes(step.extendsTaskId.trim()) ? step.extendsTaskId.trim() : "";
    // An answer recorded before owners existed: every item was the person's.
    step.owner = isWorkOwner(step.owner) ? step.owner : "person";
    step.prepares = typeof step.prepares === "string" ? step.prepares.trim() : "";
    step.question = typeof step.question === "string" ? step.question.trim().slice(0, 200) : "";
    seen.add(step.id);
  }
  // The person's core work comes first (docs/work-split.md §3): an answer that is all preparation is sent back to name it.
  if (options.requireCore !== false && answer.steps.length && !answer.steps.some((step) => workOwner(step).owner === "person"))
    // i18n-ignore-start: a repair message to the backplanner
    throw new Error(`BACKPLAN_NO_PERSON_CORE: 没有一项是本人的核心工作（${answer.steps.map((step) => `${step.id}「${step.title}」`).join("、")}都可由助手做或只需问本人一句）。`
      + "先写出推动这个里程碑结果的本人核心任务（以本人的产出命名：练习、写出、设计、判断、交出），再把准备写成 owner 为 assistant、prepares 指向它的前置。");
    // i18n-ignore-end
  for (const id of artifacts.produce) {
    const producers = answer.steps.filter((step) => step.produces === id).length;
    if (producers !== 1) throw new Error(`BACKPLAN_ARTIFACT_UNPRODUCED: 产物「${id}」要由且只由一个任务产出（produces 设为它），现在是 ${producers} 个`); // i18n-ignore
  }
  for (const id of artifacts.use) {
    if (!answer.steps.some((step) => step.uses.includes(id))) throw new Error(`BACKPLAN_ARTIFACT_UNUSED: 其他主线的产物「${id}」至少要被一个任务用到（uses 里列出它）`); // i18n-ignore
  }
  return answer;
}

/** A backplan item once its owner is settled: who does it, why, and for the assistant's and the questions the core item it prepares. */
export type OwnedBackplanStep<T extends BackplanStep = BackplanStep> = T & { owner: WorkOwner; ownerCode: WorkOwnerCode; ownerReason: string;
  prepares: string; question: string };

/**
 * Settles who does each item (docs/work-split.md §2–3): `workOwner` corrects the model's owner; an item that only reviews the assistant's
 * output or writes an acceptance checklist is dropped (the gate judges the assistant's work, and the person glances at it when the core
 * task begins), its dependants taking its dependencies; the assistant's preparation and the questions point at the person's core item
 * they serve (`prepares`: the model's choice when it names a person's item, else the first person's item that waits on it, else the next
 * one in order). An assistant item that ended up holding a request for a fact (`infoRequests`, folded in by `foldInfoRequests`) is a
 * question: the person gets the answer from someone and passes it on.
 */
export function assignBackplanOwners<T extends BackplanStep & { infoRequests?: Array<{ what: string; who: string }> }>(input: readonly T[], locale?: Locale):
  { steps: Array<OwnedBackplanStep<T>>; dropped: Array<{ id: string; title: string; reason: string }> } {
  const t = tFor(locale);
  const dropped: Array<{ id: string; title: string; reason: string }> = [];
  let steps = input.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  const verdicts = new Map(steps.map((step) => [step.id, workOwner(step, locale)]));
  for (const step of [...steps]) {
    const verdict = verdicts.get(step.id)!;
    if (verdict.code !== "review_only") continue;
    steps = steps.filter((item) => item.id !== step.id);
    for (const other of steps) if (other.dependsOn.includes(step.id))
      other.dependsOn = [...new Set([...other.dependsOn.filter((id) => id !== step.id), ...step.dependsOn])];
    dropped.push({ id: step.id, title: step.title, reason: verdict.reason });
  }
  const owned = steps.map((step): OwnedBackplanStep<T> => {
    const verdict = verdicts.get(step.id)!;
    const request = verdict.owner === "assistant" ? step.infoRequests?.[0] : undefined;
    if (request) return { ...step, owner: "ask", ownerCode: "needs_person_info", ownerReason: t("先要向别人问到一件事，再由助手做"),
      question: (request.who ? t("{{what}}（需向{{who}}确认）", { what: request.what, who: request.who }) : request.what).slice(0, 200), prepares: step.prepares ?? "" };
    return { ...step, owner: verdict.owner, ownerCode: verdict.code, ownerReason: verdict.reason,
      question: verdict.owner === "ask" ? (step.question?.trim() || verdict.question || "") : "", prepares: step.prepares ?? "" };
  });
  const person = new Set(owned.filter((step) => step.owner === "person").map((step) => step.id));
  const waitsOn = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    const step = owned.find((item) => item.id === from);
    return Boolean(step?.dependsOn.some((dep) => dep === target || waitsOn(dep, target, seen)));
  };
  for (const [index, step] of owned.entries()) {
    if (step.owner === "person") { step.prepares = ""; continue; }
    if (person.has(step.prepares)) continue;
    step.prepares = owned.find((item) => person.has(item.id) && waitsOn(item.id, step.id))?.id
      ?? owned.slice(index + 1).find((item) => person.has(item.id))?.id ?? owned.find((item) => person.has(item.id))?.id ?? "";
  }
  return { steps: owned, dropped };
}

/**
 * What a rolling backplan keeps (docs/work-split.md §3): the person's next core task — the first in dependency order — with what it
 * waits on and the assistant's preparation and questions for it. An answer with no core task of the person's keeps its first `fallback`
 * items, as rolling did before owners.
 */
export function rollingBackplan<T extends { id: string; dependsOn: string[]; owner: WorkOwner; prepares: string }>(steps: readonly T[], fallback = 2): T[] {
  const core = steps.find((step) => step.owner === "person");
  if (!core) return steps.slice(0, fallback);
  const keep = new Set<string>([core.id]);
  const add = (id: string) => {
    if (keep.has(id)) return;
    keep.add(id);
    for (const dep of steps.find((step) => step.id === id)?.dependsOn ?? []) add(dep);
  };
  for (const dep of core.dependsOn) add(dep);
  for (const step of steps) if (step.owner !== "person" && step.prepares === core.id) add(step.id);
  return steps.filter((step) => keep.has(step.id));
}
