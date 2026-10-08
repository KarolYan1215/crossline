import {
  ARCHETYPES, AVAILABILITY_SETTING, DEFAULT_AVAILABILITY, STEP_PLAN_SCHEMA, VALIDATION_REVIEW_SCHEMA, archetypeBrief, goalSettingKey,
  normalizeStepPlan, stepPlanWarnings, validateAvailability, validateStepPlanShape, validateValidationReview, weeklyAvailableHours,
  type StepPlan, type StepWarning, type ValidationReview
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { listAgentTasks, type CrosslineStore, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { ownerOf } from "./owner";

const PLANNER = "crossline:crossline-step-planner";
const REVIEWER = "crossline:crossline-validation-reviewer";
/** States in which a task is committed and its steps get time on the calendar. */
const PLANNABLE = ["approved", "preparing", "ready_for_human", "active"];
const day = (iso: string) => iso.slice(0, 10);
const AUTO_FIXED = new Set(["STEP_SHARE_NORMALIZED", "STEP_SHARE_MISSING", "STEP_ESTIMATE_MISSING", "STEP_DEPENDENCY_UNKNOWN"]);

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
    const input = {
      version: "crossline.step-plan.v1",
      task: { intent: order.intent, line: order.identityId, project: project?.name ?? "", riskTier: order.riskTier,
        personsPart: (payload.humanCore ?? []).map((part) => part.intent), systemMayPrepare: (payload.automationParts ?? []).map((part) => part.intent),
        mustDeliver: (payload.evidenceContract ?? []).map((item) => item.description), needs: (payload.materialContract ?? []).map((item) => item.description),
        currentEstimate: order.estimate },
      milestone: milestone ? { title: milestone.title, criteria: milestone.successCriteria.map((item) => item.statement) } : null,
      window,
      materials: store.listSourceDocuments(workspaceId).filter((doc) => !doc.projectId || doc.projectId === order.projectId)
        .map((doc) => ({ name: doc.fileName, opening: doc.extractedText.slice(0, 300) })).slice(0, 12),
      archetypes: ARCHETYPES.map(archetypeBrief),
      doneSteps: done.map((step) => ({ title: step.title, role: step.role, deliverable: step.deliverable })),
      // What the assistant already produced for this task and the person accepted: work that exists, not work to plan again.
      acceptedOutputs: listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === workOrderId && task.status === "accepted")
        .map((task) => ({ title: task.title, files: task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1)), note: task.reviewNote })),
      preferences: [] as string[],
      feedback
    };
    const result = await runCodexSkill<StepPlan>(client, input, { skillName: PLANNER, cwd,
      developerInstructions: "Choose the archetype and write the task's step graph as the Skill describes. Return raw JSON only."
        + (feedback ? " Apply the feedback: it is what the reviewer or the person asked to change." : ""),
      outputSchema: STEP_PLAN_SCHEMA, prepareInput: () => input, validateOutput: (output) => validateStepPlanShape(output),
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
    const warnings = [...fixed.filter((warning) => !AUTO_FIXED.has(warning.code)), ...stepPlanWarnings(normalized, window)];
    const saved = store.saveStepPlan(workspaceId, workOrderId, normalized, ownerOf(store, workspaceId), feedback ? "revised" : "planned");
    if (warnings.length) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `validation.warned:task_steps:${workOrderId}:${saved.version}`, type: "validation.warned", entityId: workOrderId,
      payload: { subject: "task_steps", version: saved.version, warnings, revised: Boolean(feedback) } });
    return { state: "planned", version: saved.version, warnings };
  };
}

/** Warnings no reviewer has looked at yet, oldest first. */
export function warningsAwaitingReview(store: CrosslineStore, workspaceId: string, limit = 1) {
  const reviewed = new Set(store.listEvents(workspaceId, { type: "validation.reviewed" })
    .map((event) => `${event.entityId}:${(event.payload as { version?: number }).version}`));
  return store.listEvents(workspaceId, { type: "validation.warned" })
    .filter((event) => !reviewed.has(`${event.entityId}:${(event.payload as { version?: number }).version}`))
    .slice(0, limit)
    .map((event) => ({ workOrderId: event.entityId, ...(event.payload as { subject: string; version: number; warnings: StepWarning[]; revised: boolean }) }));
}

/**
 * The second check: a reviewer model reads the plan and the warnings and either dismisses them or has the plan redone with its notes.
 * A plan that is itself a redo is never redone again by the reviewer — one round, so a disagreement cannot loop.
 */
export function createWarningReviewer(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  replan: (workOrderId: string, feedback: string) => Promise<unknown>) {
  return async function review(item: ReturnType<typeof warningsAwaitingReview>[number]): Promise<ValidationReview | undefined> {
    const client = getClient();
    if (!client) return undefined;
    const plan = store.getStepPlan(workspaceId, item.workOrderId);
    const order = store.listWorkOrders(workspaceId).find((row) => row.id === item.workOrderId);
    const record = (verdict: ValidationReview) => store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `validation.reviewed:${item.workOrderId}:${item.version}`, type: "validation.reviewed", entityId: item.workOrderId,
      payload: { subject: item.subject, version: item.version, ...verdict } });
    if (!plan || !order || plan.version !== item.version) { record({ verdict: "dismiss", notes: "已被新版本取代" }); return undefined; }
    const input = { version: "crossline.validation-review.v1", warnings: item.warnings,
      subject: { kind: "task_steps", task: order.intent, archetype: archetypeBrief(ARCHETYPES.find((a) => a.id === plan.archetypeId) ?? ARCHETYPES[0]!),
        quantity: plan.quantity, rationale: plan.rationale, steps: plan.steps.map((step) => ({ id: step.id, role: step.role, title: step.title,
          doneCriterion: step.doneCriterion, share: step.share, p50Minutes: step.estimate.p50Minutes, dependsOn: step.dependsOn, status: step.status })) } };
    const result = await runCodexSkill<ValidationReview>(client, input, { skillName: REVIEWER, cwd,
      developerInstructions: "Decide whether the warnings matter, as the Skill describes. Return raw JSON only.",
      outputSchema: VALIDATION_REVIEW_SCHEMA, prepareInput: () => input, validateOutput: validateValidationReview,
      onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (!result.ok) return undefined;
    const verdict: ValidationReview = item.revised && result.output.verdict === "redo"
      ? { verdict: "dismiss", notes: `已重排过一次，保留当前版本。${result.output.notes}`.slice(0, 1200) } : result.output;
    record(verdict);
    if (verdict.verdict === "redo") await replan(item.workOrderId, verdict.notes);
    return verdict;
  };
}
