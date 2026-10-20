import { personProfileFor } from "./planning-profile";
import {
  ARCHETYPES, AVAILABILITY_PROPOSED_SETTING, aiToolBrief, AVAILABILITY_SETTING, resolveAvailability, VALIDATION_REVIEW_SCHEMA, archetypeBrief, archetypeById, stepPlanSchema, goalSettingKey,
  normalizeStepPlan, readableFromMaterial, relevantDocuments, STEP_ANSWER_SLOT, stepAnswerSlot, stepPlanWarnings, unverifiedUnits, validateStepPlanShape, validateValidationReview, weeklyAvailableHours,
  PROGRESS_ASSESSMENT_SCHEMA, validateProgressAssessment, type ProgressAssessment, type StepPlan, type StepWarning, type ValidationReview,
  FINER_SPLIT_FEEDBACK, stepsNeedingFinerSplit, readModelCompletion, type FinerSplit, type StepTrouble, type SuccessCriterion
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { aiToolsFor, listAgentTasks, projectAgentOutputs, type CrosslineStore, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { learnedArchetypes } from "./archetype-curator";
import { ownerOf } from "./owner";
import { folderDocuments } from "./source-folders";

import { libraryInstruction, librarySkillsFor } from "./skill-library";
const PLANNER = "crossline:crossline-step-planner";
const REVIEWER = "crossline:crossline-validation-reviewer";
const JUDGE = "crossline:crossline-progress-judge";
/** States in which a task is committed and its steps get time on the calendar. */
const PLANNABLE = ["approved", "preparing", "ready_for_human", "active"];
const day = (iso: string) => iso.slice(0, 10);
const AUTO_FIXED = new Set(["STEP_SHARE_NORMALIZED", "STEP_SHARE_MISSING", "STEP_ESTIMATE_MISSING", "STEP_DEPENDENCY_UNKNOWN", "STEP_TRIVIAL_TO_AGENT", "STEP_NO_ASSISTANT"]);
const MATERIAL_TEXT_PER_DOC = 16_000, MATERIAL_TEXT_TOTAL = 48_000;

/**
 * Everything the plan is to rest on, for one task (decided 2026-10-09: plans were written from a file's first 300 characters and the
 * task's title, so a course with a dozen lectures before the exam was planned as 「3 个知识点」 and half the steps were filing). The
 * task's own material in full (clipped per file and overall), each with an id a content unit cites; what the person confirmed about
 * this line and project, and about themselves; the project's dated items; and what they already answered to earlier plans.
 */
export function planningContext(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder) {
  const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === order.projectId);
  let budget = MATERIAL_TEXT_TOTAL;
  const readable = store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done");
  const relevant = relevantDocuments(readable, { projectId: order.projectId, projectName: project?.name });
  // Few files of its own: the unfiled material of the folders the person (or the model) put on this task's line comes next, in the
  // reading budget left (docs/onboarding-v3.md 「文件夹授权」).
  const fromFolders = folderDocuments(store, workspaceId);
  const lineFolderDocs = relevant.length >= 3 ? [] : readable.filter((doc) => !doc.projectId && !relevant.includes(doc)
    && (fromFolders.get(doc.id)?.lines ?? []).includes(order.identityId));
  const documents = [...relevant, ...lineFolderDocs]
    .map((doc, index) => {
      const text = doc.extractedText.slice(0, Math.max(0, Math.min(MATERIAL_TEXT_PER_DOC, budget)));
      budget -= text.length;
      return { id: `doc-${index + 1}`, name: doc.fileName, text };
    }).filter((doc) => doc.text.trim());
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" || fact.value.startsWith("假设"));
  const own = (fact: (typeof facts)[number]) => fact.projectId === order.projectId ? 0 : fact.identityId === order.identityId ? 1 : fact.identityId === "person" ? 2 : 3;
  // The project's and the line's facts; how the person works comes whole in `profile` below (planningProfile), so a line with a hundred
  // facts no longer pushes it out (on the owner's research line none of the person's facts ever reached a plan).
  const person = facts.filter((fact) => own(fact) < 2 && !fact.slot.startsWith(STEP_ANSWER_SLOT)).sort((a, b) => own(a) - own(b)).slice(0, 50)
    .map((fact) => `${fact.projectId ? `[${fact.projectId}] ` : ""}${fact.slot}：${fact.value.slice(0, 240)}${fact.status === "inferred" ? "（假设）" : ""}`);
  const answers = facts.filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT) && (fact.projectId === order.projectId || fact.projectId === ""))
    .map((fact) => fact.value.slice(0, 400));
  const decided = new Map(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => [event.entityId, event.payload as { superseded?: boolean; included?: string[] }]));
  const names = new Set([order.projectId, project?.name ?? ""].filter(Boolean));
  const dated = store.listEvents(workspaceId, { type: "dates.extracted" }).flatMap((event) => {
    const decision = decided.get(event.entityId);
    if (decision?.superseded) return [];
    const payload = event.payload as { dates?: Array<{ id: string; title: string; date: string; startTime?: string; project?: string }> };
    return (payload.dates ?? []).filter((item) => names.has(item.project ?? "") && (!decision || (decision.included ?? []).includes(item.id)))
      .map((item) => `${item.date}${item.startTime ? ` ${item.startTime}` : ""} ${item.title}`);
  });
  const profile = (() => { try { return JSON.parse(store.getSetting(workspaceId, "profile.model") ?? "{}") as { energyMap?: Array<{ activity: string; skill: string; love: string }> }; } catch { return {}; } })();
  return { documents, person, answers, dated: [...new Set(dated)].sort().slice(0, 40), profile: personProfileFor(store, workspaceId),
    strengths: (profile.energyMap ?? []).filter((item) => item.skill === "high").map((item) => item.activity).slice(0, 8) };
}

/** The task's window: earliest start and latest finish, from its own payload, the confirmed goal deadline, or the milestone's. */
/**
 * The assistant's finished work for any task of this order's project — accepted, or waiting for the person's review — with which task
 * it was for. It used to be this order's accepted runs only, so each task of one course planned (and ran) the same material catalogue.
 */
export function existingOutputs(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder) {
  const own = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === order.id && task.status === "accepted");
  const project = projectAgentOutputs(store, workspaceId, order.projectId, ["accepted", "needs_review"]);
  return [...new Map([...own, ...project].map((task) => [task.taskId, task])).values()].map((task) => ({
    title: task.title, status: task.status === "accepted" ? "accepted" : "awaiting_review", forThisTask: task.workOrderId === order.id,
    files: task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1)), note: task.reviewNote }));
}

export function taskWindow(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder, now = new Date()) {
  const payload = (order.payload ?? {}) as { notBefore?: string; dueDate?: string };
  let goalDeadline: string | undefined;
  try { goalDeadline = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(order.milestoneId)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* unreadable: none */ }
  const anchor = store.listMilestoneAnchors(workspaceId).find((item) => item.milestoneId === order.milestoneId)?.deadline;
  // The workspace's own day: an ISO (UTC) date is a day early between midnight and 08:00 in UTC+8 (walkthrough W-18).
  const today = localDay(now.toISOString(), workspaceZone(store, workspaceId));
  const notBefore = payload.notBefore && payload.notBefore > today ? payload.notBefore : today;
  const dueBy = [payload.dueDate, goalDeadline, anchor].filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)) && value! >= today).sort()[0] ?? "";
  const { windows } = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(workspaceId) });
  const days = dueBy ? Math.max(1, Math.round((Date.parse(`${dueBy}T12:00:00Z`) - Date.parse(`${notBefore}T12:00:00Z`)) / 86_400_000) + 1) : undefined;
  // Average working minutes per day of the weekly pattern, over the window; other work shares this time, so it is an upper bound.
  const availableMinutes = days ? Math.round((weeklyAvailableHours(windows) * 60 / 7) * days) : undefined;
  return { notBefore, dueBy, ...(availableMinutes !== undefined ? { availableMinutes } : {}) };
}

/**
 * Tasks that need a step plan: committed (approved or later), not a seeded demo, not capacity work, and either never planned or asked to
 * be planned again (`task.steps_replan_requested` after the last plan). Two per tick: the migration of every open task happens over a few
 * ticks instead of one long one. A replan the person asked for comes first, then the most recently changed — a task just approved is
 * planned in this pass, not after every older task (decided 2026-10-14: a new task used to wait behind the backlog for up to two ticks).
 * A proposal still waiting for the person is planned too, and before everything else (decided 2026-10-15): the person approves the steps
 * they will do, not a title and a duration, and the proposal is not listed for them until its steps exist (`proposalReady`).
 */
export function tasksAwaitingStepPlan(store: CrosslineStore, workspaceId: string, limit = 2): string[] {
  const capacity = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const plans = new Map(store.listStepPlans(workspaceId).map((plan) => [plan.workOrderId, plan.plannedAt]));
  const replan = new Map<string, string>();
  for (const event of store.listEvents(workspaceId, { type: "task.steps_replan_requested" })) replan.set(event.entityId, event.createdAt);
  const proposal = (order: StoredWorkOrder) => Number(order.state === "awaiting_plan_approval");
  return store.listWorkOrders(workspaceId)
    .filter((order) => (PLANNABLE.includes(order.state) || order.state === "awaiting_plan_approval") && !capacity.has(order.identityId)
      && !(order.payload as { seeded?: boolean } | undefined)?.seeded)
    .filter((order) => !plans.has(order.id) || (replan.get(order.id) ?? "") > plans.get(order.id)!)
    // A plan that failed for a reason of its own is not retried every tick; a request to replan (or a new day) does.
    .filter((order) => !store.listEvents(workspaceId, { type: "task.steps_blocked", entityId: order.id })
      .some((event) => event.createdAt > (replan.get(order.id) ?? "") && day(event.createdAt) === day(new Date().toISOString())))
    .reverse()
    .sort((a, b) => proposal(b) - proposal(a) || Number(plans.has(b.id)) - Number(plans.has(a.id)))
    .slice(0, limit).map((order) => order.id);
}

/** How far back adaptive granularity reads what happened to the steps. */
const TROUBLE_LOOKBACK_DAYS = 14;
function localDay(iso: string, zone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** The zone the person's days are read in: their saved preference, else `CROSSLINE_TIME_ZONE`, else Chicago. */
function workspaceZone(store: CrosslineStore, workspaceId: string) {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  return zone;
}

/**
 * Adaptive granularity (docs/energy-and-ecosystem.md §6): reads what happened to each open step from the ledger (`StepTrouble`) and,
 * for a step that did not get done on two days, asks for the task's steps to be planned again smaller (`task.steps_replan_requested`
 * with `finerSplit`), which the task pass then picks up like any replan. Rules only, no model call and no question; the person sees it
 * in the change summary on Today once the new plan exists. Returns what it asked for.
 */
export function requestFinerSplits(store: CrosslineStore, workspaceId: string, now = new Date()): FinerSplit[] {
  const zone = workspaceZone(store, workspaceId);
  const today = localDay(now.toISOString(), zone);
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => PLANNABLE.includes(order.state)).map((order) => [order.id, order]));
  const stepPlans = store.listStepPlans(workspaceId).filter((plan) => orders.has(plan.workOrderId));
  const plans = stepPlans.map((plan) => ({ orderId: plan.workOrderId, version: plan.version,
    openStepIds: plan.steps.filter((step) => step.status === "planned" && step.schedulable && step.executor !== "agent").map((step) => step.id) }));
  const troubles: StepTrouble[] = [];
  const confirmed = store.listEvents(workspaceId, { type: "block.confirmed" }).map((event) => event.payload as { blockId?: string; workOrderId?: string; stepId?: string; day?: string; outcome?: string });
  for (const answer of confirmed) if (answer.outcome === "not_done" && answer.workOrderId && answer.stepId && answer.day)
    troubles.push({ kind: "not_done", orderId: answer.workOrderId, stepId: answer.stepId, day: answer.day });
  // The blocks the nudge pass saw under way (`nudge.blocks:<day>`, apps/web/lib/nudges.ts): one with no timer started that day and no
  // completion answer was not started. Past days only, so a block under way now is not counted.
  const startedOn = new Set(store.listExecutions(workspaceId).map((execution) => `${execution.workOrderId}|${localDay(execution.startedAt, zone)}`));
  const seenByDay = new Map<string, Array<{ id: string; orderId: string; stepId: string; began?: boolean }>>();
  for (let back = 1; back <= TROUBLE_LOOKBACK_DAYS; back += 1) {
    const dayKey = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    let seen: Record<string, { id: string; orderId: string; stepId: string; began?: boolean }> = {};
    try { seen = JSON.parse(store.getSetting(workspaceId, `nudge.blocks:${dayKey}`) ?? "{}"); } catch { /* none */ }
    const blocks = Object.values(seen);
    seenByDay.set(dayKey, blocks);
    for (const block of blocks) if (block.began && block.stepId && !startedOn.has(`${block.orderId}|${dayKey}`)
      && !confirmed.some((answer) => answer.blockId === block.id && answer.day === dayKey))
      troubles.push({ kind: "not_started", orderId: block.orderId, stepId: block.stepId, day: dayKey });
  }
  // 「昨天排的没做」 rolled forward: the steps that task had blocks for that day.
  for (const event of store.listEvents(workspaceId, { type: "missed.handled" })) {
    const { askId, how } = event.payload as { askId?: string; how?: string };
    const [, orderId, missedDay] = (askId ?? "").split(":");
    if (!orderId || !missedDay || !["roll", "later"].includes(how ?? "")) continue;
    for (const block of seenByDay.get(missedDay) ?? []) if (block.orderId === orderId && block.stepId)
      troubles.push({ kind: "missed", orderId, stepId: block.stepId, day: missedDay });
  }
  const since = new Date(now.getTime() - TROUBLE_LOOKBACK_DAYS * 86_400_000).toISOString();
  for (const message of store.listRecentNudges(workspaceId, since)) {
    const nudge = message.payload.nudge as { kind?: string; step?: { orderId: string; stepId: string } } | undefined;
    if (nudge?.kind === "timer_overrun" && nudge.step) troubles.push({ kind: "overrun", ...nudge.step, day: localDay(message.createdAt, zone) });
  }
  const asked = store.listEvents(workspaceId, { type: "task.steps_replan_requested" }).flatMap((event) => {
    const split = (event.payload as { finerSplit?: { stepId: string; version: number } }).finerSplit;
    return split ? [{ orderId: event.entityId, stepId: split.stepId, version: split.version, at: event.createdAt }] : [];
  });
  const splits = stepsNeedingFinerSplit(troubles, { plans, asked, now: now.toISOString() });
  for (const split of splits) {
    const title = stepPlans.find((plan) => plan.workOrderId === split.orderId)?.steps.find((step) => step.id === split.stepId)?.title ?? "";
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `task.steps_finer_split:${split.orderId}:${split.stepId}:${split.version}`,
      type: "task.steps_replan_requested", entityId: split.orderId,
      payload: { feedback: `「${title}」${split.days.length} 天没做成：${FINER_SPLIT_FEEDBACK}`, finerSplit: { stepId: split.stepId, version: split.version, title, days: split.days } } });
  }
  return splits;
}

/** A milestone this important or more makes its tasks important (the scheduler's own line for 「重要」). */
export const IMPORTANT_WEIGHT = 60;

/**
 * Whether a task is important by rule (docs/review-2026-10-13.md §11, the person's decision): graded coursework read from the course's
 * own files (a homework or exam date pair), or work for a milestone the scheduler weighs at 60 or more (the web records the weights in
 * `milestone.weights`). The planner's own judgement of the long-term plan is the other half (`importance.longTerm`).
 */
export function importantByRule(store: CrosslineStore, workspaceId: string, order: { milestoneId: string; payload?: unknown }): boolean {
  if ((order.payload as { datePair?: unknown } | undefined)?.datePair) return true;
  let weights: Record<string, number> = {};
  try { weights = JSON.parse(store.getSetting(workspaceId, "milestone.weights") ?? "{}") as Record<string, number>; } catch { /* none recorded */ }
  return Boolean(order.milestoneId) && (weights[order.milestoneId] ?? 0) >= IMPORTANT_WEIGHT;
}

export function createStepPlanner(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  options: { libraryDir?: string } = {}) {
  return async function plan(workOrderId: string, feedback = "", signal?: AbortSignal): Promise<{ state: "planned"; version: number; warnings: StepWarning[] } | { state: "blocked"; code: string; message: string }> {
    const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (!order) return { state: "blocked", code: "STEP_PLAN_TASK_NOT_FOUND", message: "任务不存在" };
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用" };
    const payload = (order.payload ?? {}) as { humanCore?: Array<{ intent: string }>; automationParts?: Array<{ intent: string }>;
      evidenceContract?: Array<{ description: string }>; materialContract?: Array<{ description: string }>; infoRequests?: unknown[] };
    const milestone = store.listMilestones(workspaceId).filter((item) => item.id === order.milestoneId).at(-1);
    const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === order.projectId);
    const window = taskWindow(store, workspaceId, order);
    const previous = store.getStepPlan(workspaceId, workOrderId);
    const done = (previous?.steps ?? []).filter((step) => step.status !== "planned");
    // Archetypes the curator learned for this workspace are offered beside the built-in ones and checked the same way.
    const learned = learnedArchetypes(store, workspaceId);
    const grounding = planningContext(store, workspaceId, order);
    const tools = aiToolsFor(store, workspaceId);
    // Important work the person does themselves is researched first (the web is open for this run): its background and the best known
    // way to do it, the plan proposed on that basis, and only what the person alone can answer asked.
    const research = importantByRule(store, workspaceId, order) && (payload.humanCore ?? []).length > 0;
    const input = {
      version: "crossline.step-plan.v1",
      research,
      task: { intent: order.intent, line: order.identityId, project: project?.name ?? "", riskTier: order.riskTier,
        personsPart: (payload.humanCore ?? []).map((part) => part.intent), systemMayPrepare: (payload.automationParts ?? []).map((part) => part.intent),
        mustDeliver: (payload.evidenceContract ?? []).map((item) => item.description), needs: (payload.materialContract ?? []).map((item) => item.description),
        currentEstimate: order.estimate,
        // Facts to get from someone before the work (folded in by the backplanner or the daily merge): each is a drafted email and a send.
        getFirst: payload.infoRequests ?? [] },
      milestone: milestone ? { title: milestone.title, criteria: milestone.successCriteria.map((item) => item.statement) } : null,
      window,
      // The task's own material in full: units are read from it and cite it; a quantity is never assumed when it can be counted here.
      materials: grounding.documents,
      // Who this is for: confirmed facts (their background and level, the course's grading and target, what they said about this
      // project), the activities they are good at, the project's dated items, and what they answered to this plan's earlier questions.
      person: { facts: grounding.person, strengths: grounding.strengths, answers: grounding.answers, profile: grounding.profile },
      projectDates: grounding.dated,
      archetypes: [...ARCHETYPES, ...learned].map(archetypeBrief),
      // The AI tools the person works with (docs/skills-library.md §7): the assistant takes whole steps, the rest name the tool that
      // speeds them, and every estimate is the time with it.
      aiTools: tools.map(aiToolBrief),
      // Corrections and patterns the person has given: for this task, its line, or everything.
      personalPreferences: store.preferenceLines(workspaceId, [order.identityId, `task:${order.id}`], 15),
      doneSteps: done.map((step) => ({ title: step.title, role: step.role, deliverable: step.deliverable })),
      // What the assistant already produced for this course or project: work that exists, not work to plan again.
      acceptedOutputs: existingOutputs(store, workspaceId, order),
      feedback,
      // Every earlier instruction about this task's steps still holds unless the latest one says otherwise: a replan used to see only
      // the last one, and an answer to a plan question undid the person's 「本人只做推导、解题和自测」 a minute after they said it.
      earlierFeedback: store.listEvents(workspaceId, { type: "task.steps_replan_requested", entityId: workOrderId })
        .map((event) => String((event.payload as { feedback?: string }).feedback ?? "").trim()).filter((text) => text && text !== feedback).slice(-8)
    };
    // The line's own skill and the public skills that fit the task, read beside the planner's: how this work is done shapes the steps.
    const extraSkills = await librarySkillsFor(client, store, workspaceId, order.identityId, { cwd, task: order.intent, ...(options.libraryDir ? { dir: options.libraryDir } : {}) });
    const result = await runCodexSkill<StepPlan>(client, input, { skillName: PLANNER, cwd, ...(extraSkills.length ? { extraSkills } : {}), redoOnRepair: true,
      developerInstructions: "Write this task's steps as the crossline-step-planner Skill describes and return only the requested JSON. The steps are "
        + "what the person sees on the task and what the scheduler puts on the calendar. Read `materials` first and count the units from them, each quoting "
        + "its file verbatim. The person's steps are only the intellectual core (solving, deriving, deciding, writing, rehearsing), each one focused "
        + "session with a quantified done criterion and a firstAction of five minutes or less; collecting, listing and filing are the assistant's steps. "
        + "The rationale is a few short sentences for the person: what the plan rests on, never the input's keys, ids or how units were counted. "
        + "Ask only what neither the material nor person.facts settles, with the likeliest option first."
        + libraryInstruction(extraSkills)
        + (feedback ? " Apply the feedback: it is what the reviewer or the person asked to change; earlierFeedback still holds unless it contradicts it." : "")
        + (research ? " research is true: search the web for this task's background and the best known way to do it before planning, as the Skill's research section says." : ""),
      ...(research ? { allowWebSearch: true } : {}),
      outputSchema: stepPlanSchema(learned.map((archetype) => archetype.id)), prepareInput: () => input,
      validateOutput: (output) => {
        const shaped = validateStepPlanShape(output, learned);
        // Units are the plan's footing: each must quote its own file verbatim, or the plan is sent back to read the file again.
        const bad = unverifiedUnits(shaped.units ?? [], grounding.documents);
        if (bad.length) throw Object.assign(new Error("STEP_UNIT_UNVERIFIED"), { detail: `这些内容单元的 quote 在所注明的文件里找不到逐字原文：${bad.slice(0, 5)
          .map((unit) => `「${unit.title}」(${unit.docId})`).join("、")}。只引用 materials 中逐字出现的行；文件里没有的内容，写进 questions 问本人。` });
        return shaped;
      },
      // After the repairs, a plan whose only fault is a few unverifiable units is kept without them.
      softAccept: (rejection, output) => {
        if (rejection.message !== "STEP_UNIT_UNVERIFIED") return undefined;
        try { const shaped = validateStepPlanShape(output, learned); const bad = new Set(unverifiedUnits(shaped.units ?? [], grounding.documents).map((unit) => unit.id));
          return { ...shaped, units: (shaped.units ?? []).filter((unit) => !bad.has(unit.id)) }; } catch { return undefined; }
      },
      onAudit: () => {}, ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000 });
    if (!result.ok) {
      if (!/^(SKILL_|CODEX_)/.test(result.blocker.code)) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
        idempotencyKey: `task.steps_blocked:${workOrderId}:${Date.now()}`, type: "task.steps_blocked", entityId: workOrderId,
        payload: { code: result.blocker.code, message: result.blocker.message.slice(0, 300) } });
      return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    }
    // Every account has the assistant in one mode or another (assistantMode: the owner's shell, else Crossline's tools on any model), so
    // collecting and filing stay the assistant's on the hosted beta too; tying this to the shell turned every such step into the person's.
    const { plan: shapedPlan, warnings: fixed } = normalizeStepPlan(result.output, tools.map((tool) => tool.name), { assistant: true });
    const normalized = result.output.importance ? { ...shapedPlan, importance: result.output.importance } : shapedPlan;
    // Steps must not start before the window or end after it: clamp, the reviewer sees the warning.
    // What normalization already fixed (rescaled shares, a missing estimate filled in, an unknown dependency dropped) needs no judgement;
    // only the rest goes to the reviewer.
    const warnings = [...fixed.filter((warning) => !AUTO_FIXED.has(warning.code)), ...stepPlanWarnings(normalized, window, learned)];
    const saved = store.saveStepPlan(workspaceId, workOrderId, normalized, ownerOf(store, workspaceId), feedback ? "revised" : "planned");
    // A task nobody judged the completion of yet (one from a course's dates, or written before the field) takes the planner's judgement;
    // one the analysis or backplanner already judged keeps theirs, and the person's own choice is `completionMode`, untouched here.
    const completion = readModelCompletion(result.output.completion);
    const current = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (completion && current && !readModelCompletion((current.payload as { completion?: unknown } | undefined)?.completion))
      store.saveWorkOrder({ ...current, payload: { ...((current.payload ?? {}) as object), completion } });
    // Only an important task's questions go to the person; a minor task's are settled as assumptions the next plan reads (and the
    // person can still correct on the task), so they never become a decision to make. A task's questions are put to the person once, on
    // its first plan: a replan (after answers, a progress report or a reviewer's note) settles what it still wonders about as assumptions
    // — answering three questions about 「核验排班价值指标」 brought three reworded ones back, every round (2026-10-18 walkthrough).
    // Important means important by rule only: the planner's own `importance.longTerm` was true for nearly everything, and approving 19
    // milestones put about 60 questions in front of the person in one afternoon (2026-10-18 evaluation). Even an important task puts only
    // its first `PERSON_QUESTIONS_PER_TASK` to the person; the rest are assumptions, shown on the task and changeable there.
    if (feedback || !importantByRule(store, workspaceId, order)) assumeAnswers(store, workspaceId, order, normalized.questions);
    else {
      // What the task's own files settle (the problem set, how it is handed in, the AI rule) is read from them, not asked.
      const readable = materialQuestions(store, workspaceId, order, normalized.questions);
      assumeAnswers(store, workspaceId, order, readable, true);
      assumeAnswers(store, workspaceId, order, beyondPersonShare(normalized.questions.filter((question) => !readable.includes(question))));
    }
    if (warnings.length) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `validation.warned:task_steps:${workOrderId}:${saved.version}`, type: "validation.warned", entityId: workOrderId,
      payload: { subject: "task_steps", version: saved.version, warnings, revised: Boolean(feedback) } });
    return { state: "planned", version: saved.version, warnings };
  };
}

/**
 * Questions already stored are filtered by the same rule as new ones (the person's decision, 2026-10-13, tightened 2026-10-18): a task
 * important by rule keeps its first `PERSON_QUESTIONS_PER_TASK` for the person; the rest, and every question of another task, are
 * settled as assumptions. Runs on the task pass.
 */
export function settleOldQuestions(store: CrosslineStore, workspaceId: string): string[] {
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  const settled: string[] = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    const order = orders.get(plan.workOrderId);
    if (!order || !plan.questions.length) continue;
    const readable = materialQuestions(store, workspaceId, order, plan.questions);
    if (readable.length) assumeAnswers(store, workspaceId, order, readable, true);
    const rest = plan.questions.filter((question) => !readable.includes(question));
    const assumed = importantByRule(store, workspaceId, order) ? beyondPersonShare(rest) : rest;
    if (assumed.length) assumeAnswers(store, workspaceId, order, assumed);
    if (readable.length || assumed.length) settled.push(plan.workOrderId);
  }
  return settled;
}

/** How many of an important task's questions go to the person; the planner lists the ones that change the plan most first. */
export const PERSON_QUESTIONS_PER_TASK = 2;
// Questions of the kind the task's files answer do not count: they leave as soon as a file arrives.
const beyondPersonShare = (questions: StepPlan["questions"]) =>
  questions.filter((question) => !readableFromMaterial(question.text)).slice(PERSON_QUESTIONS_PER_TASK);

/** The questions the task's own files answer (`readableFromMaterial`), when the task's project has files at all. */
function materialQuestions(store: CrosslineStore, workspaceId: string, order: { projectId: string }, questions: StepPlan["questions"]): StepPlan["questions"] {
  const readable = questions.filter((question) => readableFromMaterial(question.text));
  return readable.length && order.projectId && store.listSourceDocuments(workspaceId).some((doc) => doc.projectId === order.projectId) ? readable : [];
}

/**
 * Records each question's first option as an assumption under the question's answer slot: `假设：【question】option`. One the files
 * answer says so: the files rule, the option only where they say nothing.
 */
function assumeAnswers(store: CrosslineStore, workspaceId: string, order: { identityId: string; projectId: string }, questions: StepPlan["questions"],
  fromMaterial = false): void {
  const answered = new Set(store.listProfileFacts(workspaceId).filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT)).map((fact) => `${fact.projectId}|${fact.slot}`));
  for (const question of questions) {
    const slot = stepAnswerSlot(question.text);
    if (answered.has(`${order.projectId}|${slot}`) || (!question.options[0] && !fromMaterial)) continue;
    const value = fromMaterial ? `假设：【${question.text}】以任务材料为准${question.options[0] ? `；材料未写明时按「${question.options[0]}」` : ""}` : `假设：【${question.text}】${question.options[0]}`;
    store.upsertProfileFact({ workspaceId, identityId: order.identityId, projectId: order.projectId, slot, value,
      status: "inferred", sourceRef: "", sourceQuote: "", updatedAt: new Date().toISOString() });
  }
}

/** Progress reports nobody has read yet (`task.progress_reported` without a `task.progress_judged` for the same report). */
export function reportsAwaitingJudgement(store: CrosslineStore, workspaceId: string, limit = 2) {
  const judged = new Set(store.listEvents(workspaceId, { type: "task.progress_judged" }).map((event) => (event.payload as { reportId: string }).reportId));
  return store.listEvents(workspaceId, { type: "task.progress_reported" })
    .map((event) => ({ workOrderId: event.entityId, ...(event.payload as { reportId: string; text: string }) }))
    .filter((report) => !judged.has(report.reportId)).slice(0, limit);
}

/**
 * Reads one progress report against the task's steps and the standards it is judged against, and records the readings: steps move by
 * quarters (4 = done), standards get a `criteria.assessed` reading the card's rings show.
 */
export function createProgressJudge(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function judge(report: ReturnType<typeof reportsAwaitingJudgement>[number]): Promise<ProgressAssessment | undefined> {
    const client = getClient();
    if (!client) return undefined;
    const order = store.listWorkOrders(workspaceId).find((item) => item.id === report.workOrderId);
    const done = (assessment: ProgressAssessment | null, code = "") => store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `task.progress_judged:${report.reportId}`, type: "task.progress_judged", entityId: report.workOrderId,
      payload: { reportId: report.reportId, ...(assessment ? { summary: assessment.summary } : { code }) } });
    if (!order) { done(null, "WORK_ORDER_NOT_FOUND"); return undefined; }
    const steps = store.getStepPlan(workspaceId, order.id)?.steps ?? [];
    const milestone = store.listMilestones(workspaceId).filter((item) => item.id === order.milestoneId).at(-1);
    const criteria = milestone?.successCriteria ?? [];
    const input = { version: "crossline.progress-judge.v1", task: order.intent, report: { text: report.text },
      steps: steps.map((step) => ({ id: step.id, title: step.title, doneCriterion: step.doneCriterion, quarters: step.progressQuarter, status: step.status })),
      criteria: criteria.map((criterion) => ({ id: criterion.id, statement: criterion.statement })) };
    const result = await runCodexSkill<ProgressAssessment>(client, input, { skillName: JUDGE, cwd,
      developerInstructions: "Read the person's progress report against this task's steps and standards, as the crossline-progress-judge Skill describes, "
        + "and return only the requested JSON. A reading moves a step forward on the task card, so give one only for what the report speaks to, and 4 "
        + "only when the report shows the done criterion met.",
      outputSchema: PROGRESS_ASSESSMENT_SCHEMA, prepareInput: () => input,
      validateOutput: (output) => validateProgressAssessment(output, steps.map((step) => step.id), criteria.map((criterion) => criterion.id)),
      onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (!result.ok) { if (!/^(SKILL_|CODEX_)/.test(result.blocker.code)) done(null, result.blocker.code); return undefined; }
    for (const item of result.output.steps) {
      const step = steps.find((row) => row.id === item.stepId);
      // A report only ever moves a step forward; a lower reading than what is recorded is left alone.
      if (step && step.status === "planned" && item.quarters > step.progressQuarter)
        store.updateStepProgress(workspaceId, order.id, step.id, item.quarters >= 4 ? { status: "done" } : { progressQuarter: item.quarters }, ownerOf(store, workspaceId), "assessment");
    }
    if (result.output.criteria.length) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `criteria.assessed:${report.reportId}`, type: "criteria.assessed", entityId: order.id,
      payload: { reportId: report.reportId, criteria: result.output.criteria } });
    done(result.output);
    return result.output;
  };
}

/** Warnings no reviewer has looked at yet, oldest first: a task's step plan or a candidate cross-line relation. */
export function warningsAwaitingReview(store: CrosslineStore, workspaceId: string, limit = 1) {
  const reviewed = new Set(store.listEvents(workspaceId, { type: "validation.reviewed" })
    .map((event) => `${event.entityId}:${(event.payload as { version?: number }).version}`));
  return store.listEvents(workspaceId, { type: "validation.warned" })
    .filter((event) => !reviewed.has(`${event.entityId}:${(event.payload as { version?: number }).version}`))
    .slice(0, limit)
    .map((event) => ({ entityId: event.entityId, ...(event.payload as { subject: string; version: number; warnings: StepWarning[]; revised: boolean; milestoneIds?: string[] }) }));
}

/**
 * The second check: a reviewer model reads the flagged output and the warnings and either dismisses them or has the output redone with
 * its notes — a step plan through `replan`, a candidate relation through `reviseRelation` (which designs its receiving line again). Something that is itself a redo is never
 * redone again by the reviewer — one round, so a disagreement cannot loop.
 */
export function createWarningReviewer(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  replan: (workOrderId: string, feedback: string) => Promise<unknown>, reviseRelation?: (relationId: string, notes: string) => Promise<unknown>,
  reviseLine?: (identityId: string, notes: string) => Promise<unknown>) {
  return async function review(item: ReturnType<typeof warningsAwaitingReview>[number]): Promise<ValidationReview | undefined> {
    const client = getClient();
    if (!client) return undefined;
    const record = (verdict: ValidationReview) => store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `validation.reviewed:${item.entityId}:${item.version}`, type: "validation.reviewed", entityId: item.entityId,
      payload: { subject: item.subject, version: item.version, ...verdict } });
    const input = item.subject === "milestone_relation" ? relationSubject(store, workspaceId, item)
      : item.subject === "milestone_line" ? lineSubject(store, workspaceId, item)
      : item.subject === "analysis" ? analysisSubject(store, workspaceId, item) : stepSubject(store, workspaceId, item);
    if (!input) { record({ verdict: "dismiss", notes: "已被新版本取代" }); return undefined; }
    const result = await runCodexSkill<ValidationReview>(client, input, { skillName: REVIEWER, cwd,
      developerInstructions: REVIEW_INSTRUCTIONS[item.subject] ?? REVIEW_INSTRUCTIONS.task_steps!,
      outputSchema: VALIDATION_REVIEW_SCHEMA, prepareInput: () => input, validateOutput: validateValidationReview,
      onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (!result.ok) return undefined;
    const verdict: ValidationReview = item.revised && result.output.verdict === "redo"
      ? { verdict: "dismiss", notes: `已重排过一次，保留当前版本。${result.output.notes}`.slice(0, 1200) } : result.output;
    record(verdict);
    if (verdict.verdict === "redo") {
      if (item.subject === "milestone_relation") await reviseRelation?.(item.entityId, verdict.notes);
      else if (item.subject === "milestone_line") await reviseLine?.(item.entityId.replace(/^line:/, ""), verdict.notes);
      // An analysis whose numbers or contract were corrected is fixed where its numbers now live: the task's step plan is redone.
      else if (item.subject === "analysis") await replan(item.entityId.replace(/^analysis:/, ""), verdict.notes);
      else await replan(item.entityId, verdict.notes);
    }
    return verdict;
  };
}

type PendingWarning = ReturnType<typeof warningsAwaitingReview>[number];

/**
 * What each kind of review decides and where its notes go: one line saying "decide whether the warnings matter" for all four left the
 * reviewer to guess who would read a redo's notes.
 */
const REVIEW_COMMON = " Return only the requested JSON. Judge the substance, never the wording; when unsure, dismiss.";
const REVIEW_INSTRUCTIONS: Record<string, string> = {
  task_steps: "Decide whether the warnings on this task's step plan point at a real problem the person would notice (no hand-in, an order that "
    + "cannot work, a total that cannot fit the window, a step nobody could tell is done), as the crossline-validation-reviewer Skill describes. "
    + "A redo's notes go to the step planner as its brief, one concrete change per line." + REVIEW_COMMON,
  milestone_line: "Decide whether the drafts an architect run kept despite quality warnings can stand, as the crossline-validation-reviewer Skill "
    + "describes. Redo when a draft is an ongoing condition rather than a dated result, a score line has no margin or derivation, or a graded part "
    + "is missing; the notes become the architect's brief for this line." + REVIEW_COMMON,
  analysis: "Decide whether this task's corrected estimate and evidence contract can be right for the task, as the crossline-validation-reviewer "
    + "Skill describes. A redo's notes go to the step planner, which estimates again step by step." + REVIEW_COMMON,
  milestone_relation: "Decide whether this cross-line link claims a real transfer someone could check on its check day, as the "
    + "crossline-validation-reviewer Skill describes. A redo's notes become the brief for designing the receiving line again: say what the link "
    + "should claim instead, or that it should be dropped." + REVIEW_COMMON
};

function stepSubject(store: CrosslineStore, workspaceId: string, item: PendingWarning) {
  const plan = store.getStepPlan(workspaceId, item.entityId);
  const order = store.listWorkOrders(workspaceId).find((row) => row.id === item.entityId);
  if (!plan || !order || plan.version !== item.version) return undefined;
  return { version: "crossline.validation-review.v1", warnings: item.warnings,
    subject: { kind: "task_steps", task: order.intent, archetype: archetypeBrief(archetypeById(plan.archetypeId, learnedArchetypes(store, workspaceId)) ?? ARCHETYPES[0]!),
      quantity: plan.quantity, rationale: plan.rationale, steps: plan.steps.map((step) => ({ id: step.id, role: step.role, title: step.title,
        doneCriterion: step.doneCriterion, share: step.share, p50Minutes: step.estimate.p50Minutes, dependsOn: step.dependsOn, status: step.status,
        // Whose step it is: the assistant's take no calendar time, so a total that "cannot fit the window" may count only the person's.
        executor: step.executor, schedulable: step.schedulable })) } };
}

/** The drafts one architect run produced for a line, while they are still untouched drafts. */
function lineSubject(store: CrosslineStore, workspaceId: string, item: PendingWarning) {
  const ids = new Set(item.milestoneIds ?? []);
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const drafts = store.listMilestones(workspaceId).filter((milestone) => ids.has(milestone.id) && milestone.status === "draft");
  if (!drafts.length) return undefined;
  // The rationale carries the derivation (`persistProposals` appends it), which is what a 「no margin or derivation」 warning is about.
  const rationale = new Map(store.listEvents(workspaceId, { type: "milestone.proposed" })
    .map((event) => [event.entityId, String((event.payload as { rationale?: string }).rationale ?? "")]));
  const line = (measure: SuccessCriterion["measure"]) => measure.kind === "threshold"
    ? `${measure.comparator === "lte" ? "≤" : "≥"} ${measure.value}${measure.unit}${typeof measure.bareLine === "number" ? `（刚好够：${measure.bareLine}）` : ""}` : "";
  return { version: "crossline.validation-review.v1", warnings: item.warnings,
    subject: { kind: "milestone_line", line: item.entityId.replace(/^line:/, ""), milestones: drafts.map((milestone) => ({ title: milestone.title,
      deadline: anchors.get(milestone.id)?.deadline ?? "", target: anchors.get(milestone.id)?.target ?? "",
      criteria: milestone.successCriteria.map((criterion) => [criterion.statement, line(criterion.measure)].filter(Boolean).join(" ")),
      rationale: (rationale.get(milestone.id) ?? "").slice(0, 800) })) } };
}

/** An analysis kept after a quality correction, while its task has not started. */
function analysisSubject(store: CrosslineStore, workspaceId: string, item: PendingWarning) {
  const order = store.listWorkOrders(workspaceId).find((row) => row.id === item.entityId.replace(/^analysis:/, ""));
  if (!order || !["awaiting_plan_approval", "approved", "preparing", "ready_for_human"].includes(order.state)) return undefined;
  const payload = (order.payload ?? {}) as { materialContract?: Array<{ description: string }>; evidenceContract?: Array<{ description: string; required: boolean }>;
    estimateBreakdown?: Array<{ step: string; minutes: number }> };
  return { version: "crossline.validation-review.v1", warnings: item.warnings,
    subject: { kind: "analysis", task: order.intent, estimate: order.estimate, breakdown: payload.estimateBreakdown ?? [],
      evidence: (payload.evidenceContract ?? []).map((entry) => entry.description), materials: (payload.materialContract ?? []).map((entry) => entry.description) } };
}

/**
 * A candidate relation with both milestones it joins, the artifact it hands over, the promised transfer, the lag and the counterfactual —
 * enough to judge whether the claimed transfer is real. A redo designs the receiving line again (`createRelationReviser`).
 */
function relationSubject(store: CrosslineStore, workspaceId: string, item: PendingWarning) {
  const relation = store.listMilestoneRelations(workspaceId).find((row) => row.id === item.entityId);
  if (!relation || relation.status !== "candidate") return undefined;
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const end = (id: string) => {
    const milestone = store.listMilestones(workspaceId).find((row) => row.id === id);
    const anchor = anchors.get(id);
    return milestone ? { line: milestone.identityId, title: milestone.title, deadline: anchor?.deadline ?? "", target: anchor?.target ?? "" } : undefined;
  };
  const from = end(relation.fromMilestoneId), to = end(relation.toMilestoneId);
  if (!from || !to) return undefined;
  return { version: "crossline.validation-review.v1", warnings: item.warnings,
    subject: { kind: "milestone_relation", relationKind: relation.kind, from, to, explanation: relation.explanation ?? "", refutedWhen: relation.refutedWhen ?? "",
      sources: relation.evidence.map((evidence) => evidence.source),
      ...(relation.artifactId ? { artifact: relation.artifactId, transfer: relation.transfer, checkOn: relation.checkOn, counterfactual: relation.counterfactual ?? "" } : {}) } };
}
