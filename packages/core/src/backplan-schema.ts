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
export type BackplanStep = { id: string; intent: string; sourceQuote: string; rationale: string; dependsOn: string[];
  estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  energy: "low" | "medium" | "high"; interruptible: boolean;
  family: "preparation" | "review" | "deep_work";
  riskTier: "routine" | "milestone" | "high_risk"; evidence: string;
  /** The id of the missing input this step obtains or confirms, "" when it is an ordinary step. */
  acquires: string };
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
  id: str, intent: str, sourceQuote: str, rationale: str,
  dependsOn: { type: "array", items: str },
  estimate: object({ p25Minutes: { type: "number" }, p50Minutes: { type: "number" }, p85Minutes: { type: "number" } }),
  energy: { type: "string", enum: ["low", "medium", "high"] }, interruptible: { type: "boolean" },
  family: { type: "string", enum: ["preparation", "review", "deep_work"] },
  riskTier: { type: "string", enum: ["routine", "milestone", "high_risk"] }, evidence: str, acquires: str
}) }, dateCandidates: { type: "array", items: object({ date: str, quote: str }) },
  blockers: { type: "array", items: object({ code: str, message: str, what: str, whoHas: str }) } });

/**
 * `missingIds`: the ids of the missing inputs given to an assumptive run — a step may say it `acquires` one of them.
 * Outside that mode no step may claim to acquire anything. Blockers are returned, not thrown: the caller decides
 * whether they stop the run (they do not in the assumptive mode, where they are more things to ask about).
 */
export function validateBackplan(value: unknown, sources: string[], dateSources = sources, missingIds: string[] = []): BackplanAnswer {
  const answer = value as BackplanAnswer | undefined;
  if (!answer || !Array.isArray(answer.steps) || !Array.isArray(answer.dateCandidates)
    || !Array.isArray(answer.blockers) || answer.steps.length > 20
    || answer.dateCandidates.length > 5 || answer.blockers.length > 10) throw new Error("BACKPLAN_SCHEMA_INVALID");
  for (const blocker of answer.blockers) {
    if (!blocker || typeof blocker.message !== "string" || !blocker.message.trim() || typeof blocker.what !== "string"
      || !blocker.what.trim() || blocker.what.length > 120 || typeof blocker.whoHas !== "string" || blocker.whoHas.length > 60)
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
      || !step.intent?.trim() || step.intent.length > 200 || !step.rationale?.trim()
      || !step.evidence?.trim() || !step.sourceQuote?.trim()
      || !sources.some((source) => source.includes(step.sourceQuote))) throw new Error("BACKPLAN_SOURCE_INVALID");
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some((id) => !seen.has(id)))
      throw new Error("BACKPLAN_DEPENDENCY_INVALID");
    const { p25Minutes, p50Minutes, p85Minutes } = step.estimate ?? {};
    if (![p25Minutes, p50Minutes, p85Minutes].every((minutes) => Number.isFinite(minutes) && minutes > 0 && minutes <= 10080)
      || p25Minutes > p50Minutes || p50Minutes > p85Minutes) throw new Error("BACKPLAN_ESTIMATE_INVALID");
    if (!["low", "medium", "high"].includes(step.energy)
      || !["routine", "milestone", "high_risk"].includes(step.riskTier)
      || !["preparation", "review", "deep_work"].includes(step.family)
      || typeof step.interruptible !== "boolean") throw new Error("BACKPLAN_SCHEMA_INVALID");
    if (typeof step.acquires !== "string" || (step.acquires && !missingIds.includes(step.acquires)))
      throw new Error("BACKPLAN_ACQUIRES_INVALID");
    seen.add(step.id);
  }
  return answer;
}
