import { AGENT_CATEGORIES, DISPATCH_STATES, isAgentCategory, isCourse, planAssistantTask, type AgentCategory, type AssistantPlan } from "@crossline/core";
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
export const isPaused = (store: CrosslineStore, workspaceId: string): boolean => store.getSetting(workspaceId, PAUSED) === "1";
export const setPaused = (store: CrosslineStore, workspaceId: string, paused: boolean): void => store.setSetting(workspaceId, PAUSED, paused ? "1" : "0");

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
};
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
        requestedAt: event.createdAt, status: "running", directory: "", durationMs: 0, commands: 0, denied: 0, artifacts: [], needsHuman: 0, checksPassed: false, inputsModified: [], blockerCode: "", blockerMessage: "", reviewNote: "", autoApproved: p.autoApproved === true });
      continue;
    }
    const row = rows.get(taskId);
    if (!row) continue;
    if (event.type === "agent.task.completed") {
      Object.assign(row, { status: p.reviewRequired === false ? "accepted" : "needs_review", directory: String(p.directory ?? ""), durationMs: Number(p.durationMs ?? 0),
        commands: Number(p.commands ?? 0), denied: Number(p.denied ?? 0), artifacts: Array.isArray(p.artifacts) ? p.artifacts as AgentTaskRow["artifacts"] : [],
        needsHuman: Number(p.needsHuman ?? 0), checksPassed: p.checksPassed === true, inputsModified: Array.isArray(p.inputsModified) ? p.inputsModified.map(String) : [] });
    } else if (event.type === "agent.task.blocked") {
      Object.assign(row, { status: "blocked", blockerCode: String(p.code ?? ""), blockerMessage: String(p.message ?? ""), durationMs: Number(p.durationMs ?? 0), commands: Number(p.commands ?? 0), denied: Number(p.decisions ?? 0) });
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
  return { ok: true, trust: recordReview(store, workspaceId, task.category, clean) };
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
  if (!order) return { ok: false, code: "ORDER_NOT_FOUND", message: "找不到这个任务。" };
  if (order.tombstone || !DISPATCH_STATES.has(order.state)) {
    return { ok: false, code: "ORDER_NOT_DISPATCHABLE", message: "这个任务不在可以交给助手的阶段（需要已批准、你还没开始做）。" };
  }
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.projectId === order.projectId);
  const { dates, undated } = latestFileDates(store, workspaceId);
  const milestoneTitle = store.listMilestones(workspaceId).find((milestone) => milestone.id === order.milestoneId)?.title;
  const plan = planAssistantTask(order, { projectIsCourse: isCourse(order.projectId, facts, dates, undated), ...(milestoneTitle ? { milestoneTitle } : {}) });
  if (!plan.fit) return { ok: false, code: "NOTHING_FOR_ASSISTANT", message: plan.reason };
  return { ok: true, plan, title: order.intent, projectId: order.projectId };
}

export { AGENT_CATEGORIES };
