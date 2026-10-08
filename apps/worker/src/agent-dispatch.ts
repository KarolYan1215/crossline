import { fileURLToPath } from "node:url";
import { DISPATCH_STATES, isAgentCategory, type AgentCategory } from "@crossline/core";
import {
  agentApprovalDecision, assistantPlanFor, decideAgentApproval, declinedCategories, isPaused, listAgentTasks, readCategories, requestAgentApproval, requestCategory,
  type CrosslineStore
} from "@crossline/db";
import type { AgentTaskInput } from "./agent-task";

/**
 * From a work order on the board to a task for the assistant, and the rules for starting one without being told.
 *
 * Starting by itself is limited to what the person has already said yes to: a kind of work that has not been approved is not run, it
 * is asked about once (a request that shows up in 待确认), and the work order waits. Everything else about a work order stays as it
 * was — the assistant's results are attached to it, they do not move it through its states.
 */
export type TaskFromOrder = { ok: true; input: AgentTaskInput; category: AgentCategory | undefined; why: string; graded: boolean }
  | { ok: false; code: "ORDER_NOT_FOUND" | "ORDER_NOT_DISPATCHABLE" | "NOTHING_FOR_ASSISTANT"; message: string };

/** The kind of work a step is, read from its role, for handing one step over (「交给 Agent」 on a step). */
const STEP_CATEGORY: Record<string, AgentCategory> = {
  gather: "read_research_organize", read: "read_research_organize", compare: "read_research_organize", analyze: "read_research_organize",
  summarize: "read_research_organize", record: "read_research_organize", learn: "read_research_organize",
  outline: "draft_text", draft: "draft_text", revise: "draft_text", check: "draft_text",
  build: "data_code_sim", test: "data_code_sim", prepare: "files_calendar_prep", book: "files_calendar_prep", handle: "files_calendar_prep"
};

/**
 * One step of a task, as a task for the assistant: the step's title, what it produces and how it is judged done. Only a step the step
 * planner judged the system can do (`executor` agent or mixed); the rest of the task stays the person's. Its result, once accepted,
 * marks the step done.
 */
function taskFromStep(store: CrosslineStore, workspaceId: string, orderId: string, stepId: string, categoryOverride?: AgentCategory): TaskFromOrder {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
  if (!order) return { ok: false, code: "ORDER_NOT_FOUND", message: "任务不存在" };
  const step = store.getStepPlan(workspaceId, orderId)?.steps.find((item) => item.id === stepId);
  if (!step || step.status !== "planned" || step.executor === "human")
    return { ok: false, code: "ORDER_NOT_DISPATCHABLE", message: "该步骤需要本人完成" };
  const inputs = store.listSourceDocuments(workspaceId).filter((doc) => (doc.projectId === order.projectId || !doc.projectId) && doc.uri.startsWith("file:"))
    .flatMap((doc) => { try { return [fileURLToPath(doc.uri)]; } catch { return []; } });
  const category = categoryOverride ?? STEP_CATEGORY[step.role];
  const attempt = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === orderId).length + 1;
  return { ok: true, category, why: `步骤「${step.title}」可由系统完成`, graded: false,
    input: { taskId: `agent-${orderId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}-${stepId}-${attempt}`, workOrderId: orderId, stepId,
      title: `${order.intent} · ${step.title}`,
      what: `完成任务「${order.intent}」中的一个步骤：${step.title}\n产出：${step.deliverable || "（未写明）"}\n完成标准：${step.doneCriterion || "（未写明）"}`,
      category: category ?? "read_research_organize", humanPart: "该任务的其余步骤由本人完成；需要本人判断或选择的内容列入待本人处理。", inputs } };
}

export function taskFromWorkOrder(store: CrosslineStore, workspaceId: string, orderId: string, categoryOverride?: AgentCategory, stepId?: string): TaskFromOrder {
  if (stepId) return taskFromStep(store, workspaceId, orderId, stepId, categoryOverride);
  const planned = assistantPlanFor(store, workspaceId, orderId);
  if (!planned.ok) return planned;
  const { plan, title, projectId } = planned;
  const order = { projectId, intent: title };
  const category = categoryOverride ?? plan.category;
  // The files the person gave for this project, where they are on disk — and the ones uploaded during the interview, which belong
  // to no project (the real ECE 548 lecture plan was one; the assistant was handed nothing and wrote an empty template). Read, never
  // changed; the assistant picks what is relevant.
  const inputs = store.listSourceDocuments(workspaceId)
    .filter((doc) => (doc.projectId === order.projectId || !doc.projectId) && doc.uri.startsWith("file:"))
    .flatMap((doc) => { try { return [fileURLToPath(doc.uri)]; } catch { return []; } });
  // What the person has confirmed about this line, so the work is about them rather than a generic version of the task (the first
  // content list had to leave every personal angle blank). Confirmed facts only, never the interviewer's guesses.
  const workOrder = store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
  const facts = store.listProfileFacts(workspaceId)
    .filter((fact) => fact.status === "confirmed" && workOrder && fact.identityId === workOrder.identityId
      && (!fact.projectId || fact.projectId === workOrder.projectId || fact.projectId === `${workOrder.identityId}-default`))
    .slice(0, 20).map((fact) => `- ${fact.slot}：${fact.value.slice(0, 200)}`);
  const what = facts.length ? `${plan.what}\n本人确认过的相关事实（可以直接用）：\n${facts.join("\n")}` : plan.what;
  const attempt = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === orderId).length + 1;
  return {
    ok: true, category, why: plan.why, graded: plan.graded,
    input: { taskId: `agent-${orderId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}-${attempt}`, workOrderId: orderId, title: order.intent, what,
      category: category ?? "read_research_organize", humanPart: plan.humanPart, inputs, ...(plan.notes ? { notes: plan.notes } : {}),
      ...(plan.delegated ? { delegated: true } : {}) }
  };
}

/**
 * Work orders the assistant may start on its own: not paused, a kind it is allowed, never tried before. A kind it is not yet allowed
 * to do is asked about instead (once, until the person answers), and a kind the person declined is left alone.
 */
export function dispatchCandidates(store: CrosslineStore, workspaceId: string): string[] {
  if (isPaused(store, workspaceId)) return [];
  const approved = readCategories(store, workspaceId);
  const declined = new Set(declinedCategories(store, workspaceId));
  const tried = new Set(listAgentTasks(store, workspaceId).map((task) => task.workOrderId).filter(Boolean));
  const out: string[] = [];
  for (const order of store.listWorkOrders(workspaceId)) {
    if (tried.has(order.id) || order.tombstone || !DISPATCH_STATES.has(order.state)) continue;
    const result = taskFromWorkOrder(store, workspaceId, order.id);
    // Wording that points at no kind is the person's to decide; nothing starts without a kind.
    if (!result.ok || !result.category || declined.has(result.category)) continue;
    if (!approved[result.category]) { requestCategory(store, workspaceId, result.category, order.id, result.why); continue; }
    out.push(order.id);
  }
  return out;
}

/**
 * The way a guard question reaches the person: written to the ledger, where 待确认 shows it, and answered from there. Left unanswered
 * it is declined, so a run never waits on a person who has gone away.
 */
export function ledgerAsk(store: CrosslineStore, workspaceId: string, taskId: string, options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (request: { kind: string; subject: string; rule: string; reason: string }): Promise<boolean> => {
    const id = requestAgentApproval(store, workspaceId, taskId, request);
    if (!id) return false;
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const decision = agentApprovalDecision(store, workspaceId, id);
      if (decision) return decision === "accepted";
      await sleep(pollMs);
    }
    decideAgentApproval(store, workspaceId, id, "declined");
    return false;
  };
}

export { isAgentCategory };
