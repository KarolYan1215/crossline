import {
  ARCHETYPES, AVAILABILITY_SETTING, DEFAULT_AVAILABILITY, VALIDATION_REVIEW_SCHEMA, archetypeBrief, archetypeById, stepPlanSchema, goalSettingKey,
  normalizeStepPlan, relevantDocuments, STEP_ANSWER_SLOT, stepPlanWarnings, unverifiedUnits, validateAvailability, validateStepPlanShape, validateValidationReview, weeklyAvailableHours,
  PROGRESS_ASSESSMENT_SCHEMA, validateProgressAssessment, type ProgressAssessment, type StepPlan, type StepWarning, type ValidationReview
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { listAgentTasks, type CrosslineStore, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { learnedArchetypes } from "./archetype-curator";
import { ownerOf } from "./owner";

const PLANNER = "crossline:crossline-step-planner";
const REVIEWER = "crossline:crossline-validation-reviewer";
const JUDGE = "crossline:crossline-progress-judge";
/** States in which a task is committed and its steps get time on the calendar. */
const PLANNABLE = ["approved", "preparing", "ready_for_human", "active"];
const day = (iso: string) => iso.slice(0, 10);
const AUTO_FIXED = new Set(["STEP_SHARE_NORMALIZED", "STEP_SHARE_MISSING", "STEP_ESTIMATE_MISSING", "STEP_DEPENDENCY_UNKNOWN", "STEP_TRIVIAL_TO_AGENT"]);
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
  const documents = relevantDocuments(store.listSourceDocuments(workspaceId).filter((doc) => doc.extractionStatus === "done"),
    { projectId: order.projectId, projectName: project?.name })
    .map((doc, index) => {
      const text = doc.extractedText.slice(0, Math.max(0, Math.min(MATERIAL_TEXT_PER_DOC, budget)));
      budget -= text.length;
      return { id: `doc-${index + 1}`, name: doc.fileName, text };
    }).filter((doc) => doc.text.trim());
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" || fact.value.startsWith("假设"));
  const own = (fact: (typeof facts)[number]) => fact.projectId === order.projectId ? 0 : fact.identityId === order.identityId ? 1 : fact.identityId === "person" ? 2 : 3;
  const person = facts.filter((fact) => own(fact) < 3 && !fact.slot.startsWith(STEP_ANSWER_SLOT)).sort((a, b) => own(a) - own(b)).slice(0, 50)
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
  return { documents, person, answers, dated: [...new Set(dated)].sort().slice(0, 40),
    strengths: (profile.energyMap ?? []).filter((item) => item.skill === "high").map((item) => item.activity).slice(0, 8) };
}

/** The task's window: earliest start and latest finish, from its own payload, the confirmed goal deadline, or the milestone's. */
export function taskWindow(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder, now = new Date()) {
  const payload = (order.payload ?? {}) as { notBefore?: string; dueDate?: string };
  let goalDeadline: string | undefined;
  try { goalDeadline = (JSON.parse(store.getSetting(workspaceId, goalSettingKey(order.milestoneId)) ?? "{}") as { confirmedDeadline?: string }).confirmedDeadline; } catch { /* unreadable: none */ }
  const anchor = store.listMilestoneAnchors(workspaceId).find((item) => item.milestoneId === order.milestoneId)?.deadline;
  const today = day(now.toISOString());
  const notBefore = payload.notBefore && payload.notBefore > today ? payload.notBefore : today;
  const dueBy = [payload.dueDate, goalDeadline, anchor].filter((value): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value)) && value! >= today).sort()[0] ?? "";
  let windows = DEFAULT_AVAILABILITY;
  try { const raw = store.getSetting(workspaceId, AVAILABILITY_SETTING); if (raw) windows = validateAvailability(JSON.parse(raw)); } catch { /* default pattern */ }
  const days = dueBy ? Math.max(1, Math.round((Date.parse(`${dueBy}T12:00:00Z`) - Date.parse(`${notBefore}T12:00:00Z`)) / 86_400_000) + 1) : undefined;
  // Average working minutes per day of the weekly pattern, over the window; other work shares this time, so it is an upper bound.
  const availableMinutes = days ? Math.round((weeklyAvailableHours(windows) * 60 / 7) * days) : undefined;
  return { notBefore, dueBy, ...(availableMinutes !== undefined ? { availableMinutes } : {}) };
}

/**
 * Tasks that need a step plan: committed (approved or later), not a seeded demo, not capacity work, and either never planned or asked to
 * be planned again (`task.steps_replan_requested` after the last plan). Two per tick: the migration of every open task happens over a few
 * ticks instead of one long one.
 */
export function tasksAwaitingStepPlan(store: CrosslineStore, workspaceId: string, limit = 2): string[] {
  const capacity = new Set(defaultIdentityPacks().filter((pack) => pack.kind === "capacity").map((pack) => pack.id));
  const plans = new Map(store.listStepPlans(workspaceId).map((plan) => [plan.workOrderId, plan.plannedAt]));
  const replan = new Map<string, string>();
  for (const event of store.listEvents(workspaceId, { type: "task.steps_replan_requested" })) replan.set(event.entityId, event.createdAt);
  return store.listWorkOrders(workspaceId)
    .filter((order) => PLANNABLE.includes(order.state) && !capacity.has(order.identityId) && !(order.payload as { seeded?: boolean } | undefined)?.seeded)
    .filter((order) => !plans.has(order.id) || (replan.get(order.id) ?? "") > plans.get(order.id)!)
    // A plan that failed for a reason of its own is not retried every tick; a request to replan (or a new day) does.
    .filter((order) => !store.listEvents(workspaceId, { type: "task.steps_blocked", entityId: order.id })
      .some((event) => event.createdAt > (replan.get(order.id) ?? "") && day(event.createdAt) === day(new Date().toISOString())))
    .slice(0, limit).map((order) => order.id);
}

export function createStepPlanner(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function plan(workOrderId: string, feedback = "", signal?: AbortSignal): Promise<{ state: "planned"; version: number; warnings: StepWarning[] } | { state: "blocked"; code: string; message: string }> {
    const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (!order) return { state: "blocked", code: "STEP_PLAN_TASK_NOT_FOUND", message: "任务不存在" };
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用" };
    const payload = (order.payload ?? {}) as { humanCore?: Array<{ intent: string }>; automationParts?: Array<{ intent: string }>;
      evidenceContract?: Array<{ description: string }>; materialContract?: Array<{ description: string }> };
    const milestone = store.listMilestones(workspaceId).filter((item) => item.id === order.milestoneId).at(-1);
    const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === order.projectId);
    const window = taskWindow(store, workspaceId, order);
    const previous = store.getStepPlan(workspaceId, workOrderId);
    const done = (previous?.steps ?? []).filter((step) => step.status !== "planned");
    // Archetypes the curator learned for this workspace are offered beside the built-in ones and checked the same way.
    const learned = learnedArchetypes(store, workspaceId);
    const grounding = planningContext(store, workspaceId, order);
    const input = {
      version: "crossline.step-plan.v1",
      task: { intent: order.intent, line: order.identityId, project: project?.name ?? "", riskTier: order.riskTier,
        personsPart: (payload.humanCore ?? []).map((part) => part.intent), systemMayPrepare: (payload.automationParts ?? []).map((part) => part.intent),
        mustDeliver: (payload.evidenceContract ?? []).map((item) => item.description), needs: (payload.materialContract ?? []).map((item) => item.description),
        currentEstimate: order.estimate },
      milestone: milestone ? { title: milestone.title, criteria: milestone.successCriteria.map((item) => item.statement) } : null,
      window,
      // The task's own material in full: units are read from it and cite it; a quantity is never assumed when it can be counted here.
      materials: grounding.documents,
      // Who this is for: confirmed facts (their background and level, the course's grading and target, what they said about this
      // project), the activities they are good at, the project's dated items, and what they answered to this plan's earlier questions.
      person: { facts: grounding.person, strengths: grounding.strengths, answers: grounding.answers },
      projectDates: grounding.dated,
      archetypes: [...ARCHETYPES, ...learned].map(archetypeBrief),
      // Corrections and patterns the person has given: for this task, its line, or everything.
      personalPreferences: store.preferenceLines(workspaceId, [order.identityId, `task:${order.id}`], 15),
      doneSteps: done.map((step) => ({ title: step.title, role: step.role, deliverable: step.deliverable })),
      // What the assistant already produced for this task and the person accepted: work that exists, not work to plan again.
      acceptedOutputs: listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === workOrderId && task.status === "accepted")
        .map((task) => ({ title: task.title, files: task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1)), note: task.reviewNote })),
      feedback,
      // Every earlier instruction about this task's steps still holds unless the latest one says otherwise: a replan used to see only
      // the last one, and an answer to a plan question undid the person's 「本人只做推导、解题和自测」 a minute after they said it.
      earlierFeedback: store.listEvents(workspaceId, { type: "task.steps_replan_requested", entityId: workOrderId })
        .map((event) => String((event.payload as { feedback?: string }).feedback ?? "").trim()).filter((text) => text && text !== feedback).slice(-8)
    };
    const result = await runCodexSkill<StepPlan>(client, input, { skillName: PLANNER, cwd,
      developerInstructions: "Choose the archetype and write the task's step graph as the Skill describes. Return raw JSON only."
        + (feedback ? " Apply the feedback: it is what the reviewer or the person asked to change." : ""),
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
    const { plan: normalized, warnings: fixed } = normalizeStepPlan(result.output);
    // Steps must not start before the window or end after it: clamp, the reviewer sees the warning.
    // What normalization already fixed (rescaled shares, a missing estimate filled in, an unknown dependency dropped) needs no judgement;
    // only the rest goes to the reviewer.
    const warnings = [...fixed.filter((warning) => !AUTO_FIXED.has(warning.code)), ...stepPlanWarnings(normalized, window, learned)];
    const saved = store.saveStepPlan(workspaceId, workOrderId, normalized, ownerOf(store, workspaceId), feedback ? "revised" : "planned");
    if (warnings.length) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `validation.warned:task_steps:${workOrderId}:${saved.version}`, type: "validation.warned", entityId: workOrderId,
      payload: { subject: "task_steps", version: saved.version, warnings, revised: Boolean(feedback) } });
    return { state: "planned", version: saved.version, warnings };
  };
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
      developerInstructions: "Read the progress report against the steps and standards as the Skill describes. Return raw JSON only.",
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
 * its notes — a step plan through `replan`, a candidate relation through `reviseRelation`. Something that is itself a redo is never
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
      developerInstructions: "Decide whether the warnings matter, as the Skill describes. Return raw JSON only.",
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

function stepSubject(store: CrosslineStore, workspaceId: string, item: PendingWarning) {
  const plan = store.getStepPlan(workspaceId, item.entityId);
  const order = store.listWorkOrders(workspaceId).find((row) => row.id === item.entityId);
  if (!plan || !order || plan.version !== item.version) return undefined;
  return { version: "crossline.validation-review.v1", warnings: item.warnings,
    subject: { kind: "task_steps", task: order.intent, archetype: archetypeBrief(archetypeById(plan.archetypeId, learnedArchetypes(store, workspaceId)) ?? ARCHETYPES[0]!),
      quantity: plan.quantity, rationale: plan.rationale, steps: plan.steps.map((step) => ({ id: step.id, role: step.role, title: step.title,
        doneCriterion: step.doneCriterion, share: step.share, p50Minutes: step.estimate.p50Minutes, dependsOn: step.dependsOn, status: step.status })) } };
}

/** The drafts one architect run produced for a line, while they are still untouched drafts. */
function lineSubject(store: CrosslineStore, workspaceId: string, item: PendingWarning) {
  const ids = new Set(item.milestoneIds ?? []);
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const drafts = store.listMilestones(workspaceId).filter((milestone) => ids.has(milestone.id) && milestone.status === "draft");
  if (!drafts.length) return undefined;
  return { version: "crossline.validation-review.v1", warnings: item.warnings,
    subject: { kind: "milestone_line", line: item.entityId.replace(/^line:/, ""), milestones: drafts.map((milestone) => ({ title: milestone.title,
      deadline: anchors.get(milestone.id)?.deadline ?? "", target: anchors.get(milestone.id)?.target ?? "",
      criteria: milestone.successCriteria.map((criterion) => criterion.statement) })) } };
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

/** A candidate relation with both milestones it joins and the facts it cites — enough to judge whether the claimed transfer is real. */
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
      sources: relation.evidence.map((evidence) => evidence.source) } };
}
