import { personProfileFor } from "./planning-profile";
import { randomUUID } from "node:crypto";
import { BACKPLAN_SCHEMA, foldInfoRequests, goalSettingKey, mentionsExternalAction, producedArtifacts, usedArtifacts, validateBackplan, withCourse, type BackplanAnswer as Answer,
  type MissingInput } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { handOffArtifacts, linkArtifactWork, readStoredArtifactPlan, type CrosslineStore, type StoredWorkOrder } from "@crossline/db";

import { ownerOf } from "./owner";
import { localToday } from "./analysis";
import { autoApproveEligible } from "./auto-approval";
import { identityLines } from "./lines";
import { decideFold, existingTasksFor, openTasks, recentlyDoneTasks, recordFold, type Fold } from "./duplicate-guard";
import { materialExcerpts, relevantFacts } from "./material-context";
const SKILL = "crossline:crossline-goal-backplanner";
/** How many next steps an automatic (rolling) backplan keeps. */
export const ROLLING_STEPS = 2;

/** What the person has already said about this milestone's missing inputs: handed over, or being waited for. */
function personInputs(store: CrosslineStore, workspaceId: string, milestoneId: string) {
  const supplied = store.listEvents(workspaceId, { type: "goal.backplan_input_supplied", entityId: milestoneId })
    .map((event) => event.payload as { what: string; text: string });
  // An item the person already had for the same thing is linked rather than duplicated (see `waitingIndex` in the web's asks).
  const linked = new Map(store.listEvents(workspaceId, { type: "goal.backplan_input_waiting", entityId: milestoneId })
    .map((event) => event.payload as { waitingId: string; what: string }).map((link) => [link.waitingId, link.what]));
  const waiting = store.listWaitingItems(workspaceId, { state: "open" })
    .filter((item) => item.id.startsWith(`wait-bp-${milestoneId}-`) || linked.has(item.id))
    .map((item) => ({ what: linked.get(item.id) ?? item.title, who: item.who, expectedAt: item.expectedAt }));
  return { supplied, waiting };
}

const TRANSIENT = /^(SKILL_|CODEX_)/;

/**
 * The cross-line artifacts this milestone's tasks must produce and may use (docs/flywheel-and-views.md §5.5): from its anchor's `outputs`
 * and `inputs`, less what open or finished work already produces or uses, with what the plan says about each.
 */
export function milestoneArtifacts(store: CrosslineStore, workspaceId: string, milestoneId: string) {
  const anchor = store.listMilestoneAnchors(workspaceId).find((item) => item.milestoneId === milestoneId);
  const plan = readStoredArtifactPlan(store, workspaceId);
  const artifacts = new Map(plan.artifacts.map((artifact) => [artifact.id, artifact]));
  const work = store.listWorkOrders(workspaceId).filter((order) => order.state !== "archived");
  const produced = new Set(work.flatMap((order) => producedArtifacts(order)));
  const used = new Set(work.filter((order) => order.milestoneId === milestoneId).flatMap((order) => usedArtifacts(order)));
  const produce = (anchor?.outputs ?? []).filter((id) => artifacts.has(id) && !produced.has(id)).map((id) => ({ id, title: artifacts.get(id)!.title,
    toLines: plan.supplies.filter((pair) => pair.from === id).map((pair) => ({ line: pair.toLine, use: pair.use })) }));
  const use = (anchor?.inputs ?? []).filter((id) => artifacts.has(id) && !used.has(id)).map((id) => ({ id, title: artifacts.get(id)!.title,
    fromLine: artifacts.get(id)!.line }));
  return { produce, use };
}
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
    if (!milestone || !identityLines(store, workspaceId).some((pack) => pack.id === milestone.identityId))
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
    const artifacts = milestoneArtifacts(store, workspaceId, milestone.id);
    // What this milestone's work rests on beyond the planning profile (docs/context-selection.md): the project's and the line's facts
    // ranked by the milestone's terms, and the passages of the project's files (else the line's) that match it, as excerpts.
    const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === milestone.projectId);
    const query = [milestone.title, project?.name ?? "", ...milestone.successCriteria.map((item) => item.statement), request?.request ?? ""].join(" ");
    const facts = relevantFacts(store.listProfileFacts(workspaceId), { query, projectId: milestone.projectId ?? "", identityId: milestone.identityId },
      { budget: 3_000 });
    const projectMaterial = materialExcerpts(store, workspaceId, query, { projectId: milestone.projectId ?? "", identityId: milestone.identityId, within: "project" });
    const materials = projectMaterial.length ? projectMaterial : materialExcerpts(store, workspaceId, query, { identityId: milestone.identityId, within: "line" });
    // The date the tasks are worked back to (the one the person confirmed, else the approved plan's): without it a milestone due in five
    // days and one due in five months were split the same way.
    let confirmedDeadline: string | undefined;
    try { confirmedDeadline = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(milestone.id)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* none */ }
    const milestoneDeadline = confirmedDeadline ?? store.listMilestoneAnchors(workspaceId).find((anchor) => anchor.milestoneId === milestone.id)?.deadline ?? "";
    const context = { version: "crossline.goal-backplan.v2", today: localToday(store, workspaceId), artifacts, milestone: {
      id: milestone.id, version: milestone.version, identityId: milestone.identityId,
      projectId: milestone.projectId, title: milestone.title, deadline: milestoneDeadline, successCriteria: milestone.successCriteria
    }, sourceText: request?.request ?? "", approvedInsights,
      // How the person works and what the plan serves, from the interview (planningProfile): tasks are sized and ordered for this person.
      personProfile: personProfileFor(store, workspaceId),
      facts, materials,
      suppliedInputs: supplied, waitingInputs: waiting, missingInputs: [] as MissingInput[],
      existingWork: store.listWorkOrders(workspaceId)
      .filter((order) => order.milestoneId === milestone.id).map((order) => ({ id: order.id, intent: order.intent, state: order.state })),
      // Every open task of this line and project (the task library included): work one of them covers is not written again.
      existingTasks: existingTasksFor(store, workspaceId, { identityId: milestone.identityId, projectId: milestone.projectId! }),
      // Work of this line and project finished in the last 30 days: done once, not proposed again (walkthrough W-30).
      recentlyDone: recentlyDoneTasks(store, workspaceId).filter((task) => task.identityId === milestone.identityId && task.projectId === milestone.projectId)
        .slice(0, 20).map((task) => ({ id: task.id, title: task.title.slice(0, 120), intent: task.intent.slice(0, 160) })) };
    const rolling = options.rolling ? ` Return only the next ${ROLLING_STEPS} items that can start now (existingWork shows what is already done or open); the rest is proposed after these are done.` : "";
    const run = (missingInputs: MissingInput[]) => {
      const input = { ...context, missingInputs };
      const runSources = [...sources, ...materials.map((item) => item.text), ...missingInputs.flatMap((item) => [item.message, item.what])];
      return runCodexSkill<Answer>(client, input, { skillName: SKILL, cwd, redoOnRepair: true,
        developerInstructions: "Work backwards from this approved milestone to the tasks that deliver it, as the crossline-goal-backplanner Skill describes, "
          + "and return only the requested JSON. Each item becomes one task card on the person's 任务 page (one deliverable, 30 to 480 minutes, named "
          + "with its course or project) that the step planner splits into steps afterwards; a request for a fact is never an item. Read existingTasks and "
          + "recentlyDone first: never write work they cover, and an item that only adds to an open task sets extendsTaskId. Never set a goal, a deadline "
          + "or criteria.",
        // The prompt cache (docs/token-economy.md §2.5): how the person works, then the line's and the project's work and material, then
        // this milestone and the date; the mode and the artifact rules for this run after the input.
        stableKeys: ["version", "personProfile", "existingTasks", "recentlyDone", "facts", "materials", "milestone", "artifacts"],
        runNote: ((missingInputs.length
            ? " Second mode: missingInputs are known to be missing and are being asked about. Obtaining each is the first part of the task that needs it "
              + "(acquires = its id, sourceQuote from its message); a separate item only when obtaining it is real work. Blockers only for what the milestone "
              + "itself leaves unclear."
            : " First mode: an input the work needs that is in none of sourceText, suppliedInputs, approvedInsights, facts or materials is a blocker with what and whoHas, "
              + "never invented; every acquires is \"\". Items that need waitingInputs come after those that do not.")
          + (artifacts.produce.length || artifacts.use.length ? " Exactly one item produces each artifacts.produce id (produces); every artifacts.use id is in the uses of the items that work with it." : "")
          + rolling).trim(),
        outputSchema: BACKPLAN_SCHEMA, prepareInput: () => input,
        validateOutput: (output) => validateBackplan(output, runSources, dateSources, missingInputs.map((item) => item.id),
          { produce: artifacts.produce.map((item) => item.id), use: artifacts.use.map((item) => item.id) }, context.existingTasks.map((task) => task.id)), onAudit: () => {},
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
    // A request for a fact that another item needs becomes that item's first step instead of a task (info-request.ts, 2026-10-15).
    const { steps: shaped } = foldInfoRequests(result.output.steps);
    // Steps come in dependency order (each depends only on earlier ones), so the first ones are the ones that can start.
    const planned = options.rolling ? shaped.slice(0, ROLLING_STEPS) : shaped;
    // Before anything is written: an item that only adds to an open task, or that the merge rules call the same as one, goes into that
    // task instead of standing beside it, and items depending on it depend on that task.
    const open = openTasks(store, workspaceId);
    const done = recentlyDoneTasks(store, workspaceId);
    const deadline = store.listMilestoneAnchors(workspaceId).find((anchor) => anchor.milestoneId === milestone.id)?.deadline ?? "";
    const folds = new Map<string, Fold>();
    for (const step of planned) {
      const fold = decideFold(open, { id: `backplan:${key}:${step.id}`, identityId: milestone.identityId, projectId: milestone.projectId!, milestoneId: milestone.id,
        title: withCourse(step.title, milestone.projectId), intent: step.intent, state: "awaiting_plan_approval", dueDate: "", milestoneDeadline: deadline,
        progress: 0, hasStepPlan: false, started: false, dependsOn: [] }, step.extendsTaskId ?? "", done);
      if (fold) folds.set(step.id, fold);
    }
    const steps = planned.filter((step) => !folds.has(step.id));
    const ids = new Map([...steps.map((step) => [step.id, `backplan-${randomUUID()}`] as const), ...[...folds].map(([stepId, fold]) => [stepId, fold.keep] as const)]);
    const drafts: StoredWorkOrder[] = steps.map((step) => {
      const id = ids.get(step.id)!;
      // What the step *is*, not why or what it leaves behind: 「首轮发布清单草稿」 as evidence made picking topics high-risk.
      const external = mentionsExternalAction(step.intent);
      const riskTier = external ? "high_risk" : step.riskTier;
      return { id, ownerId: ownerOf(store, workspaceId), workspaceId,
        identityId: milestone.identityId, projectId: milestone.projectId!, milestoneId: milestone.id,
        intent: step.intent, state: "awaiting_plan_approval", riskTier,
        estimate: { ...step.estimate, source: "llm_prior", observationCount: 0, confidence: "low" },
        payload: { title: withCourse(step.title, milestone.projectId), family: step.family, backplan: { milestoneVersion: milestone.version, sourceQuote: step.sourceQuote,
          rationale: step.rationale, stepId: step.id, ...(step.acquires ? { acquires: step.acquires, inputsFrom,
            missingInput: missing.find((item) => item.id === step.acquires)?.what ?? "" } : {}) }, dependsOn: step.dependsOn.map((dep) => ids.get(dep)).filter((dep): dep is string => Boolean(dep)),
          ...(step.produces ? { produces: step.produces } : {}), ...(step.uses.length ? { uses: step.uses } : {}),
          // What the task first has to get from someone: the step planner makes each a drafted email (assistant) and a send (person).
          ...(step.infoRequests?.length ? { infoRequests: step.infoRequests } : {}),
          // How finishing it is taken, as the backplanner judged it (`completion.ts`).
          ...(step.completion ? { completion: step.completion } : {}),
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
        ...(missing.length ? { missing } : {}), ...(folds.size ? { folded: [...folds].map(([stepId, fold]) => ({ stepId, into: fold.keep, kind: fold.kind })) } : {}),
        dateCandidates: result.output.dateCandidates, source: SKILL } });
    if (inserted) {
      for (const [stepId, fold] of folds) {
        const step = planned.find((item) => item.id === stepId)!;
        recordFold(store, workspaceId, fold, { id: `backplan:${key}:${stepId}`, title: withCourse(step.title, milestone.projectId), intent: step.intent, source: "backplan" });
        // The kept task now serves this milestone too, so the milestone is not split again for want of open work.
        const keep = store.listWorkOrders(workspaceId).find((order) => order.id === fold.keep);
        const serves = ((keep?.payload ?? {}) as { alsoServes?: string[] }).alsoServes ?? [];
        if (keep && keep.milestoneId !== milestone.id && !serves.includes(milestone.id))
          store.saveWorkOrder({ ...keep, payload: { ...(keep.payload as object), alsoServes: [...serves, milestone.id] } });
      }
      // A use waits for its producer across lines, and a producer already delivered hands its files over now.
      linkArtifactWork(store, workspaceId);
      handOffArtifacts(store, workspaceId);
      autoApproveEligible(store, workspaceId, workOrderIds);
      return { state: "proposed", workOrderIds, dateCandidates: result.output.dateCandidates };
    }
    const saved = store.listEvents(workspaceId, { type: "goal.backplan_proposed", entityId: milestone.id })
      .find((event) => event.idempotencyKey === key);
    return { state: "proposed", workOrderIds: (saved?.payload as { workOrderIds?: string[] })?.workOrderIds ?? [],
      dateCandidates: (saved?.payload as { dateCandidates?: Answer["dateCandidates"] })?.dateCandidates ?? [] };
  };
}

/**
 * How far ahead a task's milestone may be due for its work to be scheduled. Every approved milestone is worked backwards into tasks
 * (the task library, decided 2026-10-08); a task whose milestone is due later than this stays in the library, unscheduled, until it
 * comes within the window (`apps/web/lib/crossline.ts`).
 */
export const AUTO_BACKPLAN_HORIZON_DAYS = 21;

/**
 * Approved milestones the system should work backwards from without being asked: every one with nothing open serving it yet and not
 * already backplanned at this version — soonest deadline first, undated ones last. This is what turns 「按线批准里程碑」 into real tasks:
 * before, the only route from a milestone to work was a button per milestone or the person typing every step themselves. Only those due
 * within `AUTO_BACKPLAN_HORIZON_DAYS` are scheduled; the rest wait in the task library.
 */
export function milestonesAwaitingBackplan(store: CrosslineStore, workspaceId: string, now = new Date(), limit = 3): string[] {
  const today = now.toISOString().slice(0, 10);
  const deadlines = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  // A task the daily merge kept for several milestones (`alsoServes`) serves each of them: none is split again for having lost its own.
  const open = new Set(store.listWorkOrders(workspaceId).filter((order) => !["archived", "accepted"].includes(order.state))
    .flatMap((order) => [order.milestoneId, ...((order.payload as { alsoServes?: string[] } | undefined)?.alsoServes ?? [])]));
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
  const identities = new Set(identityLines(store, workspaceId).map((pack) => pack.id));
  const approved = store.listMilestones(workspaceId)
    .filter((milestone) => milestone.status === "approved" && milestone.projectId && identities.has(milestone.identityId));
  const requested = approved.filter((milestone) => rerun.has(milestone.id) && !declined.has(`${milestone.id}:${milestone.version}`));
  // A passed deadline is the person's to move (the risk ask), not something to plan towards; an undated milestone sorts last.
  const due = approved
    .filter((milestone) => { const deadline = deadlines.get(milestone.id); return !deadline || deadline >= today; })
    .filter((milestone) => !rerun.has(milestone.id) && !open.has(milestone.id) && !blocked.has(`${milestone.id}:${milestone.version}`) && !declined.has(`${milestone.id}:${milestone.version}`))
    .sort((a, b) => (deadlines.get(a.id) || "9999").localeCompare(deadlines.get(b.id) || "9999"));
  return [...requested, ...due].slice(0, limit).map((milestone) => milestone.id);
}
