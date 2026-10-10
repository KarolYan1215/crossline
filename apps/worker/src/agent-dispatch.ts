import { fileURLToPath } from "node:url";
import { DISPATCH_STATES, STEP_STARTS_SETTING, autoHandoffTiming, isAgentCategory, prepStepRetried, stepCategory, type AgentCategory } from "@crossline/core";
import {
  agentApprovalDecision, assistantPlanFor, decideAgentApproval, declinedCategories, isAutoHandoff, isPaused, listAgentTasks, readCategories, requestAgentApproval,
  requestCategory, type CrosslineStore
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
  const category = categoryOverride ?? stepCategory(step);
  const attempt = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === orderId).length + 1;
  const plan = store.getStepPlan(workspaceId, orderId);
  const units = (plan?.units ?? []).filter((unit) => (step.covers ?? []).includes(unit.id)).map((unit) => `- ${unit.title}（${unit.quote}）`);
  const feeds = (plan?.steps ?? []).filter((other) => other.dependsOn.includes(step.id)).map((other) => other.title);
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" && (fact.projectId === order.projectId || fact.identityId === order.identityId))
    .slice(0, 15).map((fact) => `- ${fact.slot}：${fact.value.slice(0, 160)}`);
  const context = [units.length ? `涉及的内容：\n${units.join("\n")}` : "", feeds.length ? `产出供本人在这些步骤中直接使用：${feeds.join("；")}` : "",
    facts.length ? `本人的相关情况（产出要贴合）：\n${facts.join("\n")}` : "", step.why ? `为什么做这一步：${step.why}` : ""].filter(Boolean).join("\n");
  return { ok: true, category, why: `步骤「${step.title}」可由系统完成`, graded: false,
    input: { taskId: `agent-${orderId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}-${stepId}-${attempt}`, workOrderId: orderId, stepId,
      title: `${order.intent} · ${step.title}`,
      what: `完成任务「${order.intent}」中的一个准备步骤：${step.title}\n产出：${step.deliverable || "（未写明）"}\n完成标准：${step.doneCriterion || "（未写明）"}${context ? `\n${context}` : ""}\n产出是直接可用的成品（文件），不是计划或说明；只依据给出的文件与公开来源，找不到的写明。`,
      category: category ?? "read_research_organize", humanPart: "该任务的其余步骤由本人完成；需要本人判断或选择的内容列入待本人处理。", inputs,
      ...(step.executor === "agent" ? { prep: true } : {}) } };
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
 * The preparation steps the assistant takes over by itself (decided 2026-10-09: what is static is done before the person needs it, and
 * the person's attention goes to the intellectual core). A step the planner gave the assistant (`executor: "agent"`), still planned, of
 * a committed task, never tried before, of a kind the person allowed; a kind not yet allowed is asked about once and the step waits.
 * Soonest-due task first, then in the step order.
 */
export function stepDispatchCandidates(store: CrosslineStore, workspaceId: string): Array<{ orderId: string; stepId: string }> {
  if (isPaused(store, workspaceId)) return [];
  const approved = readCategories(store, workspaceId);
  const declined = new Set(declinedCategories(store, workspaceId));
  const tried = triedSteps(store, workspaceId);
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && (DISPATCH_STATES.has(order.state) || order.state === "active"))
    .map((order) => [order.id, order]));
  const out: Array<{ orderId: string; stepId: string; due: string; seq: number }> = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!orders.has(plan.workOrderId)) continue;
    const due = (orders.get(plan.workOrderId)!.payload as { dueDate?: string } | undefined)?.dueDate ?? "9999";
    for (const step of plan.steps) {
      if (step.executor !== "agent" || step.status !== "planned" || tried.has(`${plan.workOrderId}#${step.id}`)) continue;
      const category = stepCategory(step) ?? "read_research_organize";
      if (declined.has(category)) continue;
      if (!approved[category]) { requestCategory(store, workspaceId, category, plan.workOrderId, `准备步骤「${step.title}」`); continue; }
      out.push({ orderId: plan.workOrderId, stepId: step.id, due, seq: step.seq });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.seq - b.seq).map(({ orderId, stepId }) => ({ orderId, stepId }));
}

/**
 * Steps already handed over: a step stays tried once a run of it finished, is going, or failed for a reason of its own; a run the
 * runtime lost (a stall, a restart, a cancelled turn) is tried again, at most three times in all.
 */
function triedSteps(store: CrosslineStore, workspaceId: string): Set<string> {
  const runs = new Map<string, Array<{ status: string; blockerCode?: string | undefined }>>();
  for (const task of listAgentTasks(store, workspaceId).filter((item) => item.stepId)) {
    const key = `${task.workOrderId}#${task.stepId}`;
    runs.set(key, [...(runs.get(key) ?? []), task]);
  }
  return new Set([...runs].filter(([, list]) => !prepStepRetried(list)).map(([key]) => key));
}

export function readStepStarts(store: CrosslineStore, workspaceId: string): Record<string, string> {
  try {
    const value = JSON.parse(store.getSetting(workspaceId, STEP_STARTS_SETTING) ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === "string")) as Record<string, string> : {};
  } catch { return {}; }
}

/**
 * The steps 「自动交给 Agent」 starts by itself (`AUTO_HANDOFF_SETTING` in core; off by default): a step on the calendar the step planner
 * judged the system can do (`executor: "mixed"`), still planned, whose earlier steps are done, of a committed task the person is not
 * timing at this moment, never tried before, of a kind the person allowed (a kind not yet allowed is asked about once and the step waits).
 *
 * "At its scheduled time" means: the next block the plan gave the step (`STEP_STARTS_SETTING`, written by the web every ten minutes for
 * the coming week) starts within `AUTO_HANDOFF_LEAD_MINUTES`, or has started — those are `due` and go before anything else the assistant
 * would pick up. A step whose block is later in the week is `early`: started only when nothing else is waiting, so an idle assistant
 * gets ahead. A step with no block (in the task library, or not placed) is not started by itself. Each list is soonest block first.
 */
export function autoHandoffCandidates(store: CrosslineStore, workspaceId: string, now = new Date()):
  { due: Array<{ orderId: string; stepId: string }>; early: Array<{ orderId: string; stepId: string }> } {
  if (!isAutoHandoff(store, workspaceId) || isPaused(store, workspaceId)) return { due: [], early: [] };
  const approved = readCategories(store, workspaceId);
  const declined = new Set(declinedCategories(store, workspaceId));
  const tried = triedSteps(store, workspaceId);
  const starts = readStepStarts(store, workspaceId);
  // The person is working on it right now: an open, unpaused session. The assistant does not start on the same task under them.
  const timing = new Set(store.listExecutions(workspaceId).filter((execution) => !execution.endedAt
    && !(execution.interruptions.at(-1) && !execution.interruptions.at(-1)!.resumedAt)).map((execution) => execution.workOrderId));
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && (DISPATCH_STATES.has(order.state) || order.state === "active")
    && !timing.has(order.id)).map((order) => [order.id, order]));
  const out: Array<{ orderId: string; stepId: string; at: string; when: "due" | "early" }> = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!orders.has(plan.workOrderId)) continue;
    const finished = new Set(plan.steps.filter((step) => step.status === "done" || step.status === "skipped").map((step) => step.id));
    for (const step of plan.steps) {
      if (step.executor !== "mixed" || step.status !== "planned" || !step.schedulable || tried.has(`${plan.workOrderId}#${step.id}`)) continue;
      if (!step.dependsOn.every((id) => finished.has(id))) continue;
      const at = starts[`${plan.workOrderId}#${step.id}`];
      const when = autoHandoffTiming(at, now);
      if (when === "unscheduled") continue;
      const category = stepCategory(step);
      if (!category || declined.has(category)) continue;
      if (!approved[category]) { requestCategory(store, workspaceId, category, plan.workOrderId, `步骤「${step.title}」可由系统完成`); continue; }
      out.push({ orderId: plan.workOrderId, stepId: step.id, at: at!, when });
    }
  }
  const sorted = out.sort((a, b) => a.at.localeCompare(b.at));
  const pick = (when: "due" | "early") => sorted.filter((item) => item.when === when).map(({ orderId, stepId }) => ({ orderId, stepId }));
  return { due: pick("due"), early: pick("early") };
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
