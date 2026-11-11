import { createHash } from "node:crypto";
import path from "node:path";
import {
  AUTOMATION_PLAN_SCHEMA, AUTOMATION_RUNS_SETTING, automationRunPrompt, AUTOMATIONS_MAX, AUTOMATIONS_SETTING, AGENT_CATEGORIES, addedLines, fileMatches,
  mailMatches, monthlyDays, previousRunNote, readAutomationRuns, readAutomations, tFor, timeTriggerDue, triggerLabel, validateAutomationPlan,
  type AgentCategory, type Automation, type AutomationPlan, type AutomationRun
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { approveCategory, listAgentTasks, readCategories, requestAutomation, requestThreadId, type CrosslineStore } from "@crossline/db";
import type { AgentOutcome, AgentTaskInput } from "./agent-task";
import type { DispatchResult } from "./agent-service";
import { identityLines } from "./lines";
import type { NewMail } from "./mailbox";
import { ownerOf } from "./owner";
import { localeOf } from "./locale";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";
import { sayToPerson } from "./workflow-smith";

/**
 * The automation engine (docs/personal-agent.md, 2026-10-19). A request in words (`automation.requested`, from the input box or the
 * settings card) is turned into an automation by `crossline-automation-designer`, checked by `validateAutomationPlan`, installed and
 * announced. Then, every tick, each active automation's trigger is looked at — for nothing: a clock, a page's text hash, new mail and
 * files and task events the worker already has — and a firing starts the assistant (`runFree`, tools mode for everyone but the machine
 * owner) with the automation's instructions and what fired it, or sends its reminder. Results go the assistant's usual way — taken as
 * done unless they need the person — and each run is said once with where its files are.
 */
export const AUTOMATION_DESIGNER_SKILL = "crossline:crossline-automation-designer";

type Fire = { reason: string; context: string; inputs?: string[] };
/** Troubles that pass by themselves: a design that met one is tried again on a later tick. */
const PASSING = /^(SKILL_USAGE_LIMIT|SKILL_TIMEOUT|SKILL_STALLED|SKILL_THREAD_LOST|SKILL_RUNTIME_FAILED|SKILL_CANCELED|RUNTIME_|MODEL_SPONSOR_|CODEX_SUPERVISOR|RATE_LIMIT)/;
export type AutomationDeps = {
  store: CrosslineStore; cwd: string;
  client: (workspaceId: string) => CodexRpcBoundary | undefined;
  runFree: (workspaceId: string, input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void) => DispatchResult;
  zone: (workspaceId: string) => string;
  /** Whether this account's assistant has a command line (the owner's shell, a node, the sandbox): the designer then gives it running scripts. */
  shell?: (workspaceId: string) => boolean;
  fetch?: SafeGetDeps; now?: () => Date; log?: (event: Record<string, unknown>) => void;
};

const read = (store: CrosslineStore, workspaceId: string) => readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
const write = (store: CrosslineStore, workspaceId: string, list: Automation[]) => store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify(list));
const update = (store: CrosslineStore, workspaceId: string, id: string, change: (item: Automation) => Automation) =>
  write(store, workspaceId, read(store, workspaceId).map((item) => item.id === id ? change(item) : item));
const runs = (store: CrosslineStore, workspaceId: string) => readAutomationRuns(store.getSetting(workspaceId, AUTOMATION_RUNS_SETTING));
function noteRun(store: CrosslineStore, workspaceId: string, run: AutomationRun): void {
  store.setSetting(workspaceId, AUTOMATION_RUNS_SETTING, JSON.stringify([...runs(store, workspaceId), run].slice(-100)));
}

/**
 * The run log is reconciled against the assistant's own ledger, the source of truth, at start and on every tick. A run's end used to be
 * only a callback in the process that started it, so a restart (2026-11-04, two runs lost to deploys) or a run from before the log
 * recorded ends (two on the owner's account, 11-02 and 11-04) said 「已开始」 for good. Now: an ended task gives the run its end; a run
 * the last worker lost (recoverLost) is 「没跑完」 and said once; a run with no task on record after a day is closed as never started.
 */
export function reconcileAutomationRuns(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const open = runs(store, workspaceId).filter((run) => run.state === "started");
  if (!open.length) return [];
  const tasks = new Map(listAgentTasks(store, workspaceId).map((task) => [task.taskId, task]));
  const t = tFor(localeOf(store, workspaceId));
  const lostDetail = t("后台进程重启，这次运行中断");
  const ends = new Map<string, Pick<AutomationRun, "state" | "detail">>();
  for (const run of open) {
    const task = tasks.get(run.taskId);
    if (!task) { if (now.getTime() - Date.parse(run.firedAt) > 86_400_000) ends.set(run.taskId, { state: "failed", detail: t("没有找到这次运行的记录") }); continue; }
    if (task.status === "running") continue;
    ends.set(run.taskId, task.status === "blocked"
      ? { state: "failed", detail: task.blockerCode === "AGENT_RUN_LOST" ? lostDetail : task.blockerMessage.slice(0, 120) }
      : { state: "done" });
  }
  if (!ends.size) return [];
  store.setSetting(workspaceId, AUTOMATION_RUNS_SETTING, JSON.stringify(runs(store, workspaceId).map((run) => {
    const end = ends.get(run.taskId);
    return end && run.state === "started" ? { ...run, state: end.state, ...(end.detail ? { detail: end.detail } : {}) } : run;
  })));
  // Only a lost run is said here (a run that ended any other way was said by its own callback); older ones are only marked.
  for (const run of open.filter((item) => tasks.get(item.taskId)?.blockerCode === "AGENT_RUN_LOST" && now.getTime() - Date.parse(item.firedAt) < 86_400_000)) {
    const name = read(store, workspaceId).find((item) => item.id === run.automationId)?.name ?? run.automationId;
    sayToPerson(store, workspaceId, t("自动化「{{name}}」这次没跑完：{{reason}}", { name, reason: lostDetail }), "automation_failed", `automation-failed:${run.taskId}`,
      [{ label: t("查看", { context: "view" }), href: "/automation" }], now);
  }
  return [...ends.keys()];
}

export const pendingRequests =(store: CrosslineStore, workspaceId: string) => {
  const settled = new Set([...store.listEvents(workspaceId, { type: "automation.created" }), ...store.listEvents(workspaceId, { type: "automation.design_failed" })]
    .map((event) => String((event.payload as { requestId?: string }).requestId ?? "")));
  return store.listEvents(workspaceId, { type: "automation.requested" }).filter((event) => !settled.has(event.entityId));
};

/** What the person sees and controls on the settings card. */
export function automationsView(store: CrosslineStore, workspaceId: string) {
  return { automations: read(store, workspaceId).map((item) => ({ ...item, triggerLabel: triggerLabel(item.trigger, localeOf(store, workspaceId)) })),
    runs: runs(store, workspaceId).slice(-30).reverse(), pending: pendingRequests(store, workspaceId).map((event) => ({ id: event.entityId, text: String((event.payload as { text?: string }).text ?? "") })) };
}

/** Turns every waiting request into an automation (or says why it could not). */
export async function designPending(deps: AutomationDeps, workspaceId: string): Promise<Array<{ requestId: string; state: string; id?: string }>> {
  const out: Array<{ requestId: string; state: string; id?: string }> = [];
  for (const request of pendingRequests(deps.store, workspaceId).slice(0, 3)) {
    const payload = request.payload as { text?: string; lineId?: string };
    const result = await designOne(deps, workspaceId, request.entityId, String(payload.text ?? ""), String(payload.lineId ?? ""));
    out.push({ requestId: request.entityId, ...result });
  }
  return out;
}

async function designOne(deps: AutomationDeps, workspaceId: string, requestId: string, text: string, lineHint: string): Promise<{ state: string; id?: string }> {
  const now = deps.now?.() ?? new Date();
  const ownerId = ownerOf(deps.store, workspaceId);
  const locale = localeOf(deps.store, workspaceId);
  const t = tFor(locale);
  const fail = (reason: string) => {
    deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `automation.design_failed:${requestId}`, type: "automation.design_failed", entityId: requestId, payload: { requestId, reason } });
    const said = t("没能把「{{text}}」建成自动化：{{reason}}", { text: text.slice(0, 60), reason });
    settleRequestTurn(deps.store, workspaceId, requestId, said, "failed", now);
    sayToPerson(deps.store, workspaceId, said, "automation_failed", `automation-failed:${requestId}`,
      [{ label: t("打开对话"), href: `/automation/${encodeURIComponent(requestThreadId(deps.store, workspaceId, requestId) ?? requestId)}` }], now);
    return { state: "failed" };
  };
  const existing = read(deps.store, workspaceId);
  const client = deps.client(workspaceId);
  if (!client) return { state: "waiting" };
  const lines = identityLines(deps.store, workspaceId).map((line) => ({ id: line.id, label: line.label }));
  const input = { request: text, lineHint, lines, today: now.toISOString().slice(0, 10), timeZone: deps.zone(workspaceId),
    categories: Object.entries(AGENT_CATEGORIES).map(([id, label]) => ({ id, label })),
    connected: { mail: Boolean(deps.store.getSetting(workspaceId, "mail.accounts")?.includes("\"id\"")) },
    // 2026-11-04: without this the designer gave "run three commands" to the person on an account whose assistant has a sandboxed shell.
    assistant: { commandLine: Boolean(deps.shell?.(workspaceId)) },
    // What exists already: a request that changes one of these replaces it (the automation grows by being told what to change). Each is
    // given whole, in the answer's own shape, because a change answers with the whole automation and keeps every part it does not change.
    existing: existing.map((item) => ({ id: item.id, name: item.name, summary: item.summary, lineId: item.lineId, status: item.status,
      when: triggerLabel(item.trigger, locale), trigger: flatTrigger(item.trigger), action: flatAction(item.action), steps: item.steps })) };
  const result = await runCodexSkill<ReturnType<typeof validateAutomationPlan>>(client, input, {
    skillName: AUTOMATION_DESIGNER_SKILL, cwd: deps.cwd, outputSchema: AUTOMATION_PLAN_SCHEMA as unknown as Record<string, unknown>,
    developerInstructions: DESIGN_INSTRUCTIONS,
    prepareInput: () => input, validateOutput: (output) => validateAutomationPlan(output, lines.map((line) => line.id), existing.map((item) => item.id)), onAudit: () => {}, timeoutMs: 30 * 60_000
  });
  if (!result.ok) {
    // A passing trouble (quota, a timeout, a runtime that restarted, the developer's model still being checked) waits for the next tick,
    // three times at most; anything else — an answer that never kept to the schema, a missing Skill — is said to the person at once.
    const attempts = deps.store.listEvents(workspaceId, { type: "automation.design_attempted", entityId: requestId }).length + 1;
    deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `automation.design_attempted:${requestId}:${attempts}`, type: "automation.design_attempted", entityId: requestId,
      payload: { code: result.blocker.code } });
    return PASSING.test(result.blocker.code) && attempts < 3 ? { state: "waiting" } : fail(result.blocker.message || t("设计没有成功"));
  }
  const plan = result.output;
  const previous = plan.replaces ? existing.find((item) => item.id === plan.replaces) : undefined;
  if (!previous && existing.length >= AUTOMATIONS_MAX) return fail(t("已经有 {{count}} 个自动化，先删掉不用的。", { count: AUTOMATIONS_MAX }));
  const id = previous?.id ?? `auto-${createHash("sha256").update(requestId).digest("hex").slice(0, 8)}`;
  const { automation, allowed } = installAutomation(deps.store, workspaceId, plan, id, { kind: "asked", text, requestId }, previous, now);
  deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `automation.created:${requestId}`, type: "automation.created", entityId: id,
    payload: { requestId, name: plan.name, trigger: plan.trigger.type, action: plan.action.kind, ...(previous ? { replaced: previous.id } : {}) } });
  const person = plan.steps.filter((step) => step.by === "person").map((step) => step.title);
  const values = { name: plan.name, when: triggerLabel(plan.trigger, locale), summary: plan.summary };
  const said = [!plan.enabled ? t("已暂停自动化「{{name}}」，要恢复在设置里点「恢复」或再说一句。", values)
    : previous ? t("已按要求改好自动化「{{name}}」：{{when}}，{{summary}}", values) : t("已建好自动化「{{name}}」：{{when}}，{{summary}}", values),
    person.length ? t("其中「{{steps}}」由本人完成。", { steps: person.join(locale === "en" ? "\", \"" : "」「") }) : "",
    allowed && automation.action.kind === "run" ? t("已按这个请求为助手开启「{{category}}」。", { category: t(AGENT_CATEGORIES[automation.action.category]) }) : "",
    plan.assumptions ? t("按以下理解建立：{{assumptions}}", { assumptions: plan.assumptions }) : ""].filter(Boolean).join("\n");
  const version = deps.store.annotateWorkflowVersion(workspaceId, "automation", id, { source: "thread", note: plan.summary, turnId: `${requestId}-reply` });
  settleRequestTurn(deps.store, workspaceId, requestId, said, "done", now, { workflowId: id, ...(version ? { version } : {}), note: plan.summary });
  sayToPerson(deps.store, workspaceId, said, "automation_created", `automation:${requestId}`, [{ label: t("查看与修改"), href: `/automation/${id}` }], now);
  // 「现在先跑一次」: the first run now instead of at the trigger (2026-11-04: the request said it and nothing ran).
  if (plan.runNow && automation.status === "active") fireOrQueue(deps, workspaceId, automation, { reason: t("本人要求建好后先跑一次"), context: "" });
  return { state: "created", id };
}

/**
 * The parts of an automation a design or a turn of its conversation decided, put in force: a new one, or the one it changes with its runs
 * and watched page kept. The person asked for it in words, so the kind of work it does is allowed by that request (said in the message,
 * switchable on the 自动化 page).
 */
export function installAutomation(store: CrosslineStore, workspaceId: string, plan: ReturnType<typeof validateAutomationPlan>, id: string,
  origin: Automation["origin"], previous: Automation | undefined, now: Date): { automation: Automation; allowed: boolean } {
  const automation: Automation = { id, name: plan.name, summary: plan.summary, lineId: plan.lineId, status: plan.enabled ? "active" : "off", trigger: plan.trigger, action: plan.action, steps: plan.steps,
    origin: previous?.origin ?? origin, createdAt: previous?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
    runs: previous?.runs ?? 0, ...(previous?.lastFiredAt ? { lastFiredAt: previous.lastFiredAt } : {}),
    ...(previous?.watch && previous.trigger.type === "watch" && plan.trigger.type === "watch" && previous.trigger.url === plan.trigger.url ? { watch: previous.watch } : {}) };
  write(store, workspaceId, previous ? read(store, workspaceId).map((item) => item.id === id ? automation : item)
    : [...read(store, workspaceId).filter((item) => item.id !== id), automation]);
  const allowed = automation.action.kind === "run" && !readCategories(store, workspaceId)[automation.action.category];
  if (automation.action.kind === "run" && allowed) approveCategory(store, workspaceId, automation.action.category);
  return { automation, allowed };
}

/** The designer's answer to a request, written into the conversation the request opened (`requestAutomation`). */
function settleRequestTurn(store: CrosslineStore, workspaceId: string, requestId: string, text: string, state: "done" | "failed", now: Date,
  made?: { workflowId: string; version?: number; note: string }): void {
  const threadId = requestThreadId(store, workspaceId, requestId);
  if (!threadId) return;
  const turn = store.listWorkflowTurns(workspaceId, threadId).find((item) => item.id === `${requestId}-reply`);
  store.saveWorkflowTurn({ workspaceId, id: `${requestId}-reply`, threadId, role: "assistant", text, state, createdAt: turn?.createdAt ?? now.toISOString(),
    items: made?.version ? [{ type: "version", version: made.version, note: made.note }] : [] });
  const thread = store.getWorkflowThread(workspaceId, threadId);
  if (made && thread && !thread.workflowId) store.saveWorkflowThread({ ...thread, workflowId: made.workflowId, updatedAt: now.toISOString() });
}

export const DESIGN_INSTRUCTIONS ="Turn the person's one request into one automation Crossline runs by itself: a trigger it can watch for free, and what "
  + "the assistant does each time it fires. The instructions are read by the assistant on every firing: concrete steps naming what to read and "
  + "which files to write, never a plan. The person gets every run's result as a message, so the inbox is only for new things they must do and "
  + "a person step is only an act the assistant may not take (sending, replying, posting, paying). When `assistant.commandLine` is true "
  + "the assistant writes and runs scripts and commands itself (no network inside them; the web through its own tools), so running code is "
  + "the assistant's step. Every firing starts in an empty folder (the previous run's files are readable, and there are none before the first "
  + "run): instructions that use a file the automation makes itself also say to write it when it is not there. `runNow` is true only when the "
  + "request asks for a run at once. A request that changes one in `existing` "
  + "answers with that whole automation, `replaces` set to its id and every part the request does not change copied from it. Answer in the "
  + "schema only.";

/** A stored trigger in the designer's own flat shape, so a request that changes one part of an automation can give the rest back unchanged. */
export function flatTrigger(trigger: Automation["trigger"]): AutomationPlan["trigger"] {
  const base = { type: trigger.type, time: "", days: "", hours: 0, from: "", keywords: "", url: "", event: "" };
  switch (trigger.type) {
    case "schedule": return { ...base, time: trigger.schedule.time,
      days: trigger.schedule.type === "daily" ? "DAILY" : trigger.schedule.type === "weekdays" ? "WEEKDAYS"
        : trigger.schedule.type === "monthly" ? monthlyDays(trigger.schedule) : trigger.schedule.days.join(",") };
    case "interval": return { ...base, hours: trigger.hours };
    case "mail": return { ...base, from: trigger.from, keywords: trigger.keywords.join(",") };
    case "watch": return { ...base, url: trigger.url, hours: trigger.hours };
    case "file": return { ...base, keywords: trigger.keywords.join(",") };
    case "task": return { ...base, event: trigger.event, from: trigger.lineId };
  }
}
const flatAction = (action: Automation["action"]): AutomationPlan["action"] => action.kind === "remind"
  ? { kind: "remind", instructions: "", reminder: action.text, category: "", outputs: "" }
  : { kind: "run", instructions: action.instructions, reminder: "", category: action.category, outputs: action.outputs.join("，") };

/** Changes from the settings card: pause, resume, delete, run now. */
export function setAutomationStatus(store: CrosslineStore, workspaceId: string, id: string, status: "active" | "off"): boolean {
  if (!read(store, workspaceId).some((item) => item.id === id)) return false;
  update(store, workspaceId, id, (item) => ({ ...item, status, updatedAt: new Date().toISOString() }));
  return true;
}
export function deleteAutomation(store: CrosslineStore, workspaceId: string, id: string): boolean {
  const list = read(store, workspaceId);
  if (!list.some((item) => item.id === id)) return false;
  write(store, workspaceId, list.filter((item) => item.id !== id));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `automation.deleted:${id}:${Date.now()}`, type: "automation.deleted", entityId: id, payload: {} });
  return true;
}

/** Starts one firing: the reminder said, or the assistant started with the instructions and what fired it. */
export function fire(deps: AutomationDeps, workspaceId: string, automation: Automation, why: Fire, retry = false): AutomationRun {
  const now = deps.now?.() ?? new Date();
  const base = { automationId: automation.id, firedAt: now.toISOString(), reason: why.reason };
  if (automation.action.kind === "remind") {
    sayToPerson(deps.store, workspaceId, automation.action.text, "automation_remind", `remind:${automation.id}:${now.toISOString().slice(0, 13)}`, [], now);
    update(deps.store, workspaceId, automation.id, (item) => ({ ...item, lastFiredAt: now.toISOString(), runs: item.runs + 1 }));
    const run = { ...base, taskId: "", state: "reminded" as const };
    noteRun(deps.store, workspaceId, run);
    return run;
  }
  const action = automation.action;
  const taskId = `${automation.id}-${now.getTime().toString(36)}`;
  // Each firing goes on in the automation's own conversation (a new turn on its thread, resumed at the time), told what the last run did
  // and given that run's files to read: a run that wakes up a week later carries on instead of starting over.
  const previous = automation.lastRun;
  const previousFiles = previous ? previous.files.slice(0, 8).map((file) => path.join(previous.directory, file)) : [];
  const inputs = [...(why.inputs ?? []), ...previousFiles];
  const note = previousRunNote(previous);
  const locale = localeOf(deps.store, workspaceId);
  const t = tFor(locale);
  const input: AgentTaskInput & { taskId: string } = {
    taskId, title: t("自动化「{{name}}」", { name: automation.name }), category: action.category as AgentCategory, lineId: automation.lineId,
    what: automationRunPrompt(action, why, note),
    humanPart: automation.steps.filter((step) => step.by === "person").map((step) => step.title).join(locale === "en" ? "; " : "；") || t("查看结果"),
    notes: `这是本人设的自动化，第 ${automation.runs + 1} 次运行。每次只做这一轮的事，结果写进任务目录。`, // i18n-ignore: model-facing
    ...(inputs.length ? { inputs } : {}), ...(automation.threadId ? { resumeThreadId: automation.threadId } : {})
  };
  const started = deps.runFree(workspaceId, input, (outcome) => {
    const at = deps.now?.() ?? new Date();
    // The run log said 「已开始」 for every run forever (2026-11-04): its entry now carries how the run ended.
    const ended = outcome.state === "done" ? "done" as const : outcome.state === "blocked" || outcome.state === "failed" ? "failed" as const : undefined;
    if (ended) deps.store.setSetting(workspaceId, AUTOMATION_RUNS_SETTING, JSON.stringify(runs(deps.store, workspaceId).map((run) => run.taskId === taskId
      ? { ...run, state: ended, ...(ended === "failed" ? { detail: ("message" in outcome ? outcome.message ?? "" : "").slice(0, 120) } : {}) } : run)));
    if (outcome.state === "done") {
      // The conversation and what this run made, for the next firing to go on from.
      update(deps.store, workspaceId, automation.id, (item) => ({ ...item, ...(outcome.threadId ? { threadId: outcome.threadId } : {}),
        lastRun: { taskId, at: at.toISOString(), summary: outcome.summary.summary.slice(0, 600), directory: outcome.directory,
          files: outcome.artifacts.map((artifact) => artifact.path).slice(0, 20) } }));
      const files = outcome.artifacts.slice(0, 4).map((artifact) => ({ label: artifact.path.split("/").pop() ?? artifact.path,
        href: `/api/agent/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(artifact.path)}` }));
      const done = t("自动化「{{name}}」跑完了：{{summary}}", { name: automation.name, summary: outcome.summary.summary.slice(0, 300) });
      sayToPerson(deps.store, workspaceId, outcome.reviewRequired ? `${done}\n${t("有需要本人看的地方，在待确认里。")}` : done,
        "automation_done", `automation-done:${taskId}`, [...files, ...(outcome.reviewRequired ? [{ label: t("去待确认"), href: "/approvals#assistant" }] : [])], at);
    } else if (outcome.state === "blocked" || outcome.state === "failed") {
      sayToPerson(deps.store, workspaceId, t("自动化「{{name}}」这次没跑完：{{reason}}", { name: automation.name, reason: (outcome.message || "").slice(0, 200) }), "automation_failed", `automation-failed:${taskId}`,
        [{ label: t("查看", { context: "view" }), href: "/automation" }], at);
    }
  });
  if (started.state === "started") {
    update(deps.store, workspaceId, automation.id, (item) => ({ ...item, lastFiredAt: now.toISOString(), runs: item.runs + 1 }));
    const run = { ...base, taskId, state: "started" as const };
    noteRun(deps.store, workspaceId, run);
    return run;
  }
  // The kind of work switched off, or an assistant that works only for the machine's owner: waiting will not change that, so the firing
  // is dropped (its time counts as taken, so a schedule does not refire every tick) and the person is told once why.
  if (started.state === "needs_category_approval" || started.code === "AGENT_OWNER_ONLY") {
    const code = started.state === "needs_category_approval" ? `category:${started.category}` : started.code;
    const detail = started.state === "needs_category_approval"
      ? t("助手的「{{category}}」已关闭，在设置里打开后才会运行", { category: t(started.label) }) : started.message;
    update(deps.store, workspaceId, automation.id, (item) => ({ ...item, lastFiredAt: now.toISOString() }));
    const run = { ...base, taskId: "", state: "skipped" as const, detail };
    noteRun(deps.store, workspaceId, run);
    const told = deps.store.appendEvent({ ownerId: ownerOf(deps.store, workspaceId), workspaceId, idempotencyKey: `automation.refused:${automation.id}:${code}`,
      type: "automation.refused", entityId: automation.id, payload: { code } });
    if (told.inserted) sayToPerson(deps.store, workspaceId, t("自动化「{{name}}」没有运行：{{detail}}。", { name: automation.name, detail }), "automation_failed",
      `automation-refused:${automation.id}:${code}`, [{ label: t("去设置"), href: "/automation" }], now);
    return run;
  }
  const run = { ...base, taskId: "", state: "queued" as const, detail: started.message };
  // A queued firing is noted once, when it first waits; its retries are noted only when one starts.
  if (!retry) noteRun(deps.store, workspaceId, run);
  return run;
}

/** A firing that has to wait (the assistant busy) is queued: a watched page's change, a new file or a task event is seen once, and would otherwise be lost. */
export function fireOrQueue(deps: AutomationDeps, workspaceId: string, automation: Automation, why: Fire): AutomationRun {
  const run = fire(deps, workspaceId, automation, why);
  if (run.state === "queued") saveQueue(deps.store, workspaceId, [...queue(deps.store, workspaceId), { ...why, automationId: automation.id, at: (deps.now?.() ?? new Date()).toISOString() }]);
  return run;
}

/** Firings that could not start (the assistant busy): retried on the next ticks, oldest first, for a day. */
export const QUEUE_SETTING = "automations.queue";
export type Queued = Fire & { automationId: string; at: string };
export const queue = (store: CrosslineStore, workspaceId: string): Queued[] => { try { return JSON.parse(store.getSetting(workspaceId, QUEUE_SETTING) ?? "[]") as Queued[]; } catch { return []; } };
export const saveQueue = (store: CrosslineStore, workspaceId: string, items: Queued[]) => store.setSetting(workspaceId, QUEUE_SETTING, JSON.stringify(items.slice(-30)));

/** New mail fired at the engine (from the mailbox pass): each matching automation is queued once per batch. */
export function onNewMail(store: CrosslineStore, workspaceId: string, messages: NewMail[], now = new Date()): number {
  const queued: Queued[] = [];
  for (const automation of read(store, workspaceId).filter((item) => item.status === "active" && item.trigger.type === "mail")) {
    const trigger = automation.trigger as Extract<Automation["trigger"], { type: "mail" }>;
    const hits = messages.filter((message) => mailMatches(trigger, message)).slice(-10);
    if (!hits.length) continue;
    queued.push({ automationId: automation.id, at: now.toISOString(), reason: tFor(localeOf(store, workspaceId))("收到 {{count}} 封符合条件的邮件", { count: hits.length }),
      // i18n-ignore: what the run is told (model-facing)
      context: `新邮件（可用 mail_read 按 id 读全文）：\n${hits.map((hit) => `- id ${hit.accountId}:${hit.uid} · ${hit.from} · 「${hit.subject}」 · ${hit.date.slice(0, 16)}\n  ${hit.snippet.slice(0, 200)}`).join("\n")}` });
  }
  if (queued.length) saveQueue(store, workspaceId, [...queue(store, workspaceId), ...queued]);
  return queued.length;
}

/**
 * One tick for one workspace: queued firings first, then each active automation's own trigger — a time, a page's text, new files,
 * task events. No daily count (the owner's decision of 2026-10-19): what bounds a run is the account's own quota or the sponsor's
 * monthly cap. The assistant runs one thing at a time; what cannot start waits.
 */
export async function automationPass(deps: AutomationDeps, workspaceId: string): Promise<AutomationRun[]> {
  const now = deps.now?.() ?? new Date();
  const locale = localeOf(deps.store, workspaceId);
  const t = tFor(locale);
  const fired: AutomationRun[] = [];
  const active = () => read(deps.store, workspaceId).filter((item) => item.status === "active");
  // Queued firings, for a day.
  const waiting = queue(deps.store, workspaceId).filter((item) => now.getTime() - Date.parse(item.at) < 86_400_000);
  const left: Queued[] = [];
  for (const item of waiting) {
    const automation = active().find((entry) => entry.id === item.automationId);
    if (!automation) continue;
    const run = fire(deps, workspaceId, automation, item, true);
    fired.push(run);
    if (run.state === "queued") left.push(item);
  }
  saveQueue(deps.store, workspaceId, left);
  const busy = () => fired.some((run) => run.state === "queued");
  for (const automation of active()) {
    if (busy()) break;
    const { trigger } = automation;
    if (trigger.type === "schedule" || trigger.type === "interval") {
      if (timeTriggerDue(automation, now, deps.zone(workspaceId))) fired.push(fireOrQueue(deps, workspaceId, automation, { reason: trigger.type === "schedule" ? t("到了设定时间（{{when}}）", { when: triggerLabel(trigger, locale) }) : triggerLabel(trigger, locale), context: "" }));
    } else if (trigger.type === "watch") {
      if (!timeTriggerDue(automation, now, deps.zone(workspaceId))) continue;
      const page = await safeGet(trigger.url, deps.fetch ?? defaultSafeGetDeps(), { maxBytes: 3_000_000, timeoutMs: 20_000 }).catch(() => undefined);
      if (!page?.ok) {
        const lastError = page ? page.reason : t("打不开");
        update(deps.store, workspaceId, automation.id, (item) => ({ ...item, watch: { ...(item.watch ?? { hash: "", excerpt: "" }), checkedAt: now.toISOString(), lastError } }));
        continue;
      }
      const text = page.contentType.includes("html") ? htmlToText(new TextDecoder().decode(page.bytes)) : new TextDecoder().decode(page.bytes);
      const hash = createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
      const before = automation.watch;
      update(deps.store, workspaceId, automation.id, (item) => ({ ...item, watch: { hash, checkedAt: now.toISOString(), excerpt: text.slice(0, 6000) } }));
      // The first read is the baseline; a change after it fires, with the lines that are new.
      if (before?.hash && before.hash !== hash) {
        const added = addedLines(before.excerpt, text.slice(0, 6000));
        fired.push(fireOrQueue(deps, workspaceId, automation, { reason: t("{{url}} 的内容变了", { url: trigger.url }),
          // i18n-ignore: what the run is told (model-facing)
          context: `页面 ${trigger.url} 新出现的内容：\n${added.length ? added.map((line) => `- ${line}`).join("\n") : "（文字有改动，但没有整行新增；用 web_fetch 打开页面看）"}` }));
      }
    } else if (trigger.type === "file") {
      const since = automation.lastFiredAt ?? automation.createdAt;
      const docs = deps.store.listSourceDocuments(workspaceId).filter((doc) => doc.createdAt > since && doc.extractionStatus !== "pending"
        && fileMatches(trigger, { fileName: doc.fileName, text: doc.extractedText }));
      if (docs.length) fired.push(fireOrQueue(deps, workspaceId, automation, { reason: t("新添加了 {{count}} 个文件", { count: docs.length }),
        // i18n-ignore: what the run is told (model-facing)
        context: `新文件（用 read_document 按 id 读）：\n${docs.slice(0, 20).map((doc) => `- id ${doc.id} · ${doc.fileName}`).join("\n")}`,
        inputs: docs.slice(0, 20).map((doc) => doc.uri.replace(/^file:\/\//, "")) }));
    } else if (trigger.type === "task") {
      const since = automation.lastFiredAt ?? automation.createdAt;
      const orders = new Map(deps.store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
      const title = (id: string) => (orders.get(id)?.payload as { title?: string } | undefined)?.title ?? orders.get(id)?.intent.slice(0, 60) ?? id;
      const ofLine = (id: string) => !trigger.lineId || orders.get(id)?.identityId === trigger.lineId;
      if (trigger.event === "accepted") {
        const done = deps.store.listEvents(workspaceId, { type: "work_order.transitioned" })
          .filter((event) => event.createdAt > since && (event.payload as { to?: string }).to === "accepted" && ofLine(event.entityId)).map((event) => event.entityId);
        if (done.length) fired.push(fireOrQueue(deps, workspaceId, automation, { reason: t("{{count}} 个任务完成验收", { count: done.length }),
          // i18n-ignore: what the run is told (model-facing)
          context: `完成的任务（用 read_task 按 id 读）：\n${[...new Set(done)].slice(0, 10).map((id) => `- id ${id} · ${title(id)}`).join("\n")}` }));
      } else {
        const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: deps.zone(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now.getTime() + 86_400_000));
        const lastDay = automation.lastFiredAt ? new Intl.DateTimeFormat("en-CA", { timeZone: deps.zone(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(automation.lastFiredAt)) : "";
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: deps.zone(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
        const due = [...orders.values()].filter((order) => !["accepted", "archived"].includes(order.state) && (order.payload as { dueDate?: string }).dueDate === tomorrow && ofLine(order.id));
        if (due.length && lastDay !== today) fired.push(fireOrQueue(deps, workspaceId, automation, { reason: t("{{count}} 个任务明天到期", { count: due.length }),
          // i18n-ignore: what the run is told (model-facing)
          context: `明天到期的任务（用 read_task 按 id 读）：\n${due.slice(0, 10).map((order) => `- id ${order.id} · ${title(order.id)}`).join("\n")}` }));
      }
    }
  }
  if (fired.length) deps.log?.({ type: "automation.pass", workspaceId, fired: fired.map((run) => ({ id: run.automationId, state: run.state })) });
  return fired;
}

/** The supervisor's `/v1/automations*` routes. */
export function createAutomationService(deps: AutomationDeps & { afterRequest?: (workspaceId: string) => void }) {
  return {
    async handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
      if (method === "GET" && pathname === "/v1/automations") return { status: 200, body: automationsView(deps.store, workspaceId) };
      if (method === "POST" && pathname === "/v1/automations") {
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        const lineId = typeof body?.lineId === "string" ? body.lineId : "";
        if (!text) return { status: 400, body: { ok: false, blocker: { code: "AUTOMATION_TEXT_REQUIRED", message: tFor(localeOf(deps.store, workspaceId))("写一句想让它做什么、什么时候做。") } } };
        const requestId = requestAutomation(deps.store, workspaceId, text, lineId, ownerOf(deps.store, workspaceId));
        deps.afterRequest?.(workspaceId);
        return { status: 200, body: { ok: true, requestId } };
      }
      if (method === "POST" && pathname === "/v1/automations/design") { deps.afterRequest?.(workspaceId); return { status: 202, body: { ok: true } }; }
      const one = /^\/v1\/automations\/(auto-[a-z0-9]{1,16})(\/(run|status))?$/.exec(pathname);
      if (!one) return undefined;
      const id = one[1]!;
      if (method === "DELETE" && !one[2]) return { status: 200, body: { ok: deleteAutomation(deps.store, workspaceId, id) } };
      if (method === "POST" && one[3] === "status") return { status: 200, body: { ok: setAutomationStatus(deps.store, workspaceId, id, body?.status === "off" ? "off" : "active") } };
      if (method === "POST" && one[3] === "run") {
        const automation = read(deps.store, workspaceId).find((item) => item.id === id);
        const t = tFor(localeOf(deps.store, workspaceId));
        if (!automation) return { status: 404, body: { ok: false, blocker: { code: "AUTOMATION_NOT_FOUND", message: t("找不到这个自动化。") } } };
        // The assistant busy: the firing waits in the queue like any other instead of being lost.
        const run = fireOrQueue(deps, workspaceId, automation, { reason: t("本人点了立即运行"),
          context: automation.trigger.type === "watch" ? `要看的页面：${automation.trigger.url}` : "" }); // i18n-ignore: model-facing
        return { status: 200, body: { ok: run.state !== "skipped", run } };
      }
      return undefined;
    }
  };
}

/**
 * The automations grow from use too: when the assistant has had the same kind of errand on one line done twice and both were taken
 * (`growCandidates`' own rule), the person is asked once whether to make it automatic; 「建成自动化」 sends the request through the input
 * box's own action, so the designer takes it up like anything they said. Where the shell assistant works, the errand is grown into a
 * workflow instead (workflow-smith.ts), so this is for everyone else.
 */
/** At most one 「建成自动化」 suggestion in this long: they are a courtesy, and four in a row buried the 小帮手's page (2026-10-28). */
const SUGGEST_GAP_MS = 7 * 86_400_000;
/** A pattern is worth automating only when it served this many different pieces of work, not one task's retries. */
const SUGGEST_MIN_ORDERS = 3;

export function suggestFromRepeats(store: CrosslineStore, workspaceId: string, candidates: Array<{ lineId: string; text: string; origin: { kind: string; taskIds?: string[] } }>, now = new Date()): number {
  const events = store.listEvents(workspaceId, { type: "automation.suggested" });
  const suggested = new Set(events.map((event) => event.entityId));
  // Runs already offered once are not offered again under a bigger set: the key used to be the set itself, so every further accepted
  // run of the same errand asked again (2026-10-28: four suggestions for the NeuroSim and sample-pack errands, 2→3→5 runs).
  const offered = new Set(events.flatMap((event) => (event.payload as { taskIds?: string[] }).taskIds ?? []));
  const last = events.map((event) => Date.parse(event.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? 0;
  if (now.getTime() - last < SUGGEST_GAP_MS) return 0;
  const orderOf = new Map(listAgentTasks(store, workspaceId, now).map((row) => [row.taskId, row.workOrderId ?? row.taskId]));
  let made = 0;
  for (const candidate of candidates) {
    if (made) break;
    if (candidate.origin.kind !== "repeated" || !candidate.origin.taskIds?.length) continue;
    if (candidate.origin.taskIds.some((id) => offered.has(id))) continue;
    const orders = new Set(candidate.origin.taskIds.map((id) => orderOf.get(id) ?? id));
    if (orders.size < SUGGEST_MIN_ORDERS) continue;
    const key = `sugg-${createHash("sha256").update([...candidate.origin.taskIds].sort().join(",")).digest("hex").slice(0, 12)}`;
    if (suggested.has(key)) continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `automation.suggested:${key}`, type: "automation.suggested", entityId: key,
      payload: { lineId: candidate.lineId, text: candidate.text.slice(0, 300), taskIds: candidate.origin.taskIds } });
    const t = tFor(localeOf(store, workspaceId));
    const text = t("以后自动做这类事：{{text}}", { text: candidate.text.slice(0, 200) });
    sayToPerson(store, workspaceId, t("助手已经做过 {{count}} 次类似的事（{{text}}），都已采纳。要不要以后自动做？可以按时做，也可以在有新邮件、新文件或任务完成时做。", { count: orders.size, text: candidate.text.slice(0, 80) }),
      "automation_suggest", key, [{ label: t("建成自动化"), action: { action: "workflow.request", summary: text.slice(0, 200),
        args: { text, lineId: candidate.lineId, reminder: "", time: "", weekdays: [] } } }, { label: t("去设置里写清楚"), href: "/automation" }], now);
    made += 1;
  }
  return made;
}
