/**
 * The goal backplanner's wire contract: steps worked backwards from an approved milestone. It lives here,
 * next to every other Skill's schema, so `structured-output.test.ts` holds it to the strict-mode rules by
 * discovery — it used to sit in the worker, where nothing checked it.
 *
 * `family` is required for the same reason analysis returns one: a backplanned order without it never
 * produced a duration observation, so it could not teach the estimate anything.
 */
export type BackplanStep = { id: string; intent: string; sourceQuote: string; rationale: string; dependsOn: string[];
  estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  energy: "low" | "medium" | "high"; interruptible: boolean;
  family: "preparation" | "review" | "deep_work";
  riskTier: "routine" | "milestone" | "high_risk"; evidence: string };
export type BackplanAnswer = { steps: BackplanStep[]; dateCandidates: Array<{ date: string; quote: string }>;
  blockers: Array<{ code: string; message: string }> };
const str = { type: "string" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
export const BACKPLAN_SCHEMA = object({ steps: { type: "array", items: object({
  id: str, intent: str, sourceQuote: str, rationale: str,
  dependsOn: { type: "array", items: str },
  estimate: object({ p25Minutes: { type: "number" }, p50Minutes: { type: "number" }, p85Minutes: { type: "number" } }),
  energy: { type: "string", enum: ["low", "medium", "high"] }, interruptible: { type: "boolean" },
  family: { type: "string", enum: ["preparation", "review", "deep_work"] },
  riskTier: { type: "string", enum: ["routine", "milestone", "high_risk"] }, evidence: str
}) }, dateCandidates: { type: "array", items: object({ date: str, quote: str }) },
  blockers: { type: "array", items: object({ code: str, message: str }) } });

export function validateBackplan(value: unknown, sources: string[], dateSources = sources): BackplanAnswer {
  const answer = value as BackplanAnswer | undefined;
  if (!answer || !Array.isArray(answer.steps) || !Array.isArray(answer.dateCandidates)
    || !Array.isArray(answer.blockers) || answer.steps.length > 20
    || answer.dateCandidates.length > 5 || answer.blockers.length > 10) throw new Error("BACKPLAN_SCHEMA_INVALID");
  if (answer.blockers.length) {
    const error = new Error("BACKPLAN_INPUT_BLOCKED");
    (error as Error & { detail?: string }).detail = answer.blockers.map((item) => item.message.trim())
      .filter(Boolean).join("；").slice(0, 400);
    throw error;
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
    seen.add(step.id);
  }
  return answer;
}
