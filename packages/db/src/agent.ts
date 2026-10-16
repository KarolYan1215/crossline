import {
  AGENT_CATEGORIES, AUTO_HANDOFF_SETTING, DISPATCH_STATES, GROWN_LIBRARY_SETTING, agentChains, isAgentCategory, isCourse, planAssistantTask, readGrownLibrary,
  tFor, type AgentCategory, type AgentChain, type AgentChainMarks, type AgentRunRow, type AssistantPlan
} from "@crossline/core";
import { readLocale } from "./locale";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { latestFileDates, type CrosslineStore } from "./index";

/**
 * What the ledger knows about the assistant: which kinds of work the person has said yes to, how far each is trusted, and every task's
 * life from request to review. Folded from events, so the worker (which writes them) and the web app (which reads them and records
 * the person's decisions) never need to share a process — the ledger is the meeting place.
 */
export type CategoryState = { approvedAt: string; trust: "review_all" | "auto_checked"; cleanRuns: number };
/** After this many accepted, fully checked results in a row a kind is trusted on its checks (and drops back at the first bad one). */
export const CLEAN_RUNS_TO_TRUST = 5;
const CATEGORIES = "agent.categories";
const DECLINED = "agent.categories.declined";
const PAUSED = "agent.paused";

export function readCategories(store: CrosslineStore, workspaceId: string): Partial<Record<AgentCategory, CategoryState>> {
  try { return JSON.parse(store.getSetting(workspaceId, CATEGORIES) ?? "{}") as Partial<Record<AgentCategory, CategoryState>>; } catch { return {}; }
}
export function declinedCategories(store: CrosslineStore, workspaceId: string): AgentCategory[] {
  try { return (JSON.parse(store.getSetting(workspaceId, DECLINED) ?? "[]") as unknown[]).filter(isAgentCategory); } catch { return []; }
}
export function approveCategory(store: CrosslineStore, workspaceId: string, category: AgentCategory, now = new Date()): void {
  const all = readCategories(store, workspaceId);
  store.setSetting(workspaceId, DECLINED, JSON.stringify(declinedCategories(store, workspaceId).filter((item) => item !== category)));
  if (all[category]) return;
  store.setSetting(workspaceId, CATEGORIES, JSON.stringify({ ...all, [category]: { approvedAt: now.toISOString(), trust: "review_all", cleanRuns: 0 } }));
}
export function declineCategory(store: CrosslineStore, workspaceId: string, category: AgentCategory): void {
  const all = readCategories(store, workspaceId);
  delete all[category];
  store.setSetting(workspaceId, CATEGORIES, JSON.stringify(all));
  const declined = declinedCategories(store, workspaceId);
  if (!declined.includes(category)) store.setSetting(workspaceId, DECLINED, JSON.stringify([...declined, category]));
}
/**
 * The settings page's three-way choice for a kind of work: off (the assistant never does it), review (it may start, every result is
 * the person's to accept — earned trust is kept), auto (a result whose own checks all passed counts as done, the person spot-checks).
 * A rejected or failed result still drops `auto` back to review, as `recordReview` does.
 */
export type CategoryMode = "off" | "review" | "auto";
export function setCategoryMode(store: CrosslineStore, workspaceId: string, category: AgentCategory, mode: CategoryMode, now = new Date()): void {
  if (mode === "off") { declineCategory(store, workspaceId, category); return; }
  approveCategory(store, workspaceId, category, now);
  const all = readCategories(store, workspaceId);
  const current = all[category]!;
  store.setSetting(workspaceId, CATEGORIES, JSON.stringify({ ...all, [category]: { ...current, trust: mode === "auto" ? "auto_checked" : "review_all" } }));
}
export const categoryMode = (state: CategoryState | undefined): CategoryMode => !state ? "off" : state.trust === "auto_checked" ? "auto" : "review";
export const isPaused = (store: CrosslineStore, workspaceId: string): boolean => store.getSetting(workspaceId, PAUSED) === "1";
export const setPaused = (store: CrosslineStore, workspaceId: string, paused: boolean): void => store.setSetting(workspaceId, PAUSED, paused ? "1" : "0");
/** 「自动交给 Agent」 (`AUTO_HANDOFF_SETTING` in core): off unless the person turned it on. */
export const isAutoHandoff = (store: CrosslineStore, workspaceId: string): boolean => store.getSetting(workspaceId, AUTO_HANDOFF_SETTING) === "1";
export const setAutoHandoff = (store: CrosslineStore, workspaceId: string, on: boolean): void => store.setSetting(workspaceId, AUTO_HANDOFF_SETTING, on ? "1" : "0");

/** The person's verdict on a result. An accepted one earns trust; a rejected one, or one that failed its own checks, takes it away. */
export function recordReview(store: CrosslineStore, workspaceId: string, category: AgentCategory, accepted: boolean): CategoryState | undefined {
  const all = readCategories(store, workspaceId);
  const current = all[category];
  if (!current) return undefined;
  const cleanRuns = accepted ? current.cleanRuns + 1 : 0;
  const next: CategoryState = { ...current, cleanRuns, trust: accepted && cleanRuns >= CLEAN_RUNS_TO_TRUST ? "auto_checked" : "review_all" };
  store.setSetting(workspaceId, CATEGORIES, JSON.stringify({ ...all, [category]: next }));
  return next;
}

export type AgentTaskStatus = "running" | "stale" | "blocked" | "needs_review" | "accepted" | "rejected";
export type AgentTaskRow = {
  taskId: string; title: string; category: AgentCategory; workOrderId: string; requestedAt: string; status: AgentTaskStatus;
  directory: string; durationMs: number; commands: number; denied: number; artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  needsHuman: number; checksPassed: boolean; inputsModified: string[]; blockerCode: string;
  /** Why it stopped, in the runner's words (rows from before this was stored have only the code). */
  blockerMessage: string; reviewNote: string;
  /** The order took effect by itself (no one clicked approve) before the assistant picked it up. */
  autoApproved: boolean;
  /** The whole order was handed over: an accepted result is delivered as the order's evidence (`deliverAgentResult`). */
  delegated: boolean;
  /** One step of the order was handed over: an accepted result marks that step done. */
  stepId: string;
  /** When it stopped (blocked), for the retry backoff. */
  endedAt?: string;
  /** Who started it: the person (「交给 Agent」, a retry they asked for) or the system. */
  by: "person" | "system";
  /** Rules of what the guard refused it (blocked runs that recorded them). */
  deniedRules: string[];
  /** Reads of a site behind the person's login that were refused (a security check, a login page). */
  siteRefusals: number;
  /** A run stopped part way whose files were offered for review as they were (`salvageStoppedRun`). */
  partial: boolean;
};
/**
 * What a step delivers, as a comparison key: the step part of a run's `「task」 · 「step」` title, without case, spaces or punctuation.
 * Two tasks of one course both planned 「汇集课程讲义、作业与样题，形成材料目录」; the key is what makes them the same work.
 */
export const deliverableKey = (title: string): string => (title.split(" · ").at(-1) ?? title).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/**
 * The assistant's runs for any work order of a project, of the given statuses: what already exists (or is being made) for that course
 * or project, so a sibling task neither plans nor dispatches it again. Accepted outputs used to be shared within one order only.
 */
export function projectAgentOutputs(store: CrosslineStore, workspaceId: string, projectId: string,
  statuses: AgentTaskStatus[] = ["accepted", "needs_review", "running"]): AgentTaskRow[] {
  if (!projectId) return [];
  const orders = new Set(store.listWorkOrders(workspaceId).filter((order) => order.projectId === projectId).map((order) => order.id));
  return listAgentTasks(store, workspaceId).filter((task) => orders.has(task.workOrderId) && statuses.includes(task.status));
}
/** A run with no outcome after this long was lost with the process that held it, not still going. */
const STALE_AFTER_MS = 8 * 3_600_000;

export function listAgentTasks(store: CrosslineStore, workspaceId: string, now = new Date()): AgentTaskRow[] {
  const rows = new Map<string, AgentTaskRow>();
  const events = store.listEvents(workspaceId, { type: ["agent.task.requested", "agent.task.completed", "agent.task.blocked", "agent.task.reviewed"] });
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    const taskId = event.entityId;
    if (event.type === "agent.task.requested") {
      rows.set(taskId, { taskId, title: String(p.title ?? ""), category: isAgentCategory(p.category) ? p.category : "read_research_organize", workOrderId: String(p.workOrderId ?? ""),
        requestedAt: event.createdAt, status: "running", directory: "", durationMs: 0, commands: 0, denied: 0, artifacts: [], needsHuman: 0, checksPassed: false, inputsModified: [], blockerCode: "", blockerMessage: "", reviewNote: "", autoApproved: p.autoApproved === true,
        delegated: p.delegated === true, stepId: typeof p.stepId === "string" ? p.stepId : "", by: p.by === "person" ? "person" : "system", deniedRules: [],
        siteRefusals: 0, partial: false });
      continue;
    }
    const row = rows.get(taskId);
    if (!row) continue;
    // Half-written workflow drafts from stopped growing runs were once offered for review (2026-10-14); they are not results.
    if (event.type === "agent.task.completed" && p.partial === true && taskId.startsWith("grow-")) continue;
    if (event.type === "agent.task.completed") {
      Object.assign(row, { status: p.reviewRequired === false ? "accepted" : "needs_review", directory: String(p.directory ?? ""), durationMs: Number(p.durationMs ?? 0),
        commands: Number(p.commands ?? 0), denied: Number(p.denied ?? 0), artifacts: Array.isArray(p.artifacts) ? p.artifacts as AgentTaskRow["artifacts"] : [],
        needsHuman: Number(p.needsHuman ?? 0), checksPassed: p.checksPassed === true, inputsModified: Array.isArray(p.inputsModified) ? p.inputsModified.map(String) : [],
        partial: p.partial === true });
    } else if (event.type === "agent.task.blocked") {
      Object.assign(row, { status: "blocked", blockerCode: String(p.code ?? ""), blockerMessage: String(p.message ?? ""), durationMs: Number(p.durationMs ?? 0), commands: Number(p.commands ?? 0), denied: Number(p.decisions ?? 0),
        endedAt: event.createdAt, deniedRules: Array.isArray(p.deniedRules) ? p.deniedRules.map(String) : [], siteRefusals: Number(p.siteRefusals ?? 0),
        ...(typeof p.directory === "string" && p.directory ? { directory: p.directory } : {}) });
    } else if (event.type === "agent.task.reviewed") {
      row.status = p.decision === "accepted" ? "accepted" : "rejected";
      row.reviewNote = String(p.note ?? "");
    }
  }
  for (const row of rows.values()) {
    if (row.status === "running" && now.getTime() - Date.parse(row.requestedAt) > STALE_AFTER_MS) row.status = "stale";
  }
  return [...rows.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** The person's verdict on a finished task: records it, and moves the kind's trust accordingly. */
export function reviewAgentTask(store: CrosslineStore, workspaceId: string, taskId: string, decision: "accepted" | "rejected", note = ""):
  { ok: true; trust: CategoryState | undefined } | { ok: false; code: "TASK_NOT_FOUND" | "TASK_NOT_REVIEWABLE" } {
  const task = listAgentTasks(store, workspaceId).find((row) => row.taskId === taskId);
  if (!task) return { ok: false, code: "TASK_NOT_FOUND" };
  if (task.status !== "needs_review" && task.status !== "accepted") return { ok: false, code: "TASK_NOT_REVIEWABLE" };
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId) return { ok: false, code: "TASK_NOT_FOUND" };
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `agent:reviewed:${taskId}:${Date.now()}`, type: "agent.task.reviewed", entityId: taskId,
    payload: { taskId, decision, note: note.slice(0, 500), category: task.category } });
  // A result that failed its own checks, or left originals changed, does not count towards trust even if the person is kind.
  const clean = decision === "accepted" && task.checksPassed && task.inputsModified.length === 0;
  const trust = recordReview(store, workspaceId, task.category, clean);
  // Accepting a delegated task's result is accepting it as the work: it goes to the gate as the order's evidence.
  if (decision === "accepted") deliverAgentResult(store, workspaceId, taskId);
  // A step it did is that step done.
  if (decision === "accepted" && task.stepId && task.workOrderId) {
    try { store.updateStepProgress(workspaceId, task.workOrderId, task.stepId, { status: "done" }, ownerId, "agent"); } catch { /* the step was replanned away */ }
  }
  return { ok: true, trust };
}

/**
 * Hands a delegated task's files in as its work order's evidence (`agent.delivered`), which puts the order in front of the milestone
 * gate like any other submission. Only an accepted result (reviewed by the person, or one the kind's earned trust let through on its own
 * checks) and only while the person has not started the order themselves. Delivered once per task.
 */
export function deliverAgentResult(store: CrosslineStore, workspaceId: string, taskId: string): { delivered: boolean; code?: string } {
  const task = listAgentTasks(store, workspaceId).find((row) => row.taskId === taskId);
  if (!task?.delegated || !task.workOrderId) return { delivered: false, code: "NOT_DELEGATED" };
  if (task.status !== "accepted") return { delivered: false, code: "NOT_ACCEPTED" };
  if (!task.artifacts.length || !task.directory) return { delivered: false, code: "NO_ARTIFACTS" };
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === task.workOrderId);
  if (!order || !DISPATCH_STATES.has(order.state)) return { delivered: false, code: "ORDER_NOT_DELIVERABLE" };
  const evidence = task.artifacts.map((artifact) => ({ kind: "file" as const, uri: pathToFileURL(path.join(task.directory, artifact.path)).href,
    description: tFor(readLocale(store, workspaceId))("助手产出：{{path}}", { path: artifact.path }) }));
  const result = store.transitionWorkOrder(workspaceId, order.id, { type: "agent.delivered", taskId }, `agent-delivered:${taskId}`, { evidence });
  return { delivered: result.changed };
}

/** A kind of work the assistant would like to start but has not been allowed to, waiting for the person. */
export function requestCategory(store: CrosslineStore, workspaceId: string, category: AgentCategory, workOrderId: string, why: string): void {
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId || readCategories(store, workspaceId)[category] || declinedCategories(store, workspaceId).includes(category)) return;
  if (pendingCategoryRequests(store, workspaceId).some((item) => item.category === category)) return;
  const round = store.listEvents(workspaceId, { type: "agent.category.requested", entityId: category }).length;
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `agent:category:requested:${category}:${round}`, type: "agent.category.requested", entityId: category,
    payload: { category, workOrderId, why: why.slice(0, 300) } });
}
export function pendingCategoryRequests(store: CrosslineStore, workspaceId: string): Array<{ category: AgentCategory; workOrderId: string; why: string }> {
  const approved = readCategories(store, workspaceId);
  const declined = new Set(declinedCategories(store, workspaceId));
  const seen = new Map<AgentCategory, { category: AgentCategory; workOrderId: string; why: string }>();
  for (const event of store.listEvents(workspaceId, { type: "agent.category.requested" })) {
    const p = event.payload as { category?: unknown; workOrderId?: unknown; why?: unknown };
    if (isAgentCategory(p.category) && !approved[p.category] && !declined.has(p.category)) seen.set(p.category, { category: p.category, workOrderId: String(p.workOrderId ?? ""), why: String(p.why ?? "") });
  }
  return [...seen.values()];
}

/** A command or tool call the guard says to ask the person about, held until they answer or time runs out (then it is declined). */
export type AgentApprovalRow = { id: string; taskId: string; kind: string; subject: string; rule: string; reason: string; requestedAt: string };
export function requestAgentApproval(store: CrosslineStore, workspaceId: string, taskId: string, request: { kind: string; subject: string; rule: string; reason: string }): string | undefined {
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId) return undefined;
  const id = `ap-${Math.random().toString(36).slice(2, 10)}`;
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `agent:approval:requested:${id}`, type: "agent.approval.requested", entityId: id,
    payload: { id, taskId, kind: request.kind, subject: request.subject.slice(0, 600), rule: request.rule, reason: request.reason.slice(0, 300) } });
  return id;
}
export function decideAgentApproval(store: CrosslineStore, workspaceId: string, id: string, decision: "accepted" | "declined"): boolean {
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  if (!ownerId || !store.listEvents(workspaceId, { type: "agent.approval.requested", entityId: id }).length) return false;
  return store.appendEvent({ ownerId, workspaceId, idempotencyKey: `agent:approval:decided:${id}`, type: "agent.approval.decided", entityId: id, payload: { id, decision } }).inserted;
}
export function agentApprovalDecision(store: CrosslineStore, workspaceId: string, id: string): "accepted" | "declined" | undefined {
  const decided = store.listEvents(workspaceId, { type: "agent.approval.decided", entityId: id })[0];
  const value = (decided?.payload as { decision?: unknown } | undefined)?.decision;
  return value === "accepted" || value === "declined" ? value : undefined;
}
export function pendingAgentApprovals(store: CrosslineStore, workspaceId: string, now = new Date(), maxAgeMs = 15 * 60_000): AgentApprovalRow[] {
  const decided = new Set(store.listEvents(workspaceId, { type: "agent.approval.decided" }).map((event) => event.entityId));
  return store.listEvents(workspaceId, { type: "agent.approval.requested" })
    .filter((event) => !decided.has(event.entityId) && now.getTime() - Date.parse(event.createdAt) <= maxAgeMs)
    .map((event) => ({ ...(event.payload as Omit<AgentApprovalRow, "requestedAt">), requestedAt: event.createdAt }));
}

/**
 * Whether a work order can go to the assistant, and in what words: the same reading the worker dispatches from and the Workbench shows,
 * so the button never promises what the worker would refuse.
 */
export function assistantPlanFor(store: CrosslineStore, workspaceId: string, orderId: string):
  { ok: true; plan: Extract<AssistantPlan, { fit: true }>; title: string; projectId: string } | { ok: false; code: "ORDER_NOT_FOUND" | "ORDER_NOT_DISPATCHABLE" | "NOTHING_FOR_ASSISTANT"; message: string } {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
  const locale = readLocale(store, workspaceId);
  const t = tFor(locale);
  if (!order) return { ok: false, code: "ORDER_NOT_FOUND", message: t("找不到这个任务。") };
  if (order.tombstone || !DISPATCH_STATES.has(order.state)) {
    return { ok: false, code: "ORDER_NOT_DISPATCHABLE", message: t("该任务不在可交给助手的阶段（需已批准且尚未开始）。") };
  }
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.projectId === order.projectId);
  const { dates, undated } = latestFileDates(store, workspaceId);
  const milestoneTitle = store.listMilestones(workspaceId).find((milestone) => milestone.id === order.milestoneId)?.title;
  const plan = planAssistantTask(order, { projectIsCourse: isCourse(order.projectId, facts, dates, undated), ...(milestoneTitle ? { milestoneTitle } : {}), locale });
  if (!plan.fit) return { ok: false, code: "NOTHING_FOR_ASSISTANT", message: plan.reason };
  return { ok: true, plan, title: order.intent, projectId: order.projectId };
}

/**
 * The person's answers about stopped or finished runs, as the chain rule reads them: a retry they asked for (with their words, and the
 * checks or items to redo), and a chain they closed (they do it themselves, or it is dropped).
 */
export function agentChainMarks(store: CrosslineStore, workspaceId: string): AgentChainMarks {
  return {
    retries: store.listEvents(workspaceId, { type: "agent.retry_requested" }).map((event) => {
      const p = event.payload as { note?: unknown; approach?: unknown; only?: unknown };
      const only = Array.isArray(p.only) ? p.only.map(String).filter(Boolean) : [];
      const note = [typeof p.note === "string" ? p.note : "", only.length ? `只重做这些：${only.join("；")}` /* i18n-ignore: told to the next run */ : ""].filter(Boolean).join("\n");
      return { taskId: event.entityId, at: event.createdAt, note, ...(typeof p.approach === "string" && p.approach ? { approach: p.approach } : {}) };
    }),
    closed: store.listEvents(workspaceId, { type: "agent.blocked_acknowledged" })
      .map((event) => ({ taskId: event.entityId, at: event.createdAt, how: String((event.payload as { how?: unknown }).how ?? "self") }))
  };
}

/** The hosts whose reading is paused after a security check (`site.breaker.<host>` in the future). */
function pausedSites(store: CrosslineStore, workspaceId: string, now: Date): Map<string, boolean> {
  const byWorkflow = new Map<string, boolean>();
  for (const record of readGrownLibrary(store.getSetting(workspaceId, GROWN_LIBRARY_SETTING))) {
    const paused = (record.manifest.access ?? []).some((item) => {
      try { const until = store.getSetting(workspaceId, `site.breaker.${new URL(item.site).host}`); return Boolean(until && Date.parse(until) > now.getTime()); }
      catch { return false; }
    });
    byWorkflow.set(record.manifest.summary.slice(0, 80), paused);
  }
  return byWorkflow;
}

/** Every piece of the assistant's work with all its runs and where it stands (`agentChains` in core): the one reading of "run it again?". */
export function agentChainsFor(store: CrosslineStore, workspaceId: string, now = new Date()): AgentChain[] {
  const sites = pausedSites(store, workspaceId, now);
  const runs: AgentRunRow[] = listAgentTasks(store, workspaceId, now).map((task) => ({
    taskId: task.taskId, workOrderId: task.workOrderId, stepId: task.stepId, title: task.title, requestedAt: task.requestedAt,
    status: task.status, blockerCode: task.blockerCode, blockerMessage: task.blockerMessage, deniedRules: task.deniedRules, by: task.by, partial: task.partial,
    ...(task.endedAt ? { endedAt: task.endedAt } : {}),
    // A workflow run that was refused by a site, or whose site is paused after a security check, is never tried again by itself.
    siteStopped: task.siteRefusals > 0 || (!task.workOrderId && sites.get(task.title) === true)
  }));
  return agentChains(runs, agentChainMarks(store, workspaceId), readLocale(store, workspaceId));
}

/**
 * The person asks for another run of a task: their words (and the checks or items to redo) go into the next run's instructions. A finished
 * result they want redone leaves the review queue (`redo`, which does not count against the kind's trust). Refused while it runs.
 */
export function requestAgentRetry(store: CrosslineStore, workspaceId: string, taskId: string, input: { note?: string; only?: string[]; approach?: string },
  now = new Date()): { ok: true } | { ok: false; code: "TASK_NOT_FOUND" | "TASK_RUNNING" } {
  const task = listAgentTasks(store, workspaceId, now).find((row) => row.taskId === taskId);
  if (!task) return { ok: false, code: "TASK_NOT_FOUND" };
  if (task.status === "running") return { ok: false, code: "TASK_RUNNING" };
  const ownerId = store.getWorkspaceOwnerId(workspaceId) ?? "";
  const only = (input.only ?? []).map((item) => item.trim().slice(0, 300)).filter(Boolean).slice(0, 20);
  if (task.status === "needs_review" && !task.partial) store.appendEvent({ ownerId, workspaceId, idempotencyKey: `agent:reviewed:${taskId}:redo:${now.getTime()}`,
    type: "agent.task.reviewed", entityId: taskId, payload: { taskId, decision: "redo", note: (input.note ?? "").slice(0, 500), category: task.category } });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `agent:retry:${taskId}:${now.getTime()}`, type: "agent.retry_requested", entityId: taskId,
    payload: { taskId, note: (input.note ?? "").trim().slice(0, 4000), ...(only.length ? { only } : {}), ...(input.approach ? { approach: input.approach.slice(0, 300) } : {}), by: "person" } });
  return { ok: true };
}

/** The person closes a stopped task (they do it, or it is dropped): never run again by itself, and no longer asked about. */
export function closeAgentTask(store: CrosslineStore, workspaceId: string, taskId: string, how: "self" | "drop", now = new Date()): void {
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "", workspaceId, idempotencyKey: `agent:blocked:ack:${taskId}:${now.getTime()}`,
    type: "agent.blocked_acknowledged", entityId: taskId, payload: { how } });
}

/**
 * 「我自己做这一步」: a step the assistant was given becomes the person's — scheduled like their own steps, never handed over again by
 * itself. Saved as a new version of the plan (as every edit is), so planned steps get new ids.
 */
export function takeStepBack(store: CrosslineStore, workspaceId: string, workOrderId: string, stepId: string, ownerId: string): boolean {
  const plan = store.getStepPlan(workspaceId, workOrderId);
  const step = plan?.steps.find((item) => item.id === stepId);
  if (!plan || !step || step.status !== "planned") return false;
  store.saveStepPlan(workspaceId, workOrderId, { archetypeId: plan.archetypeId, quantity: plan.quantity, rationale: plan.rationale, units: plan.units,
    questions: plan.questions, steps: plan.steps.map((item) => item.id === stepId ? { ...item, executor: "human" as const, schedulable: true } : item) },
    ownerId, "taken_back");
  return true;
}

export { AGENT_CATEGORIES };
