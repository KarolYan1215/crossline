import { randomUUID } from "node:crypto";
import { BACKPLAN_SCHEMA, mentionsExternalAction, validateBackplan, type BackplanAnswer as Answer, type MissingInput } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore, StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

import { ownerOf } from "./owner";
import { autoApproveEligible } from "./auto-approval";
const SKILL = "crossline:crossline-goal-backplanner";
/** How many next steps an automatic (rolling) backplan keeps. */
export const ROLLING_STEPS = 2;

/** What the person has already said about this milestone's missing inputs: handed over, or being waited for. */
function personInputs(store: CrosslineStore, workspaceId: string, milestoneId: string) {
  const supplied = store.listEvents(workspaceId, { type: "goal.backplan_input_supplied", entityId: milestoneId })
    .map((event) => event.payload as { what: string; text: string });
  const waiting = store.listWaitingItems(workspaceId, { state: "open" }).filter((item) => item.id.startsWith(`wait-bp-${milestoneId}-`))
    .map((item) => ({ what: item.title, who: item.who, expectedAt: item.expectedAt }));
  return { supplied, waiting };
}

const TRANSIENT = /^(SKILL_|CODEX_)/;
const toMissing = (blockers: Answer["blockers"]): MissingInput[] => blockers.map((blocker, index) => ({ id: `m${index + 1}`,
  what: blocker.what.trim(), whoHas: blocker.whoHas.trim(), message: blocker.message.trim().slice(0, 300) }));

/**
 * `rolling`: the automatic mode the worker uses after a line's milestones are approved. It keeps only the next
 * `ROLLING_STEPS` steps (the answer is in dependency order, so the first ones are what can start now) and is keyed
 * by round, so when those are done and nothing serves the milestone any more the next round proposes what follows.
 * The first real run without it turned one milestone into a ten-step chain at once and the queue grew from 11 to 20.
 */
export function createGoalBackplanner(store: CrosslineStore, workspaceId: string, cwd: string,
  getClient: () => CodexRpcBoundary | undefined, options: { rolling?: boolean } = {}) {
  return async function backplan(milestoneId: string, signal?: AbortSignal) {
    const milestone = store.listMilestones(workspaceId).find((item) => item.id === milestoneId &&
      item.status === "approved" && item.projectId);
    if (!milestone || !defaultIdentityPacks().some((pack) => pack.id === milestone.identityId && pack.kind === "identity"))
      return { state: "blocked", code: "BACKPLAN_GOAL_NOT_APPROVED", message: "需要已批准且绑定真实身份、项目的里程碑。" };
    const rounds = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .filter((event) => (event.payload as { rolling?: boolean }).rolling).length;
    const key = options.rolling ? `goal:backplan:${milestone.id}:${milestone.version}:round:${rounds}` : `goal:backplan:${milestone.id}:${milestone.version}`;
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
    const { supplied, waiting } = personInputs(store, workspaceId, milestone.id);
    const sources = [...dateSources, ...approvedInsights.map((item) => item.summary), ...supplied.map((item) => `${item.what}：${item.text}`)];
    const context = { version: "crossline.goal-backplan.v2", milestone: {
      id: milestone.id, version: milestone.version, identityId: milestone.identityId,
      projectId: milestone.projectId, title: milestone.title, successCriteria: milestone.successCriteria
    }, sourceText: request?.request ?? "", approvedInsights,
      suppliedInputs: supplied, waitingInputs: waiting, missingInputs: [] as MissingInput[],
      existingWork: store.listWorkOrders(workspaceId)
      .filter((order) => order.milestoneId === milestone.id).map((order) => ({ id: order.id, intent: order.intent, state: order.state })) };
    const rolling = options.rolling ? ` Return only the next ${ROLLING_STEPS} steps that can start now (existingWork shows what is already done or open); the rest is proposed after these are done.` : "";
    const run = (missingInputs: MissingInput[]) => {
      const input = { ...context, missingInputs };
      const runSources = [...sources, ...missingInputs.flatMap((item) => [item.message, item.what])];
      return runCodexSkill<Answer>(client, input, { skillName: SKILL, cwd,
        developerInstructions: (missingInputs.length
          ? "Work backwards from the approved milestone. Some inputs it needs are missing (missingInputs). Do not block on them: make obtaining or confirming each one a step of its own, with `acquires` set to that input's id and `sourceQuote` quoting its `message`; steps that need it depend on that step. Every other step has `acquires` \"\". Return blockers only for what the milestone itself leaves unclear; never set a goal or deadline."
          : "Work backwards from the approved milestone. Return only sourced step drafts; never set a goal or deadline; every step's `acquires` is \"\". If a step needs an input that is in none of sourceText, suppliedInputs or approvedInsights (data, a specification, someone's decision), do not invent it: return it as a blocker with `what` (the input in a few words) and `whoHas` (who can provide it, \"\" if unknown). waitingInputs are on their way: steps that need them come after the steps that do not.")
          + rolling,
        outputSchema: BACKPLAN_SCHEMA, prepareInput: () => input,
        validateOutput: (output) => validateBackplan(output, runSources, dateSources, missingInputs.map((item) => item.id)), onAudit: () => {},
        ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000 });
    };
    const recordBlocked = (code: string, message: string, missingInputs: MissingInput[]) => {
      // Numbered per attempt: after the person answers, a second refusal of the same version is a new fact, not a repeat.
      const attempt = store.listEvents(workspaceId, { type: "goal.backplan_blocked", entityId: milestone.id }).length;
      return store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `goal:backplan:blocked:${milestone.id}:${milestone.version}:${attempt}`,
        type: "goal.backplan_blocked", entityId: milestone.id,
        payload: { milestoneVersion: milestone.version, code, message: message.slice(0, 400), missing: missingInputs } }).eventId;
    };
    let result = await run([]);
    let missing: MissingInput[] = [];
    let inputsFrom = "";
    if (result.ok && result.output.blockers.length) {
      // Missing inputs are asked about, and meanwhile the milestone is split anyway with getting them as the first
      // steps: a refusal used to leave the milestone with no work at all, and nobody was told.
      missing = toMissing(result.output.blockers);
      inputsFrom = recordBlocked("BACKPLAN_INPUT_BLOCKED", missing.map((item) => item.message).join("；"), missing);
      result = await run(missing);
    }
    if (!result.ok) {
      // A logged-out runtime, a quota limit or a timeout says nothing about the milestone: not recorded, so the next
      // tick tries again. Only the model's own refusal or an answer it could not make valid closes this version.
      if (!TRANSIENT.test(result.blocker.code) && !missing.length) recordBlocked(result.blocker.code, result.blocker.message, []);
      return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    }
    if (!result.output.steps.length) {
      const message = result.output.blockers.map((item) => item.message).join("；") || "没有能拆出的步骤";
      if (!missing.length) recordBlocked("BACKPLAN_INPUT_BLOCKED", message, toMissing(result.output.blockers));
      return { state: "blocked", code: "BACKPLAN_INPUT_BLOCKED", message };
    }
    // Steps come in dependency order (each depends only on earlier ones), so the first ones are the ones that can start.
    const steps = options.rolling ? result.output.steps.slice(0, ROLLING_STEPS) : result.output.steps;
    const ids = new Map(steps.map((step) => [step.id, `backplan-${randomUUID()}`]));
    const drafts: StoredWorkOrder[] = steps.map((step) => {
      const id = ids.get(step.id)!;
      const external = mentionsExternalAction(step.intent, step.rationale, step.evidence);
      const riskTier = external ? "high_risk" : step.riskTier;
      return { id, ownerId: ownerOf(store, workspaceId), workspaceId,
        identityId: milestone.identityId, projectId: milestone.projectId!, milestoneId: milestone.id,
        intent: step.intent, state: "awaiting_plan_approval", riskTier,
        estimate: { ...step.estimate, source: "llm_prior", observationCount: 0, confidence: "low" },
        payload: { family: step.family, backplan: { milestoneVersion: milestone.version, sourceQuote: step.sourceQuote,
          rationale: step.rationale, stepId: step.id, ...(step.acquires ? { acquires: step.acquires, inputsFrom,
            missingInput: missing.find((item) => item.id === step.acquires)?.what ?? "" } : {}) }, dependsOn: step.dependsOn.map((dep) => ids.get(dep)).filter((dep): dep is string => Boolean(dep)),
          automationParts: [], humanCore: [{ id: `${id}-core`, intent: step.intent, quote: step.sourceQuote,
            rationale: step.rationale, energy: step.energy, interruptible: step.interruptible }],
          materialContract: [], evidenceContract: [{ kind: "record", description: step.evidence,
            why: "反推步骤的交付证据", required: true }],
          audit: { threadId: result.audit.threadId ?? "unavailable", turnId: result.audit.turnId ?? "unavailable" },
          contextVersion: context.version } };
    });
    const workOrderIds = drafts.map((draft) => draft.id);
    const inserted = store.saveBackplanDrafts(workspaceId, drafts, { ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: key,
      type: "goal.backplan_proposed", entityId: milestone.id,
      payload: { milestoneVersion: milestone.version, workOrderIds, ...(options.rolling ? { rolling: true, round: rounds } : {}),
        ...(missing.length ? { missing } : {}),
        dateCandidates: result.output.dateCandidates, source: SKILL } });
    if (inserted) {
      autoApproveEligible(store, workspaceId, workOrderIds);
      return { state: "proposed", workOrderIds, dateCandidates: result.output.dateCandidates };
    }
    const saved = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .find((event) => event.idempotencyKey === key);
    return { state: "proposed", workOrderIds: (saved?.payload as { workOrderIds?: string[] })?.workOrderIds ?? [],
      dateCandidates: (saved?.payload as { dateCandidates?: Answer["dateCandidates"] })?.dateCandidates ?? [] };
  };
}

/** How far ahead a milestone's deadline may be for the system to work backwards from it on its own. */
export const AUTO_BACKPLAN_HORIZON_DAYS = 21;

/**
 * Approved milestones the system should work backwards from without being asked: due within three weeks,
 * nothing open serving them yet, and not already backplanned at this version. This is what turns 「按线批准
 * 里程碑」 into a week with real steps on it — before, the only route from a milestone to work was a button
 * per milestone (which never worked on a real account) or the person typing every step themselves.
 */
export function milestonesAwaitingBackplan(store: CrosslineStore, workspaceId: string, now = new Date(), limit = 3): string[] {
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + AUTO_BACKPLAN_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const deadlines = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const open = new Set(store.listWorkOrders(workspaceId).filter((order) => !["archived", "accepted"].includes(order.state))
    .map((order) => order.milestoneId));
  // Proposed, or tried and refused (the model said the milestone's own text cannot justify a step): either way this
  // version is not tried again on a timer — a refusal repeated every fifteen minutes is quota spent on the same answer.
  // A refusal recorded before missing inputs were itemised (no `missing` field) gets one more try: the next run asks about
  // each input and splits around them, which the old one never did.
  const blocked = new Set(store.listEvents(workspaceId, { type: "goal.backplan_blocked" })
    .filter((event) => Array.isArray((event.payload as { missing?: unknown }).missing)).map((event) =>
    `${event.entityId}:${(event.payload as { milestoneVersion?: number }).milestoneVersion}`));
  const states = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order.state]));
  // A round the person discarded entirely is a "no" to this version: it is not proposed again on a timer.
  const declined = new Set(store.listEvents(workspaceId, { type: "goal.backplan_proposed" }).filter((event) => {
    const ids = (event.payload as { workOrderIds?: string[] }).workOrderIds ?? [];
    return ids.length > 0 && ids.every((id) => states.get(id) === "archived");
  }).map((event) => `${event.entityId}:${(event.payload as { milestoneVersion?: number }).milestoneVersion}`));
  for (const event of store.listEvents(workspaceId, { type: "goal.backplan_declined" }))
    declined.add(`${event.entityId}:${(event.payload as { milestoneVersion?: number }).milestoneVersion}`);
  // The person answered one of its questions (handed over a missing input, or it arrived): that is a request to
  // split it again now, past every rule above — it is their answer, not the timer.
  const lastRun = new Map<string, string>();
  for (const event of store.listEvents(workspaceId, { type: ["goal.backplan_proposed", "goal.backplan_blocked"] }))
    if ((lastRun.get(event.entityId) ?? "") < event.createdAt) lastRun.set(event.entityId, event.createdAt);
  const rerun = new Set(store.listEvents(workspaceId, { type: "goal.backplan_rerun_requested" })
    .filter((event) => event.createdAt >= (lastRun.get(event.entityId) ?? "")).map((event) => event.entityId));
  const identities = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => pack.id));
  const approved = store.listMilestones(workspaceId)
    .filter((milestone) => milestone.status === "approved" && milestone.projectId && identities.has(milestone.identityId));
  const requested = approved.filter((milestone) => rerun.has(milestone.id) && !declined.has(`${milestone.id}:${milestone.version}`));
  const due = approved
    .filter((milestone) => { const deadline = deadlines.get(milestone.id); return Boolean(deadline && deadline >= today && deadline <= horizon); })
    .filter((milestone) => !rerun.has(milestone.id) && !open.has(milestone.id) && !blocked.has(`${milestone.id}:${milestone.version}`) && !declined.has(`${milestone.id}:${milestone.version}`))
    .sort((a, b) => deadlines.get(a.id)!.localeCompare(deadlines.get(b.id)!));
  return [...requested, ...due].slice(0, limit).map((milestone) => milestone.id);
}
