import { personProfileFor } from "./planning-profile";
import { drillBackingFor } from "./drill-backing";
import {
  ARCHETYPES, AVAILABILITY_PROPOSED_SETTING, aiToolBrief, stepTypesBrief, AVAILABILITY_SETTING, resolveAvailability, VALIDATION_REVIEW_SCHEMA, archetypeBrief, archetypeById, stepPlanSchema, goalSettingKey,
  normalizeStepPlan, STEP_ANSWER_SLOT, stepAnswerSlot, stepPlanWarnings, unverifiedUnits, validateStepPlanShape, validateValidationReview, weeklyAvailableHours,
  PROGRESS_ASSESSMENT_SCHEMA, validateProgressAssessment, type ProgressAssessment, type StepPlan, type StepWarning, type ValidationReview,
  FINER_SPLIT_FEEDBACK, FAMILIARITY_INSTRUCTIONS, FAMILIARITY_JUDGE, stepsNeedingFinerSplit, readModelCompletion, onPersonsBoard, preparesOf, type FinerSplit, type StepTrouble, type SuccessCriterion,
  assumedAnswer, questionNeededDay, taskTitleOf, carryOverSteps, remapFrozenSteps, parseFrozen, FROZEN_SETTING, MILESTONE_RISKS_SETTING, milestoneReadingOf, parseMilestoneRisks
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { aiToolsFor, createRefBook, familiarityBook, familiarityFor, lessonsFor, listAgentTasks, ownerPreferencesFor, projectAgentOutputs, withRef, type CrosslineStore, type RefBook, type StoredWorkOrder } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { learnedArchetypes } from "./archetype-curator";
import { ownerOf } from "./owner";
import { recordOwnerDisputes } from "./owner-disputes";
import { localeOf, tOfWorkspace } from "./locale";
import { ORDER_STARTS_SETTING, startingWithin } from "./schedule-window";
import { sayToPerson } from "./workflow-smith";
import { factLedger, relevantFacts, selectMaterial } from "./material-context";
import { mergeTools, READ_LEDGER_INSTRUCTIONS } from "./ledger-index";
import { ASK_PERSON_INSTRUCTIONS, withAskTool } from "./ask-tool";

import { libraryInstruction, librarySkillsFor } from "./skill-library";
const PLANNER = "crossline:crossline-task-planner:steps";
const REVIEWER = "crossline:crossline-validation-reviewer";
const JUDGE = "crossline:crossline-evidence-judge:progress";
/** States in which a task is committed and its steps get time on the calendar. */
const PLANNABLE = ["approved", "preparing", "ready_for_human", "active"];
const day = (iso: string) => iso.slice(0, 10);
const AUTO_FIXED = new Set(["STEP_OWNER_TABLE", "STEP_SHARE_NORMALIZED", "STEP_SHARE_MISSING", "STEP_ESTIMATE_MISSING", "STEP_DEPENDENCY_UNKNOWN", "STEP_TRIVIAL_TO_AGENT", "STEP_NO_ASSISTANT",
  "STEP_OWNER_ASK", "STEP_OWNER_PERSON", "STEP_REVIEW_FOLDED", "STEP_DRILL_FORM_STRIPPED", "STEP_DRILL_FORM_DROPPED"]);
/** What a task is searched by: its wording, its project, the milestone it serves, what it must deliver and what it needs. */
export function taskQuery(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder, options: { core?: boolean } = {}): string {
  const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === order.projectId);
  const milestone = store.listMilestones(workspaceId).filter((item) => item.id === order.milestoneId).at(-1);
  const payload = (order.payload ?? {}) as { title?: string; humanCore?: Array<{ intent: string }>; evidenceContract?: Array<{ description: string }>;
    materialContract?: Array<{ description: string }> };
  // The core: what names the task (its title, project and milestone), without the contract's general wording.
  if (options.core) return [payload.title ?? order.intent.slice(0, 80), project?.name ?? "", milestone?.title ?? ""].filter(Boolean).join(" ");
  return [payload.title ?? "", order.intent, project?.name ?? "", milestone?.title ?? "", ...(payload.humanCore ?? []).map((part) => part.intent),
    ...(payload.evidenceContract ?? []).map((item) => item.description), ...(payload.materialContract ?? []).map((item) => item.description)]
    .filter(Boolean).join(" ").slice(0, 1200);
}

/**
 * Everything the plan is to rest on, for one task (decided 2026-10-09: plans were written from a file's first 300 characters and the
 * task's title, so a course with a dozen lectures before the exam was planned as 「3 个知识点」 and half the steps were filing). Since
 * 2026-10-20 (docs/context-selection.md) the material is chosen for the task, not cut blind: the task's files and the passages of any
 * file that match it (`selectMaterial`), which the model reads further through `search_material`/`read_chunk`; the project's and the
 * line's facts ranked by the task's terms within a budget (`relevantFacts`); the project's dated items; earlier answers.
 */
export function planningContext(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder, book?: RefBook) {
  const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === order.projectId);
  const query = taskQuery(store, workspaceId, order);
  const material = selectMaterial(store, { query, core: taskQuery(store, workspaceId, order, { core: true }), workspaceId, projectId: order.projectId,
    identityId: order.identityId, ...(project?.name ? { projectName: project.name } : {}) });
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" || fact.value.startsWith("假设")); // i18n-ignore: the stored 「假设」 marker
  // The project's and the line's facts, the task's own project first and then by the task's terms; how the person works comes whole in
  // `profile` below (planningProfile), so a line with a hundred facts no longer pushes it out.
  const person = relevantFacts(facts, { query, projectId: order.projectId, identityId: order.identityId },
    { exclude: (fact) => fact.slot.startsWith(STEP_ANSWER_SLOT), ...(book ? { ref: book.fact } : {}) });
  // The same facts as an index read through read_ledger, for a route that calls functions (token-economy.md §2); `person` is the fallback.
  const factIndex = factLedger(facts, { query, projectId: order.projectId, identityId: order.identityId },
    { exclude: (fact) => fact.slot.startsWith(STEP_ANSWER_SLOT), ...(book ? { ref: book.fact } : {}) });
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
  return { material, documents: material.documents(), person, factIndex, answers, dated: [...new Set(dated)].sort().slice(0, 40), profile: personProfileFor(store, workspaceId, order.identityId),
    strengths: (profile.energyMap ?? []).filter((item) => item.skill === "high").map((item) => item.activity).slice(0, 8) };
}

/** The task's window: earliest start and latest finish, from its own payload, the confirmed goal deadline, or the milestone's. */
/**
 * The assistant's finished work for any task of this order's project — accepted, or waiting for the person's review — with which task
 * it was for. It used to be this order's accepted runs only, so each task of one course planned (and ran) the same material catalogue.
 */
export function existingOutputs(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder) {
  // What the assistant's own items made for this task (`payload.prepares`, docs/work-split.md) is this task's too: its 「已备好」.
  const forThis = new Set([order.id, ...store.listWorkOrders(workspaceId).filter((item) => preparesOf(item) === order.id).map((item) => item.id)]);
  const own = listAgentTasks(store, workspaceId).filter((task) => forThis.has(task.workOrderId) && task.status === "accepted");
  const project = projectAgentOutputs(store, workspaceId, order.projectId, ["accepted", "needs_review"]);
  return [...new Map([...own, ...project].map((task) => [task.taskId, task])).values()].map((task) => ({
    title: task.title, status: task.status === "accepted" ? "accepted" : "awaiting_review", forThisTask: forThis.has(task.workOrderId),
    files: task.artifacts.map((artifact) => artifact.path.split(/[\\/]/).at(-1)), note: task.reviewNote }));
}

export function taskWindow(store: CrosslineStore, workspaceId: string, order: StoredWorkOrder, now = new Date()) {
  const payload = (order.payload ?? {}) as { notBefore?: string; dueDate?: string; partDeadlines?: Array<{ title: string; dueDate: string }> };
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
  // A part merged in with an earlier day of its own (W-194, `applyMerge`): the steps that do it are due by then.
  const partDeadlines = (payload.partDeadlines ?? []).filter((item) => item.dueDate >= today);
  return { notBefore, dueBy, ...(availableMinutes !== undefined ? { availableMinutes } : {}), ...(partDeadlines.length ? { partDeadlines } : {}) };
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
  for (const event of store.listEvents(workspaceId, { type: "task.changed", change: "steps_replan_requested" })) replan.set(event.entityId, event.createdAt);
  const proposal = (order: StoredWorkOrder) => Number(order.state === "awaiting_plan_approval");
  return store.listWorkOrders(workspaceId)
    .filter((order) => (PLANNABLE.includes(order.state) || order.state === "awaiting_plan_approval") && !capacity.has(order.identityId)
      && !(order.payload as { seeded?: boolean } | undefined)?.seeded
      // The assistant's own work and the questions to the person are not split into the person's steps (docs/work-split.md).
      && onPersonsBoard(order))
    .filter((order) => !plans.has(order.id) || (replan.get(order.id) ?? "") > plans.get(order.id)!)
    // A plan that failed for a reason of its own is not retried every tick; a request to replan (or a new day) does.
    .filter((order) => !store.listEvents(workspaceId, { type: "task.changed", change: "steps_blocked", entityId: order.id })
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
  const confirmed = store.listEvents(workspaceId, { type: "work_order.changed", change: "block_confirmed" }).map((event) => event.payload as { blockId?: string; workOrderId?: string; stepId?: string; day?: string; outcome?: string });
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
  for (const event of store.listEvents(workspaceId, { type: "work_order.changed", change: "missed_handled" })) {
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
  const asked = store.listEvents(workspaceId, { type: "task.changed", change: "steps_replan_requested" }).flatMap((event) => {
    const split = (event.payload as { finerSplit?: { stepId: string; version: number } }).finerSplit;
    return split ? [{ orderId: event.entityId, stepId: split.stepId, version: split.version, at: event.createdAt }] : [];
  });
  const splits = stepsNeedingFinerSplit(troubles, { plans, asked, now: now.toISOString() });
  for (const split of splits) {
    const title = stepPlans.find((plan) => plan.workOrderId === split.orderId)?.steps.find((step) => step.id === split.stepId)?.title ?? "";
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `task.steps_finer_split:${split.orderId}:${split.stepId}:${split.version}`,
      type: "task.changed", entityId: split.orderId,
      // i18n-ignore: the brief for the next plan (model-facing); the page builds its own line from `finerSplit`
      payload: { feedback: `「${title}」${split.days.length} 天没做成：${FINER_SPLIT_FEEDBACK}`, finerSplit: { stepId: split.stepId, version: split.version, title, days: split.days }, change: "steps_replan_requested" } });
  }
  return splits;
}

/** What the replan of a plan written under the old schema is told. */
// i18n-ignore-start: briefs for the next plan (model-facing)
export const OUTDATED_PLAN_FEEDBACK = "按现行规则重排步骤：本人每一步写出 5 分钟内能开始的首个动作，标出能借助的 AI 工具及省下的时间，能交给助手的整理和收集交给助手。";
export const STEP_TYPES_FEEDBACK = "按统一步骤类型表重排：每一步标出产出（材料、核心产出、能力提升、对外动作），由产出决定谁做；只有本人手里才有的材料列入 needs，先请本人提交，没有再用公开材料。";
// i18n-ignore-end

/**
 * Plans written under older rules, planned again once each, and only when their work starts within a week (`startingWithin`, the tutorial's
 * lead), so the task library's far work is not replanned for nothing. Rules only; the task pass picks the request up like any replan.
 * - `first_action`: before a step plan had to give each person step its first move (`firstAction`) and say which AI tool helps (`aiAssist`)
 *   — STEP_PLAN_SCHEMA since 2026-10-14 (13 live tasks on the real account, planned 10-08 to 10-10).
 * - `step_types`: before steps named their product (`STEP_TYPES`, 2026-10-22): who does each step was read from its wording, tutorials were
 *   written for every person step, and material only the person has was a 「从 Canvas 下载」 line inside the steps.
 */
export function requestOutdatedReplans(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const soon = startingWithin(store, workspaceId, now);
  const asked = new Set(store.listEvents(workspaceId, { type: "task.changed", change: "steps_replan_requested" }).filter((event) => (event.payload as { outdated?: boolean }).outdated)
    .map((event) => `${event.entityId}|${(event.payload as { reason?: string }).reason ?? "first_action"}`));
  const live = new Set(store.listWorkOrders(workspaceId).filter((order) => PLANNABLE.includes(order.state)).map((order) => order.id));
  const out: string[] = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!live.has(plan.workOrderId) || !soon.has(plan.workOrderId)) continue;
    const open = plan.steps.filter((step) => step.status === "planned" && step.executor !== "agent");
    if (!open.length) continue;
    const reason = !plan.steps.some((step) => step.firstAction || step.aiAssist) ? "first_action" : !plan.steps.some((step) => step.product) ? "step_types" : "";
    if (!reason || asked.has(`${plan.workOrderId}|${reason}`)) continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `task.steps_outdated:${plan.workOrderId}:${plan.version}:${reason}`,
      type: "task.changed", entityId: plan.workOrderId,
      payload: { feedback: reason === "first_action" ? OUTDATED_PLAN_FEEDBACK : STEP_TYPES_FEEDBACK, outdated: true, reason, version: plan.version, change: "steps_replan_requested" } });
    out.push(plan.workOrderId);
    asked.add(`${plan.workOrderId}|${reason}`);
  }
  return out;
}

/**
 * What a replan carries over from the open steps it replaced (`carryOverSteps`): a block the person locked or started moves to the new
 * step (it would otherwise be dropped silently: the schedule keeps a frozen block only while its step exists), and the progress they
 * reported on an old step is kept on the new one (the larger of the two). Timed minutes are the task's (executions), so they stay.
 */
function carryOver(store: CrosslineStore, workspaceId: string, workOrderId: string, replaced: ReadonlyArray<{ id: string; title: string; progressQuarter: number }>,
  next: ReadonlyArray<{ id: string; title: string; executor: string; status: string; progressQuarter: number }>): void {
  if (!replaced.length) return;
  const rename = carryOverSteps(replaced, next);
  if (!rename.size) return;
  const raw = store.getSetting(workspaceId, FROZEN_SETTING);
  if (raw) {
    const list = parseFrozen(raw, new Date(0));
    const moved = remapFrozenSteps(list, workOrderId, rename);
    if (moved.some((item, index) => item.blockId !== list[index]!.blockId)) store.setSetting(workspaceId, FROZEN_SETTING, JSON.stringify(moved));
  }
  const best = new Map<string, number>();
  for (const step of replaced) {
    const target = rename.get(step.id);
    if (target && step.progressQuarter > 0) best.set(target, Math.max(best.get(target) ?? 0, step.progressQuarter));
  }
  for (const [stepId, quarter] of best) {
    const step = next.find((item) => item.id === stepId);
    // Four quarters would mean done: a merged step is not done because one of the parts it absorbed was.
    if (step && step.status === "planned" && quarter > step.progressQuarter)
      store.updateStepProgress(workspaceId, workOrderId, stepId, { progressQuarter: Math.min(3, quarter) }, ownerOf(store, workspaceId), "replan_carry");
  }
}

/**
 * The one replan of every open task to the person's granularity (2026-11-20, near-term doc §3.3 and R2: 「全部按新粒度重规划」): plans
 * with two or more open person's steps are planned again, once, with `GRANULARITY_FEEDBACK`; the task pass picks the requests up a few at
 * a time like any replan, and `carryOver` keeps locked blocks and progress. Marked done for the workspace (`GRANULARITY_REPLAN`).
 */
export const GRANULARITY_REPLAN = "repair.steps-granularity.v1";
// i18n-ignore: the brief for the next plan (model-facing)
export const GRANULARITY_FEEDBACK = "按交付物粒度重排：本人一件交付物一步（如「完成 ECE 555 作业 4」），带首个动作和量化完成标准，提交并入完成标准；只有本人会分开做的部分才拆开。助手的整理收集照做。已完成的步骤保留。";
export function requestGranularityReplans(store: CrosslineStore, workspaceId: string): string[] {
  if (store.getSetting(workspaceId, GRANULARITY_REPLAN)) return [];
  const live = new Set(store.listWorkOrders(workspaceId).filter((order) => PLANNABLE.includes(order.state)).map((order) => order.id));
  const out: string[] = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!live.has(plan.workOrderId)) continue;
    if (plan.steps.filter((step) => step.status === "planned" && step.executor !== "agent").length < 2) continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `task.steps_granularity:${plan.workOrderId}:${plan.version}`,
      type: "task.changed", entityId: plan.workOrderId, payload: { feedback: GRANULARITY_FEEDBACK, reason: "granularity", version: plan.version, change: "steps_replan_requested" } });
    out.push(plan.workOrderId);
  }
  store.setSetting(workspaceId, GRANULARITY_REPLAN, new Date().toISOString());
  return out;
}

/** A milestone this important or more makes its tasks important (the scheduler's own line for 「重要」). */
export const IMPORTANT_WEIGHT = 60;

/**
 * Whether a task is important (docs/review-2026-10-13.md §11): work for a milestone weighed at 60 or more — the person's own weight (the
 * web records it in `milestone.weights`), else the milestone reviewer's (`MilestoneReading.weight`, 2026-11-22; the rule that made every
 * homework date pair important is gone with the point score). Since 2026-11-20 it decides only whether the plan is researched on the web
 * first; which questions reach the person is the model's `ask`.
 */
export function importantByRule(store: CrosslineStore, workspaceId: string, order: { milestoneId: string; payload?: unknown }): boolean {
  if (!order.milestoneId) return false;
  let weights: Record<string, number> = {};
  try { weights = JSON.parse(store.getSetting(workspaceId, "milestone.weights") ?? "{}") as Record<string, number>; } catch { /* none recorded */ }
  const own = weights[order.milestoneId];
  const weight = typeof own === "number" ? own
    : milestoneReadingOf(parseMilestoneRisks(store.getSetting(workspaceId, MILESTONE_RISKS_SETTING))[order.milestoneId])?.weight;
  return (weight ?? 0) >= IMPORTANT_WEIGHT;
}

export function createStepPlanner(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined,
  options: { libraryDir?: string } = {}) {
  return async function plan(workOrderId: string, feedback = "", signal?: AbortSignal): Promise<{ state: "planned"; version: number; warnings: StepWarning[] } | { state: "blocked"; code: string; message: string }> {
    const t = tOfWorkspace(store, workspaceId);
    const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (!order) return { state: "blocked", code: "STEP_PLAN_TASK_NOT_FOUND", message: t("任务不存在") };
    const client = getClient();
    if (!client) return { state: "blocked", code: "CODEX_SUPERVISOR_UNAVAILABLE", message: t("Codex 运行时不可用。") };
    const payload = (order.payload ?? {}) as { humanCore?: Array<{ intent: string }>; automationParts?: Array<{ intent: string }>;
      evidenceContract?: Array<{ description: string }>; materialContract?: Array<{ description: string }>; infoRequests?: unknown[] };
    const milestone = store.listMilestones(workspaceId).filter((item) => item.id === order.milestoneId).at(-1);
    const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === order.projectId);
    const window = taskWindow(store, workspaceId, order);
    const previous = store.getStepPlan(workspaceId, workOrderId);
    const done = (previous?.steps ?? []).filter((step) => step.status !== "planned");
    // Archetypes the curator learned for this workspace are offered beside the built-in ones and checked the same way.
    const learned = learnedArchetypes(store, workspaceId);
    // Short ids for the facts, preferences and lessons given (「[f3]」), so the plan says which it rested on (`usedRefs`).
    const book = createRefBook();
    const grounding = planningContext(store, workspaceId, order, book);
    const tools = aiToolsFor(store, workspaceId);
    const lessons = lessonsFor(store, workspaceId, { lineId: order.identityId, archetypeId: previous?.archetypeId, skill: PLANNER });
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
      // How close the work is to what the person knows (W-154): the planner judges it (FAMILIARITY_JUDGE) unless the person set it.
      familiarity: (({ level, by }) => ({ setByPerson: by === "person" ? level : "" }))(familiarityFor(familiarityBook(store, workspaceId), order, previous?.archetypeId)),
      window,
      // The task's files and the passages chosen for it (docs/context-selection.md): the strongest in full, the rest by their opening line,
      // read further through search_material/read_chunk. On a route that cannot call them, the passages code picked, in full.
      materials: grounding.material.view(),
      // Who this is for: confirmed facts (their background and level, the course's grading and target, what they said about this
      // project), the activities they are good at, the project's dated items, and what they answered to this plan's earlier questions.
      // The workspace's profile and strengths before the project's facts and this plan's answers (the prompt cache). The facts are an
      // index (id, slot, the opening of the value) read whole through read_ledger; on a route without lookups, whole.
      person: { profile: grounding.profile, strengths: grounding.strengths, facts: grounding.factIndex.index, answers: grounding.answers },
      projectDates: grounding.dated,
      archetypes: [...ARCHETYPES, ...learned].map(archetypeBrief),
      // The one table of step types (docs/work-split.md §6): what each role may produce; who does a step follows from its product.
      stepTypes: stepTypesBrief(),
      // The AI tools the person works with (docs/skills-library.md §7): the assistant takes whole steps, the rest name the tool that
      // speeds them, and every estimate is the time with it.
      aiTools: tools.map(aiToolBrief),
      // Corrections and patterns the person has given: for this task, its line, or everything.
      personalPreferences: store.preferenceEntries(workspaceId, [order.identityId, `task:${order.id}`], 15).map((entry) => withRef(book.pref(entry), entry.text)),
      // What earlier work of this line and kind taught (docs/token-economy.md §2): a returned result, a 「部分符合」, a step far over its estimate.
      lessons: lessons.map((lesson) => withRef(book.lesson(lesson), lesson.text)),
      doneSteps: done.map((step) => ({ title: step.title, role: step.role, deliverable: step.deliverable })),
      // What the assistant already produced for this course or project: work that exists, not work to plan again.
      acceptedOutputs: existingOutputs(store, workspaceId, order),
      feedback,
      // Every earlier instruction about this task's steps still holds unless the latest one says otherwise: a replan used to see only
      // the last one, and an answer to a plan question undid the person's 「本人只做推导、解题和自测」 a minute after they said it.
      earlierFeedback: store.listEvents(workspaceId, { type: "task.changed", change: "steps_replan_requested", entityId: workOrderId })
        .map((event) => String((event.payload as { feedback?: string }).feedback ?? "").trim()).filter((text) => text && text !== feedback).slice(-8)
    };
    // The line's own skill and the public skills that fit the task, read beside the planner's: how this work is done shapes the steps.
    const extraSkills = await librarySkillsFor(client, store, workspaceId, order.identityId, { cwd, task: order.intent, ...(options.libraryDir ? { dir: options.libraryDir } : {}) });
    let materialMode: "tools" | "fallback" = "fallback";
    // Any run may reach the web through `web_research` (on by default): once it has, its questions are marked (review of 2026-11-25).
    let browsed = false;
    const result = await runCodexSkill<StepPlan>(client, input, { skillName: PLANNER, cwd, ...(extraSkills.length ? { extraSkills } : {}), redoOnRepair: true,
      // ask_person (ask-tool.ts): what only the person knows and the plan cannot be right without; a run researching on the web has read
      // pages, so its questions are marked and may carry no link.
      optionalTools: { tools: withAskTool(mergeTools(grounding.material.tools, grounding.factIndex.tools), { store, workspaceId, skill: PLANNER,
          ref: { kind: "task", id: workOrderId }, identityId: order.identityId, projectId: order.projectId, dueBy: window.dueBy, title: taskTitleOf(order),
          untrusted: () => research || browsed }), onMode: (mode) => { materialMode = mode; },
        instructions: "`materials.passages` are the passages that matched this task, in full; `materials.candidates` are more, by their opening line; "
          + "`materials.files` are the files they come from. Read the candidates you need with read_chunk(id), and find what is missing (a lecture "
          + "list, the problem set, the rubric) with search_material before you count units. A unit quotes a passage you read, under that passage's doc id. "
          + "`person.facts` is an index of the person's facts for this task: an id, the slot, the value's opening. " + READ_LEDGER_INSTRUCTIONS
          + " " + ASK_PERSON_INSTRUCTIONS + " Here ask_person is for a fact of the person's without which the steps themselves would be wrong now "
          + "(blocking); a question the plan can carry on an assumption until the weekly review stays in questions, and is never asked both ways.",
        withoutTools: (value) => ({ ...(value as object), materials: grounding.material.fallback(),
          person: { ...(value as { person: object }).person, facts: grounding.person } }) },
      /* i18n-ignore-start: model instructions */
      developerInstructions: "Write this task's steps as the crossline-task-planner:steps Skill describes and return only the requested JSON. The steps are "
        + "what the person sees on the task and what the scheduler puts on the calendar. Read `materials` first and count the units from them, each quoting "
        + "its file verbatim. The person's steps are whole deliverables: one step per thing the person hands in or finishes (「完成 ECE 555 作业 4」), "
        + "split only where the person would do the parts apart (two different deliverables, or two stretches with someone's feedback between them); "
        + "handing in is part of the done criterion (「4 题写完并已在 Gradescope 提交」), never a step of its own. Each person's step has a quantified done "
        + "criterion, a why naming what it trains or decides, and a firstAction of five minutes or less; the estimate still counts every part. Collecting, "
        + "compiling, listing and filing are the assistant's steps (owner assistant), and what needs one fact only the person holds is owner ask with "
        + "that question in questions. Every step names its product from stepTypes (material, output, ability, action): who does it follows from "
        + "that, and only ability steps get a tutorial. needs lists only material the person's files and folders do not cover and that something on "
        + "record says the person has (basis: the fact, file or task wording); the app looks for it on the web first and asks the person last. "
        + "No step only reviews the assistant's output, writes an acceptance checklist or defines scope. "
        + "The rationale is a few short sentences for the person: what the plan rests on, never the input's keys, ids or how units were counted. "
        + "Questions: write one only for what neither the material nor person.facts settles, with 2–6 concrete options, the likeliest first, "
        + "assume (the option the plan follows meanwhile), neededBy (the step that needs the answer) and ifWrong (minutes redone, harm: none, "
        + "quality, deadline or external, and fixable: before_step, after_submit or never). Set ask true only where a wrong assumption matters: "
        + "it bears on a milestone, has consequences outside (a submission, someone else), only the person can decide it, or cannot be undone; "
        + "otherwise ask false and the plan goes on with assume. There is no limit on how many; the person answers them in the weekly review. "
        + FAMILIARITY_JUDGE + FAMILIARITY_INSTRUCTIONS + " "
        + "usedRefs lists the bracketed ids ([f3], [p1], [l2]) of the facts, preferences and lessons the plan really rests on, [] when none.",
      /* i18n-ignore-end */
      // The prompt cache (docs/token-economy.md §2.5): what every plan of this workspace shares first, then the line's and the project's,
      // then this task; what only this run is told comes after the input instead of in the developer instructions.
      stableKeys: ["version", "archetypes", "stepTypes", "aiTools", "person", "personalPreferences", "lessons", "projectDates", "milestone"],
      runNote: (libraryInstruction(extraSkills)
        + (feedback ? " Apply the feedback: it is what the reviewer or the person asked to change; earlierFeedback still holds unless it contradicts it." : "")
        + (research ? " research is true: search the web for this task's background and the best known way to do it before planning, as the Skill's research section says." : "")).trim(),
      ...(research ? { webResearch: true } : {}), onWebResearch: () => { browsed = true; },
      outputSchema: stepPlanSchema(learned.map((archetype) => archetype.id)), prepareInput: (value) => value,
      validateOutput: (output) => {
        const shaped = validateStepPlanShape(output, learned);
        // Units are the plan's footing: each must quote its own file verbatim, or the plan is sent back to read the file again.
        const bad = unverifiedUnits(shaped.units ?? [], grounding.material.documents());
        // i18n-ignore: a repair message to the model
        if (bad.length) throw Object.assign(new Error("STEP_UNIT_UNVERIFIED"), { detail: `这些内容单元的 quote 在所注明的文件里找不到逐字原文：${bad.slice(0, 5)
          .map((unit) => `「${unit.title}」(${unit.docId})`).join("、")}。只引用 materials 中逐字出现的行；文件里没有的内容，写进 questions 问本人。` });
        return shaped;
      },
      // After the repairs, a plan whose only fault is a few unverifiable units is kept without them.
      softAccept: (rejection, output) => {
        if (rejection.message !== "STEP_UNIT_UNVERIFIED") return undefined;
        try { const shaped = validateStepPlanShape(output, learned); const bad = new Set(unverifiedUnits(shaped.units ?? [], grounding.material.documents()).map((unit) => unit.id));
          return { ...shaped, units: (shaped.units ?? []).filter((unit) => !bad.has(unit.id)) }; } catch { return undefined; }
      },
      onAudit: () => {}, ...(signal ? { signal } : {}), timeoutMs: 60 * 60_000 });
    console.info(JSON.stringify({ type: "context.selected", skill: PLANNER, workOrderId, mode: materialMode, ...grounding.material.stats(materialMode),
      factChars: JSON.stringify((materialMode as "tools" | "fallback") === "tools" ? grounding.factIndex.index : grounding.person).length, ...grounding.factIndex.stats() }));
    if (!result.ok) {
      if (!/^(SKILL_|CODEX_)/.test(result.blocker.code)) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
        idempotencyKey: `task.steps_blocked:${workOrderId}:${Date.now()}`, type: "task.changed", entityId: workOrderId,
        payload: { code: result.blocker.code, message: result.blocker.message.slice(0, 300), change: "steps_blocked" } });
      return { state: "blocked", code: result.blocker.code, message: result.blocker.message };
    }
    // Every account has the assistant in one mode or another (assistantMode: the owner's shell, else Crossline's tools on any model), so
    // collecting and filing stay the assistant's on the hosted beta too; tying this to the shell turned every such step into the person's.
    // A drill form (订正, 错题本, 背诵, 打卡 …) stays only when the person's own words back it (drill-forms.ts, 2026-11-10).
    const drill = drillBackingFor(store, workspaceId, { captureId: order.id, scopes: [order.identityId, `task:${order.id}`] });
    const { plan: shapedPlan, warnings: fixed } = normalizeStepPlan(result.output, tools.map((tool) => tool.name),
      { assistant: true, ownerPreferences: ownerPreferencesFor(store, workspaceId, order.identityId), locale: localeOf(store, workspaceId),
        drillBacking: drill.backing, methodKnown: drill.methodKnown });
    const normalized = result.output.importance ? { ...shapedPlan, importance: result.output.importance } : shapedPlan;
    // A step the model marked not external that the word list reads as external: the model stands, the disagreement is logged.
    recordOwnerDisputes(workspaceId, PLANNER, normalized.steps.map((step) => ({ id: `${workOrderId}:${step.id}`, title: step.title,
      ...(typeof step.external === "boolean" ? { external: step.external } : {}) })));
    // Steps must not start before the window or end after it: clamp, the reviewer sees the warning.
    // What normalization already fixed (rescaled shares, a missing estimate filled in, an unknown dependency dropped) needs no judgement;
    // only the rest goes to the reviewer.
    const warnings = [...fixed.filter((warning) => !AUTO_FIXED.has(warning.code)), ...stepPlanWarnings(normalized, window, learned)];
    const saved = store.saveStepPlan(workspaceId, workOrderId, normalized, ownerOf(store, workspaceId), feedback ? "revised" : "planned");
    carryOver(store, workspaceId, workOrderId, (previous?.steps ?? []).filter((step) => step.status === "planned"), saved.steps);
    // A saved plan is an answer that took effect: what it cited counts as used.
    store.markUsed(workspaceId, book.resolve(result.output.usedRefs));
    // A task nobody judged the completion of yet (one from a course's dates, or written before the field) takes the planner's judgement;
    // one the analysis or backplanner already judged keeps theirs, and the person's own choice is `completionMode`, untouched here.
    const completion = readModelCompletion(result.output.completion);
    const current = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (completion && current && !readModelCompletion((current.payload as { completion?: unknown } | undefined)?.completion))
      store.saveWorkOrder({ ...current, payload: { ...((current.payload ?? {}) as object), completion } });
    // A deliverable with no electronic form is not read for acceptance (deliverable-check.ts); the outside result settles it.
    const offline = result.output.offline;
    const latest = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (typeof offline === "boolean" && latest && (latest.payload as { offline?: boolean } | undefined)?.offline !== offline)
      store.saveWorkOrder({ ...latest, payload: { ...((latest.payload ?? {}) as object), offline } });
    // Which questions reach the person is the model's call (docs/plans/attention-ledger-1120.md §7.1, 2026-11-20): each says what a
    // wrong assumption costs and whether it is worth asking (`ask`). The rest are settled as their assumption at once. No per-task cap and
    // no importance rule any more (the cap of two and the weight-60 rule asked about the wrong things and hid the costly ones), and a
    // replan no longer assumes every new question: one already answered or settled has its slot fact and is not asked again; a new
    // critical one is asked like any other. What the task's own files settle is the model's call too (`ask` false, the Skill's section 4):
    // a word list in code used to pick such questions out by their wording (2026-11-22, removed).
    assumeAnswers(store, workspaceId, order, normalized.questions.filter((question) => question.ask !== true));
    if (warnings.length) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
      idempotencyKey: `validation.warned:task_steps:${workOrderId}:${saved.version}`, type: "validation.changed", entityId: workOrderId,
      payload: { subject: "task_steps", version: saved.version, warnings, revised: Boolean(feedback), change: "warned" } });
    return { state: "planned", version: saved.version, warnings };
  };
}

/**
 * Questions already stored are settled by the same rule as new ones (2026-11-20): one the model did not mark worth asking — every
 * question of a plan written before `ask` existed — is settled as its assumption. Runs on the task pass.
 */
export function settleOldQuestions(store: CrosslineStore, workspaceId: string): string[] {
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  const settled: string[] = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    const order = orders.get(plan.workOrderId);
    if (!order || !plan.questions.length) continue;
    const assumed = plan.questions.filter((question) => question.ask !== true);
    const fresh = unanswered(store, workspaceId, order, assumed);
    if (assumed.length) assumeAnswers(store, workspaceId, order, assumed);
    if (fresh.length) settled.push(plan.workOrderId);
  }
  return settled;
}

/**
 * An asked question nobody answered by the day its answer is needed (`questionNeededDay`) is settled as its assumption, and the person
 * is told once in the bell with the task to change it on (§7.1 point 5: 「到 neededBy 还没答，就按 assume 做，并在铃铛里说一声」). The
 * answer stays changeable on the task, which replans it. Returns the work order ids settled.
 */
export function assumeAtNeededDay(store: CrosslineStore, workspaceId: string, today: string, now = new Date()): string[] {
  const t = tOfWorkspace(store, workspaceId);
  const open = new Set(["approved", "preparing", "ready_for_human", "active"]);
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => open.has(order.state)).map((order) => [order.id, order]));
  let starts: Record<string, string> = {};
  try { starts = JSON.parse(store.getSetting(workspaceId, ORDER_STARTS_SETTING) ?? "{}") as Record<string, string>; } catch { /* none recorded */ }
  const said: string[] = [];
  const settled: string[] = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    const order = orders.get(plan.workOrderId);
    if (!order) continue;
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate;
    const late = unanswered(store, workspaceId, order, plan.questions.filter((question) => question.ask === true && question.options.length > 0))
      .filter((question) => { const day = questionNeededDay(question, plan.steps, starts[order.id], due); return Boolean(day) && day <= today; });
    if (!late.length) continue;
    assumeAnswers(store, workspaceId, order, late);
    settled.push(order.id);
    for (const question of late) said.push(`- ${t("「{{task}}」{{question}} → {{answer}}", { task: taskTitleOf(order), question: question.text, answer: assumedAnswer(question) })}`);
  }
  if (said.length) sayToPerson(store, workspaceId, [t("这些问题到了要用答案的时候还没回答，已按建议的假设先做："), ...said.slice(0, 8),
    t("答案不对的话，在任务详情里改，任务会按新答案重排。")].join("\n"), "step_question_assumed", `assumed:${settled.join(",")}:${today}`,
    settled.slice(0, 1).map((id) => ({ label: t("打开任务"), href: `/workbench/${encodeURIComponent(id)}` })), now);
  return settled;
}

/** The questions of a task with no answer or assumption recorded yet (an answer is per project and question). */
function unanswered(store: CrosslineStore, workspaceId: string, order: { projectId: string }, questions: StepPlan["questions"]): StepPlan["questions"] {
  const answered = new Set(store.listProfileFacts(workspaceId).filter((fact) => fact.projectId === order.projectId && fact.slot.startsWith(STEP_ANSWER_SLOT)).map((fact) => fact.slot));
  return questions.filter((question) => !answered.has(stepAnswerSlot(question.text)));
}

/** Records each question's assumption (`assume`, else its first option) under the question's answer slot: `假设：【question】option`. */
function assumeAnswers(store: CrosslineStore, workspaceId: string, order: { identityId: string; projectId: string }, questions: StepPlan["questions"]): void {
  const answered = new Set(store.listProfileFacts(workspaceId).filter((fact) => fact.slot.startsWith(STEP_ANSWER_SLOT)).map((fact) => `${fact.projectId}|${fact.slot}`));
  for (const question of questions) {
    const slot = stepAnswerSlot(question.text);
    const assumed = assumedAnswer(question);
    if (answered.has(`${order.projectId}|${slot}`) || !assumed) continue;
    // i18n-ignore: the stored assumption form, read back by code and by the next plan
    const value = `假设：【${question.text}】${assumed}`;
    store.upsertProfileFact({ workspaceId, identityId: order.identityId, projectId: order.projectId, slot, value,
      status: "inferred", sourceRef: "", sourceQuote: "", updatedAt: new Date().toISOString() });
  }
}

/** Progress reports nobody has read yet (`task.progress_reported` without a `task.progress_judged` for the same report). */
export function reportsAwaitingJudgement(store: CrosslineStore, workspaceId: string, limit = 2) {
  const judged = new Set(store.listEvents(workspaceId, { type: "task.changed", change: "progress_judged" }).map((event) => (event.payload as { reportId: string }).reportId));
  return store.listEvents(workspaceId, { type: "task.changed", change: "progress_reported" })
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
      idempotencyKey: `task.progress_judged:${report.reportId}`, type: "task.changed", entityId: report.workOrderId,
      payload: { reportId: report.reportId, ...(assessment ? { summary: assessment.summary } : { code }), change: "progress_judged" } });
    if (!order) { done(null, "WORK_ORDER_NOT_FOUND"); return undefined; }
    const steps = store.getStepPlan(workspaceId, order.id)?.steps ?? [];
    const milestone = store.listMilestones(workspaceId).filter((item) => item.id === order.milestoneId).at(-1);
    const criteria = milestone?.successCriteria ?? [];
    const input = { version: "crossline.progress-judge.v1", task: order.intent, report: { text: report.text },
      steps: steps.map((step) => ({ id: step.id, title: step.title, doneCriterion: step.doneCriterion, quarters: step.progressQuarter, status: step.status })),
      criteria: criteria.map((criterion) => ({ id: criterion.id, statement: criterion.statement })) };
    const result = await runCodexSkill<ProgressAssessment>(client, input, { skillName: JUDGE, cwd,
      developerInstructions: "Read the person's progress report against this task's steps and standards, as the crossline-evidence-judge:progress Skill describes, "
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
      idempotencyKey: `criteria.assessed:${report.reportId}`, type: "task.changed", entityId: order.id,
      payload: { reportId: report.reportId, criteria: result.output.criteria, change: "criteria_assessed" } });
    done(result.output);
    return result.output;
  };
}

/** Warnings no reviewer has looked at yet, oldest first: a task's step plan or a candidate cross-line relation. */
export function warningsAwaitingReview(store: CrosslineStore, workspaceId: string, limit = 1) {
  const reviewed = new Set(store.listEvents(workspaceId, { type: "validation.changed", change: "reviewed" })
    .map((event) => `${event.entityId}:${(event.payload as { version?: number }).version}`));
  return store.listEvents(workspaceId, { type: "validation.changed", change: "warned" })
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
      idempotencyKey: `validation.reviewed:${item.entityId}:${item.version}`, type: "validation.changed", entityId: item.entityId,
      payload: { subject: item.subject, version: item.version, ...verdict, change: "reviewed" } });
    const input = item.subject === "milestone_relation" ? relationSubject(store, workspaceId, item)
      : item.subject === "milestone_line" ? lineSubject(store, workspaceId, item)
      : item.subject === "analysis" ? analysisSubject(store, workspaceId, item) : stepSubject(store, workspaceId, item);
    if (!input) { record({ verdict: "dismiss", notes: "已被新版本取代" }); return undefined; } // i18n-ignore: the ledger's own note, not shown
    const result = await runCodexSkill<ValidationReview>(client, input, { skillName: REVIEWER, cwd,
      developerInstructions: REVIEW_INSTRUCTIONS[item.subject] ?? REVIEW_INSTRUCTIONS.task_steps!,
      outputSchema: VALIDATION_REVIEW_SCHEMA, prepareInput: () => input, validateOutput: validateValidationReview,
      onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (!result.ok) return undefined;
    const verdict: ValidationReview = item.revised && result.output.verdict === "redo"
      // i18n-ignore: the ledger's own note, not shown
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
    ? `${measure.comparator === "lte" ? "≤" : "≥"} ${measure.value}${measure.unit}${typeof measure.bareLine === "number" ? `（刚好够：${measure.bareLine}）` : ""}` : ""; // i18n-ignore: the reviewer's input
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
