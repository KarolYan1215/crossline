import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_STATES, STEP_STARTS_SETTING, agentChainKey, onPersonsBoard, autoHandoffTiming, isAgentCategory, relevantDocuments, retryDue, stepCategory, type AgentCategory, type AgentChain
} from "@crossline/core";
import {
  agentApprovalDecision, agentChainsFor, assistantPlanFor, decideAgentApproval, declinedCategories, deliverableKey, isAutoHandoff, isPaused, listAgentTasks, readCategories,
  agentQuestionAnswers, expireAgentQuestion, lessonsFor, requestAgentApproval, requestAgentQuestion, requestCategory, type AgentQuestion, type CrosslineStore
} from "@crossline/db";

/** What earlier work of this line and kind taught (docs/token-economy.md §2), for the assistant's input. */
function assistantLessons(store: CrosslineStore, workspaceId: string, orderId: string): string[] {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
  if (!order) return [];
  return lessonsFor(store, workspaceId, { lineId: order.identityId, archetypeId: store.getStepPlan(workspaceId, orderId)?.archetypeId,
    skill: ["crossline-agent", "crossline-agent-tools"] }).map((lesson) => lesson.text);
}
import type { AgentTaskInput } from "./agent-task";
import type { PrepWindow } from "./schedule-window";

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
  const inputs = projectFiles(store, workspaceId, order.projectId);
  const category = categoryOverride ?? stepCategory(step);
  const attempt = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === orderId).length + 1;
  const plan = store.getStepPlan(workspaceId, orderId);
  const units = (plan?.units ?? []).filter((unit) => (step.covers ?? []).includes(unit.id)).map((unit) => `- ${unit.title}（${unit.quote}）`);
  const feeds = (plan?.steps ?? []).filter((other) => other.dependsOn.includes(step.id)).map((other) => other.title);
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" && (fact.projectId === order.projectId || fact.identityId === order.identityId))
    .slice(0, 15).map((fact) => `- ${fact.slot}：${fact.value.slice(0, 160)}`);
  const context = [units.length ? `涉及的内容：\n${units.join("\n")}` : "", feeds.length ? `产出供本人在这些步骤中直接使用：${feeds.join("；")}` : "",
    facts.length ? `本人的相关情况（产出要贴合）：\n${facts.join("\n")}` : "", step.why ? `为什么做这一步：${step.why}` : ""].filter(Boolean).join("\n");
  const title = `${order.intent} · ${step.title}`;
  const before = retryContext(store, workspaceId, agentChainKey({ workOrderId: orderId, stepId, title }));
  return { ok: true, category, why: `步骤「${step.title}」可由系统完成`, graded: false,
    input: { taskId: `agent-${orderId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}-${stepId}-${attempt}`, workOrderId: orderId, stepId, title,
      what: `完成任务「${order.intent}」中的一个准备步骤：${step.title}\n产出：${step.deliverable || "（未写明）"}\n完成标准：${step.doneCriterion || "（未写明）"}${context ? `\n${context}` : ""}\n产出是直接可用的成品（文件），不是计划或说明；只依据给出的文件与公开来源，找不到的写明。${before.text ? `\n${before.text}` : ""}`,
      category: category ?? "read_research_organize", humanPart: "该任务的其余步骤由本人完成；需要本人判断或选择的内容列入待本人处理。", inputs: [...inputs, ...before.inputs],
      ...(step.executor === "agent" ? { prep: true } : {}), lessons: assistantLessons(store, workspaceId, orderId) } };
}

/**
 * The files the person gave for this project, where they are on disk, and the unfiled uploads that name the project in their name or
 * opening (the real ECE 548 lecture plan was one) — the same choice the step planner and the tutorial make. It used to be every unfiled
 * upload, so a media errand was handed the course syllabi, the CV and the profile notes. Read, never changed.
 */
function projectFiles(store: CrosslineStore, workspaceId: string, projectId: string): string[] {
  const project = store.listProjects(workspaceId, { includeArchived: true }).find((item) => item.id === projectId);
  return relevantDocuments(store.listSourceDocuments(workspaceId), { projectId, projectName: project?.name })
    .filter((doc) => doc.uri.startsWith("file:")).flatMap((doc) => { try { return [fileURLToPath(doc.uri)]; } catch { return []; } });
}

export function taskFromWorkOrder(store: CrosslineStore, workspaceId: string, orderId: string, categoryOverride?: AgentCategory, stepId?: string): TaskFromOrder {
  if (stepId) return taskFromStep(store, workspaceId, orderId, stepId, categoryOverride);
  const planned = assistantPlanFor(store, workspaceId, orderId);
  if (!planned.ok) return planned;
  const { plan, title, projectId } = planned;
  const order = { projectId, intent: title };
  const category = categoryOverride ?? plan.category;
  const inputs = projectFiles(store, workspaceId, order.projectId);
  // What the person has confirmed about this line, so the work is about them rather than a generic version of the task (the first
  // content list had to leave every personal angle blank). Confirmed facts only, never the interviewer's guesses.
  const workOrder = store.listWorkOrders(workspaceId).find((item) => item.id === orderId);
  const facts = store.listProfileFacts(workspaceId)
    .filter((fact) => fact.status === "confirmed" && workOrder && fact.identityId === workOrder.identityId
      && (!fact.projectId || fact.projectId === workOrder.projectId || fact.projectId === `${workOrder.identityId}-default`))
    .slice(0, 20).map((fact) => `- ${fact.slot}：${fact.value.slice(0, 200)}`);
  const before = retryContext(store, workspaceId, agentChainKey({ workOrderId: orderId, stepId: "", title: order.intent }));
  const what = [facts.length ? `${plan.what}\n本人确认过的相关事实（可以直接用）：\n${facts.join("\n")}` : plan.what, before.text].filter(Boolean).join("\n");
  const runs = listAgentTasks(store, workspaceId).filter((task) => task.workOrderId === orderId);
  const attempt = runs.length + 1;
  // What the assistant already made for this order (a step of it, before it became the assistant's whole): read only, to build on.
  const earlier = plan.delegated ? runs.filter((task) => (task.status === "accepted" || task.status === "needs_review") && task.directory && existsSync(task.directory))
    .map((task) => task.directory) : [];
  return {
    ok: true, category, why: plan.why, graded: plan.graded,
    input: { taskId: `agent-${orderId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}-${attempt}`, workOrderId: orderId, title: order.intent, what,
      category: category ?? "read_research_organize", humanPart: plan.humanPart, inputs: [...new Set([...inputs, ...before.inputs, ...earlier])], ...(plan.notes ? { notes: plan.notes } : {}),
      ...(plan.delegated ? { delegated: true } : {}), lessons: assistantLessons(store, workspaceId, orderId) }
  };
}

/**
 * Work orders the assistant may start on its own: not paused, a kind it is allowed, never tried before. A kind it is not yet allowed
 * to do is asked about instead (once, until the person answers), and a kind the person declined is left alone.
 */
/** `within`: only these orders (work starting soon); absent, every order — the person's own 「交给 Agent」 is never windowed. */
export function dispatchCandidates(store: CrosslineStore, workspaceId: string, within?: Set<string>, now = new Date()): string[] {
  if (isPaused(store, workspaceId)) return [];
  const approved = readCategories(store, workspaceId);
  const declined = new Set(declinedCategories(store, workspaceId));
  // An order is tried once any run of it (or of a step of it) exists, unless its whole-order runs were interrupted and the next is due.
  const chains = agentChainsFor(store, workspaceId, now);
  const due = new Set(chains.filter((chain) => !chain.latest.stepId && retryDue(chain, now)).map((chain) => chain.latest.workOrderId));
  const tried = new Set(chains.filter((chain) => !chain.latest.stepId).map((chain) => chain.latest.workOrderId).filter((id) => id && !due.has(id)));
  const orders = store.listWorkOrders(workspaceId);
  // A step of an order once handed over keeps the rest of the order its person's — except the assistant's own item (docs/work-split.md:
  // an order reorganised to the assistant after one of its steps ran is still the assistant's to do whole).
  const assistants = new Set(orders.filter((order) => (order.payload as { owner?: unknown } | undefined)?.owner === "assistant").map((order) => order.id));
  for (const chain of chains) if (chain.latest.stepId && !assistants.has(chain.latest.workOrderId)) tried.add(chain.latest.workOrderId);
  const out: string[] = [];
  for (const order of orders) {
    if (tried.has(order.id) || order.tombstone || !DISPATCH_STATES.has(order.state) || (within && !within.has(order.id))) continue;
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
 * Soonest-due task first, then in the step order. `within`: only these steps (`<order>#<step>`, those whose person step starts soon:
 * `prepWindow`); absent, every step.
 */
export function stepDispatchCandidates(store: CrosslineStore, workspaceId: string, within?: Set<string>, now = new Date()): Array<{ orderId: string; stepId: string }> {
  if (isPaused(store, workspaceId)) return [];
  const approved = readCategories(store, workspaceId);
  const declined = new Set(declinedCategories(store, workspaceId));
  const tried = triedSteps(store, workspaceId, now);
  // The person's tasks only: an order that is the assistant's whole (docs/work-split.md) is handed over whole, not step by step.
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && (DISPATCH_STATES.has(order.state) || order.state === "active")
    && onPersonsBoard(order)).map((order) => [order.id, order]));
  const out: Array<{ orderId: string; stepId: string; due: string; seq: number }> = [];
  const made = madeInProject(store, workspaceId);
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!orders.has(plan.workOrderId)) continue;
    const order = orders.get(plan.workOrderId)!;
    const due = (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "9999";
    for (const step of plan.steps) {
      if (step.executor !== "agent" || step.status !== "planned" || tried.has(`${plan.workOrderId}#${step.id}`)) continue;
      if (within && !within.has(`${plan.workOrderId}#${step.id}`)) continue;
      // Already made (or being made, or waiting for review) for another task of the same course or project.
      if (made.get(order.projectId)?.has(deliverableKey(step.title))) continue;
      const category = stepCategory(step) ?? "read_research_organize";
      if (declined.has(category)) continue;
      if (!approved[category]) { requestCategory(store, workspaceId, category, plan.workOrderId, `准备步骤「${step.title}」`); continue; }
      out.push({ orderId: plan.workOrderId, stepId: step.id, due, seq: step.seq });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.seq - b.seq).map(({ orderId, stepId }) => ({ orderId, stepId }));
}

/** Per project, the deliverables the assistant has made, is making, or has waiting for review (`deliverableKey`). */
function madeInProject(store: CrosslineStore, workspaceId: string): Map<string, Set<string>> {
  const projectOf = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order.projectId]));
  const made = new Map<string, Set<string>>();
  for (const task of listAgentTasks(store, workspaceId).filter((item) => ["accepted", "needs_review", "running"].includes(item.status))) {
    const project = projectOf.get(task.workOrderId);
    if (!project) continue;
    made.set(project, (made.get(project) ?? new Set()).add(deliverableKey(task.title)));
  }
  return made;
}

/**
 * Steps already handed over: a step stays tried once a run of it finished, is going, or stopped for a reason of its own; an interrupted
 * run (a stall, a restart, a cancelled turn) is tried again once its backoff is over, at most three runs in a row (`agentChains`).
 */
function triedSteps(store: CrosslineStore, workspaceId: string, now = new Date()): Set<string> {
  return new Set(agentChainsFor(store, workspaceId, now).filter((chain) => chain.latest.stepId && !retryDue(chain, now))
    .map((chain) => `${chain.latest.workOrderId}#${chain.latest.stepId}`));
}

/**
 * Work whose next run is due — interrupted with runs left and the backoff over, or asked for by the person — that can still be done:
 * the order is still open (and the step still planned and not the person's), and its kind is still allowed. The person's own
 * (「交给 Agent」, a retry they asked for) are not held to `within`; the system's own are, as their first run was.
 */
export function retryCandidates(store: CrosslineStore, workspaceId: string, now = new Date(), within?: PrepWindow):
  Array<{ orderId: string; stepId: string | undefined; chain: AgentChain }> {
  if (isPaused(store, workspaceId)) return [];
  const approved = readCategories(store, workspaceId);
  const tasks = new Map(listAgentTasks(store, workspaceId, now).map((row) => [row.taskId, row]));
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => !order.tombstone).map((order) => [order.id, order]));
  const out: Array<{ orderId: string; stepId: string | undefined; chain: AgentChain }> = [];
  for (const chain of agentChainsFor(store, workspaceId, now)) {
    const { workOrderId, stepId } = chain.latest;
    const order = orders.get(workOrderId);
    if (!retryDue(chain, now) || !order) continue;
    const category = tasks.get(chain.latest.taskId)?.category;
    if (category && !approved[category]) continue;
    if (stepId) {
      const step = store.getStepPlan(workspaceId, workOrderId)?.steps.find((item) => item.id === stepId);
      if (!step || step.status !== "planned" || step.executor === "human" || !(DISPATCH_STATES.has(order.state) || order.state === "active")) continue;
      // A preparation step by the person step it serves; a step on the calendar by its order, as before.
      if (!chain.byPerson && within && !(step.executor === "agent" ? within.steps.has(`${workOrderId}#${stepId}`) : within.orders.has(workOrderId))) continue;
    } else if (!DISPATCH_STATES.has(order.state) || !chain.byPerson && within && !within.orders.has(workOrderId)) continue;
    out.push({ orderId: workOrderId, stepId: stepId || undefined, chain });
  }
  // The person's first, then the longest waiting.
  return out.sort((a, b) => Number(b.chain.byPerson) - Number(a.chain.byPerson) || (a.chain.retryAt ?? "").localeCompare(b.chain.retryAt ?? ""));
}

const defaultRoot = () => process.env.CROSSLINE_AI_OUTPUT_DIR ?? path.join(homedir(), "Crossline", "ai-output");
const hasFiles = (dir: string) => { try { return readdirSync(dir).some((name) => !/^(audit|progress)\.json$/i.test(name)); } catch { return false; } };

/**
 * What the next run of work that stopped before is told: where the last one stopped, the folders its earlier runs wrote (read only, to
 * carry on from rather than start over), and the person's own words, which come first. Empty for work never run.
 */
export function retryContext(store: CrosslineStore, workspaceId: string, key: string, outputRoot = defaultRoot()): { text: string; inputs: string[] } {
  const chain = agentChainsFor(store, workspaceId).find((item) => item.key === key);
  if (!chain || chain.state === "done" && !chain.notes.length) return { text: "", inputs: [] };
  const rows = new Map(listAgentTasks(store, workspaceId).map((row) => [row.taskId, row]));
  const inputs = chain.runs.map((run) => rows.get(run.taskId)?.directory || path.join(outputRoot, run.taskId)).filter((dir) => existsSync(dir) && hasFiles(dir));
  const before = chain.failure ? `这件事之前做过 ${chain.runs.length} 次没做完，上一次停在：${chain.failure.stuckAt}。` : `这件事之前做过 ${chain.runs.length} 次，本人要求再做一次。`;
  return {
    text: [before,
      inputs.length ? `之前写出的文件在：${inputs.join("；")}（只读）。先看这些文件，接着做，不要从头重做已经做好的部分。` : "",
      chain.notes.length ? `本人的交代（按这个做，与上面的要求冲突时以这里为准）：\n${chain.notes.map((note) => `- ${note}`).join("\n")}` : ""].filter(Boolean).join("\n"),
    inputs
  };
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
  const tried = triedSteps(store, workspaceId, now);
  const starts = readStepStarts(store, workspaceId);
  const made = madeInProject(store, workspaceId);
  // The person is working on it right now: an open, unpaused session. The assistant does not start on the same task under them.
  const timing = new Set(store.listExecutions(workspaceId).filter((execution) => !execution.endedAt
    && !(execution.interruptions.at(-1) && !execution.interruptions.at(-1)!.resumedAt)).map((execution) => execution.workOrderId));
  const orders = new Map(store.listWorkOrders(workspaceId).filter((order) => !order.tombstone && (DISPATCH_STATES.has(order.state) || order.state === "active")
    && !timing.has(order.id) && onPersonsBoard(order)).map((order) => [order.id, order]));
  const out: Array<{ orderId: string; stepId: string; at: string; when: "due" | "early" }> = [];
  for (const plan of store.listStepPlans(workspaceId)) {
    if (!orders.has(plan.workOrderId)) continue;
    const finished = new Set(plan.steps.filter((step) => step.status === "done" || step.status === "skipped").map((step) => step.id));
    for (const step of plan.steps) {
      if (step.executor !== "mixed" || step.status !== "planned" || !step.schedulable || tried.has(`${plan.workOrderId}#${step.id}`)) continue;
      if (made.get(orders.get(plan.workOrderId)!.projectId)?.has(deliverableKey(step.title))) continue;
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

/** What the run is told about a question nobody answered in time (the Skill says what to do with it). */
export const QUESTION_UNANSWERED = "本人暂未回答。按最稳妥的做法继续，并把这个问题写进 needsHuman。";

/**
 * A question the assistant asks mid-run (Codex's `request_user_input`), put to the person the way guard questions are: written to the
 * ledger, shown on 待确认, answered there. Unanswered within ten minutes it expires and the run is told to go on the safest way.
 */
export function ledgerQuestion(store: CrosslineStore, workspaceId: string, taskId: string, title: string,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; onAsked?: (id: string, questions: AgentQuestion[]) => void } = {}) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (questions: AgentQuestion[]): Promise<Record<string, string[]>> => {
    const unanswered = Object.fromEntries(questions.map((question) => [question.id, [QUESTION_UNANSWERED]]));
    const id = requestAgentQuestion(store, workspaceId, taskId, title, questions);
    if (!id) return unanswered;
    options.onAsked?.(id, questions);
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const answers = agentQuestionAnswers(store, workspaceId, id);
      if (answers) return { ...unanswered, ...Object.fromEntries(Object.entries(answers).filter(([, value]) => value.length)) };
      await sleep(pollMs);
    }
    expireAgentQuestion(store, workspaceId, id);
    return unanswered;
  };
}

export { isAgentCategory };
