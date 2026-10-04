import { randomUUID } from "node:crypto";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

const OWNER_ID = "local-owner";
const SKILL = "crossline:crossline-goal-backplanner";
type Step = { id: string; intent: string; sourceQuote: string; rationale: string; dependsOn: string[];
  estimate: { p25Minutes: number; p50Minutes: number; p85Minutes: number };
  energy: "low" | "medium" | "high"; interruptible: boolean;
  riskTier: "routine" | "milestone" | "high_risk"; evidence: string };
type Answer = { steps: Step[]; dateCandidates: Array<{ date: string; quote: string }>;
  blockers: Array<{ code: string; message: string }> };
const str = { type: "string" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties,
  required: Object.keys(properties), additionalProperties: false });
export const BACKPLAN_SCHEMA = object({ steps: { type: "array", items: object({
  id: str, intent: str, sourceQuote: str, rationale: str,
  dependsOn: { type: "array", items: str },
  estimate: object({ p25Minutes: { type: "number" }, p50Minutes: { type: "number" }, p85Minutes: { type: "number" } }),
  energy: { type: "string", enum: ["low", "medium", "high"] }, interruptible: { type: "boolean" },
  riskTier: { type: "string", enum: ["routine", "milestone", "high_risk"] }, evidence: str
}) }, dateCandidates: { type: "array", items: object({ date: str, quote: str }) },
  blockers: { type: "array", items: object({ code: str, message: str }) } });

export function validateBackplan(value: unknown, sources: string[], dateSources = sources): Answer {
  const answer = value as Answer | undefined;
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
      || typeof step.interruptible !== "boolean") throw new Error("BACKPLAN_SCHEMA_INVALID");
    seen.add(step.id);
  }
  return answer;
}

/** A proposal version is expanded once; repeating the request returns its existing draft IDs. */
export function createGoalBackplanner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined) {
  return async function backplan(milestoneId: string, signal?: AbortSignal) {
    const milestone = store.listMilestones(workspaceId).find((item) => item.id === milestoneId &&
      item.ownerId === OWNER_ID && item.status === "approved" && item.projectId);
    if (!milestone || !defaultIdentityPacks().some((pack) => pack.id === milestone.identityId && pack.kind === "identity"))
      return { state: "blocked", code: "BACKPLAN_GOAL_NOT_APPROVED", message: "需要已批准且绑定真实身份、项目的里程碑。" };
    const key = `goal:backplan:${milestone.id}:${milestone.version}`;
    const existing = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .find((event) => event.idempotencyKey === key);
    if (existing) {
      const payload = existing.payload as { workOrderIds: string[]; dateCandidates?: Answer["dateCandidates"] };
      return { state: "proposed", workOrderIds: payload.workOrderIds,
        dateCandidates: payload.dateCandidates ?? [] };
    }
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用。" };
    const request = store.listEvents(workspaceId, { type: "milestone.proposed", entityId: milestone.id })
      .at(-1)?.payload as { request?: string } | undefined;
    const decisions = store.listEvents(workspaceId, { type: ["insight.approved", "insight.revoked"] });
    const accepted = new Set(decisions.filter((event) => event.type === "insight.approved")
      .map((event) => event.entityId));
    for (const event of decisions.filter((item) => item.type === "insight.revoked")) accepted.delete(event.entityId);
    const approvedInsights = store.listEvents(workspaceId, { type: "flywheel.finding" })
      .filter((event) => accepted.has(event.eventId) && event.entityId === milestone.id)
      .map((event) => event.payload as { summary: string; sourceUrl: string; staleWhen: string });
    const dateSources = [milestone.title, ...milestone.successCriteria.map((item) => item.statement), request?.request ?? ""]
      .filter(Boolean);
    const sources = [...dateSources, ...approvedInsights.map((item) => item.summary)];
    const context = { version: "crossline.goal-backplan.v1", milestone: {
      id: milestone.id, version: milestone.version, identityId: milestone.identityId,
      projectId: milestone.projectId, title: milestone.title, successCriteria: milestone.successCriteria
    }, sourceText: request?.request ?? "", approvedInsights,
      existingWork: store.listWorkOrders(workspaceId)
      .filter((order) => order.milestoneId === milestone.id).map((order) => ({ id: order.id, intent: order.intent, state: order.state })) };
    const result = await runCodexSkill<Answer>(client, context, { skillName: SKILL, cwd,
      developerInstructions: "Work backwards from the approved milestone. Return only sourced step drafts; never set a goal or deadline. Block if the supplied source cannot justify a step.",
      outputSchema: BACKPLAN_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateBackplan(output, sources, dateSources), onAudit: () => {},
      ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000 });
    if (!result.ok) return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    const ids = new Map(result.output.steps.map((step) => [step.id, `backplan-${randomUUID()}`]));
    const drafts: StoredWorkOrder[] = result.output.steps.map((step) => {
      const id = ids.get(step.id)!;
      const external = /\b(email|publish|submit|purchase|sell|buy|sign|legal|transfer|delete)\b|发送|发布|提交|购买|出售|签署|法律|转账|删除/i
        .test(`${step.intent} ${step.rationale} ${step.evidence}`);
      const riskTier = external ? "high_risk" : step.riskTier;
      return { id, ownerId: OWNER_ID, workspaceId,
        identityId: milestone.identityId, projectId: milestone.projectId!, milestoneId: milestone.id,
        intent: step.intent, state: "awaiting_plan_approval", riskTier,
        estimate: { ...step.estimate, source: "llm_prior", observationCount: 0, confidence: "low" },
        payload: { backplan: { milestoneVersion: milestone.version, sourceQuote: step.sourceQuote,
          rationale: step.rationale, stepId: step.id }, dependsOn: step.dependsOn.map((dep) => ids.get(dep)!),
          automationParts: [], humanCore: [{ id: `${id}-core`, intent: step.intent, quote: step.sourceQuote,
            rationale: step.rationale, energy: step.energy, interruptible: step.interruptible }],
          materialContract: [], evidenceContract: [{ kind: "record", description: step.evidence,
            why: "反推步骤的交付证据", required: true }],
          audit: { threadId: result.audit.threadId ?? "unavailable", turnId: result.audit.turnId ?? "unavailable" },
          contextVersion: context.version } };
    });
    const workOrderIds = drafts.map((draft) => draft.id);
    const inserted = store.saveBackplanDrafts(workspaceId, drafts, { ownerId: OWNER_ID, workspaceId, idempotencyKey: key,
      type: "goal.backplan_proposed", entityId: milestone.id,
      payload: { milestoneVersion: milestone.version, workOrderIds,
        dateCandidates: result.output.dateCandidates, source: SKILL } });
    if (inserted) return { state: "proposed", workOrderIds, dateCandidates: result.output.dateCandidates };
    const saved = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .find((event) => event.idempotencyKey === key);
    return { state: "proposed", workOrderIds: (saved?.payload as { workOrderIds?: string[] })?.workOrderIds ?? [],
      dateCandidates: (saved?.payload as { dateCandidates?: Answer["dateCandidates"] })?.dateCandidates ?? [] };
  };
}
