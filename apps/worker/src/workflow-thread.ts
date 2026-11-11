import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_CATEGORIES, AUTOMATIONS_MAX, AUTOMATIONS_SETTING, WEEKDAYS, WORKFLOW_TURN_SCHEMA, monthlyFromDays, nextScheduleTimes, readAutomations, tFor, triggerLabel,
  validateWorkflowTurn, type Automation, type WorkflowSchedule, type WorkflowThread, type WorkflowTurnAnswer, type WorkflowTurnItem, type Weekday
} from "@crossline/core";
import { continueSkillTurn, runCodexSkill, type SkillRunResult, type SkillTools } from "@crossline/codex";
import { addWorkflowFeedback, currentGrownFiles, readGrownSkills, type CrosslineStore } from "@crossline/db";
import { AUTOMATION_DESIGNER_SKILL, DESIGN_INSTRUCTIONS, fireOrQueue, flatTrigger, installAutomation, type AutomationDeps } from "./automations";
import { identityLines } from "./lines";
import { localeOf } from "./locale";
import { ownerOf } from "./owner";

/**
 * A workflow's own conversation (the 自动化 page, 2026-11-10): the person makes or changes a workflow by talking with the designer, turn
 * after turn, on one Codex thread kept for it. Each turn streams into the ledger (`workflow_turns`) as it is written, with every lookup the
 * designer made shown as a tool call; a turn that changes an automation puts the whole new definition in force through the same install
 * the request path uses, and that change is a version (`workflow_versions`). A grown workflow's files are never written here: a turn that
 * asks for a change hands it to the improver (`skill.grown.feedback`), which revises, scans and reviews it like a new one.
 */
export type WorkflowThreadDeps = AutomationDeps & { improveNow?: (workspaceId: string) => void };

const running = new Set<string>();
const AUTHOR_INSTRUCTIONS = `${DESIGN_INSTRUCTIONS} `
  + "This run is a conversation about one workflow (`workflow`, `current`; empty when it is being made): answer every message in `reply`, "
  + "short, to the person. When the person asks for a change and you know enough, set `change` to `automation` and give the whole automation "
  + "in `plan` (every part they did not ask to change copied from `current`). When something only the person can say is missing, ask in "
  + "`reply` and set `change` to `none` (fill `plan` from `current`, or with empty values). A grown workflow (`workflow.kind` = grown) is "
  + "changed by writing what to change in `revision` with `change` = `revise`: you never edit its files. Use the tools to read the workflow, "
  + "its versions and when a schedule fires instead of guessing. Messages after the first are JSON: `request` is what the person said, "
  + "`current` the workflow as it is now (it may have been rolled back since). Answer in the schema only.";

type Request = { threadId?: string; workflowId?: string; text: string; lineId?: string };
type Started = { ok: true; threadId: string; turnId: string; done: Promise<void> } | { ok: false; status: number; code: string; message: string };

/** The workflow a conversation is about, as the designer is shown it. */
function currentOf(store: CrosslineStore, workspaceId: string, thread: WorkflowThread) {
  if (!thread.workflowId) return { kind: thread.kind, state: "new" as const };
  if (thread.kind === "automation") {
    const item = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING)).find((entry) => entry.id === thread.workflowId);
    if (!item) return { kind: thread.kind, state: "deleted" as const };
    const locale = localeOf(store, workspaceId);
    return { kind: thread.kind, state: "exists" as const, id: item.id, name: item.name, summary: item.summary, lineId: item.lineId, status: item.status,
      when: triggerLabel(item.trigger, locale), trigger: flatTrigger(item.trigger),
      action: item.action.kind === "remind" ? { kind: "remind", instructions: "", reminder: item.action.text, category: "", outputs: "" }
        : { kind: "run", instructions: item.action.instructions, reminder: "", category: item.action.category, outputs: item.action.outputs.join("，") },
      steps: item.steps, runs: item.runs, ...(item.lastRun ? { lastRun: { at: item.lastRun.at, summary: item.lastRun.summary.slice(0, 300) } } : {}) };
  }
  const record = readGrownSkills(store, workspaceId).find((entry) => entry.id === thread.workflowId);
  if (!record) return { kind: thread.kind, state: "deleted" as const };
  return { kind: thread.kind, state: "exists" as const, id: record.id, version: record.version ?? 1, status: record.status, manifest: record.manifest,
    files: currentGrownFiles(store, workspaceId, record.id).map((file) => ({ path: file.path, chars: file.text.length })) };
}

/** The schedule a designer is checking, in its own flat words (`DAILY`, `WEEKDAYS`, `MO,FR`, `MONTHLY:15`). */
function scheduleFromWords(days: string, time: string): WorkflowSchedule | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined;
  const monthly = monthlyFromDays(days, time);
  if (monthly) return monthly;
  if (!days.trim() || /DAILY/i.test(days)) return { type: "daily", time };
  if (/WEEKDAYS/i.test(days)) return { type: "weekdays", time };
  const list = days.toUpperCase().split(/[,，\s]+/).filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day));
  return list.length ? { type: "weekly", days: list, time } : undefined;
}

function toolsFor(deps: WorkflowThreadDeps, workspaceId: string, thread: () => WorkflowThread, record: (item: WorkflowTurnItem) => void): SkillTools {
  const store = deps.store;
  const answer = (name: string, args: Record<string, unknown>): string => {
    const current = thread();
    if (name === "current_workflow") return JSON.stringify(currentOf(store, workspaceId, current));
    if (name === "list_versions") {
      if (!current.workflowId) return "[]";
      return JSON.stringify(current.kind === "automation"
        ? store.listWorkflowVersions(workspaceId, "automation", current.workflowId).map((item) => ({ version: item.version, at: item.createdAt, source: item.source, note: item.note }))
        : store.listWorkflowVersions(workspaceId, "grown", current.workflowId).map((item) => ({ version: item.version, at: item.createdAt, note: item.note })));
    }
    if (name === "next_times") {
      const schedule = scheduleFromWords(String(args.days ?? ""), String(args.time ?? ""));
      if (!schedule) throw new Error("time must be HH:MM; days DAILY, WEEKDAYS, MO,FR or MONTHLY:15");
      const zone = deps.zone(workspaceId);
      const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      return JSON.stringify({ timeZone: zone, next: nextScheduleTimes(schedule, deps.now?.() ?? new Date(), zone).map((iso) => format.format(new Date(iso))) });
    }
    if (name === "read_workflow_file") {
      if (current.kind !== "grown" || !current.workflowId) throw new Error("only a grown workflow has files");
      const file = currentGrownFiles(store, workspaceId, current.workflowId).find((item) => item.path === String(args.path ?? ""));
      if (!file) throw new Error("no such file");
      return file.text.slice(0, 20_000);
    }
    throw new Error(`no tool ${name}`);
  };
  const empty = { type: "object", properties: {}, required: [], additionalProperties: false };
  return {
    specs: [
      { name: "current_workflow", description: "The workflow as it is now: its definition, or a grown workflow's manifest and file list.", inputSchema: empty },
      { name: "list_versions", description: "The workflow's versions: number, when, why.", inputSchema: empty },
      { name: "next_times", description: "When a schedule would fire next, in the person's time zone.", inputSchema: { type: "object", additionalProperties: false, required: ["time", "days"],
        properties: { time: { type: "string", description: "HH:MM" }, days: { type: "string", description: "DAILY, WEEKDAYS, MO,FR, MONTHLY:15 or QUARTERLY:1" } } } },
      { name: "read_workflow_file", description: "One file of a grown workflow, by its path.", inputSchema: { type: "object", additionalProperties: false, required: ["path"],
        properties: { path: { type: "string" } } } }
    ],
    call: (name, raw) => {
      const args = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const shown = JSON.stringify(args).slice(0, 300);
      try {
        const result = answer(name, args);
        record({ type: "tool", name, args: shown, result: result.slice(0, 600), ok: true });
        return result;
      } catch (error) {
        record({ type: "tool", name, args: shown, result: error instanceof Error ? error.message : String(error), ok: false });
        throw error;
      }
    }
  };
}

/** The `reply` of a structured answer while it is still being written (the answer's first field), for the page to show as it streams. */
export function streamedReply(partial: string): string {
  const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partial);
  if (!match) return "";
  const body = match[1]!.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "");
  try { return JSON.parse(`"${body}"`) as string; } catch { return body; }
}

/** Starts one turn: the person's words are kept at once, and the answer streams into the ledger while `done` runs. */
export function startWorkflowTurn(deps: WorkflowThreadDeps, workspaceId: string, request: Request): Started {
  const store = deps.store;
  const t = tFor(localeOf(store, workspaceId));
  const text = request.text.trim().slice(0, 2000);
  if (!text) return { ok: false, status: 400, code: "WORKFLOW_TEXT_REQUIRED", message: t("写一句想让它怎么做。") };
  const now = (deps.now?.() ?? new Date()).toISOString();
  let thread = request.threadId ? store.getWorkflowThread(workspaceId, request.threadId) : undefined;
  if (request.threadId && !thread) return { ok: false, status: 404, code: "WORKFLOW_THREAD_NOT_FOUND", message: t("找不到这段对话。") };
  if (!thread && request.workflowId) {
    const automation = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING)).find((item) => item.id === request.workflowId);
    const grown = automation ? undefined : readGrownSkills(store, workspaceId).find((item) => item.id === request.workflowId);
    if (!automation && !grown) return { ok: false, status: 404, code: "WORKFLOW_NOT_FOUND", message: t("找不到这个工作流。") };
    thread = store.findWorkflowThread(workspaceId, request.workflowId) ?? { workspaceId, id: `wthr-${randomUUID().slice(0, 10)}`, workflowId: request.workflowId,
      kind: automation ? "automation" : "grown", codexThreadId: "", lineId: automation?.lineId ?? grown?.lines[0] ?? "", title: automation?.name ?? grown?.manifest.summary ?? "",
      createdAt: now, updatedAt: now };
  }
  thread ??= { workspaceId, id: `wthr-${randomUUID().slice(0, 10)}`, workflowId: "", kind: "automation", codexThreadId: "", lineId: request.lineId ?? "",
    title: text.slice(0, 200), createdAt: now, updatedAt: now };
  const key = `${workspaceId}:${thread.id}`;
  const turns = store.listWorkflowTurns(workspaceId, thread.id);
  // A request's answer still being designed belongs to the design pass; a turn left running by a worker that stopped is closed here.
  if (running.has(key) || turns.some((turn) => turn.state === "running" && turn.id.endsWith("-reply"))) {
    return { ok: false, status: 409, code: "WORKFLOW_TURN_RUNNING", message: t("上一句还在回答，等它说完再说。") };
  }
  for (const turn of turns.filter((item) => item.state === "running")) store.saveWorkflowTurn({ ...turn, state: "failed", text: turn.text || t("后台进程重启，这次回答中断") });
  store.saveWorkflowThread(thread);
  const id = `turn-${randomUUID().slice(0, 12)}`;
  store.saveWorkflowTurn({ workspaceId, id, threadId: thread.id, role: "person", text, items: [], state: "done", createdAt: now });
  store.saveWorkflowTurn({ workspaceId, id: `${id}-a`, threadId: thread.id, role: "assistant", text: "", items: [], state: "running", createdAt: now });
  running.add(key);
  const done = runTurn(deps, workspaceId, thread.id, id, text).finally(() => running.delete(key));
  return { ok: true, threadId: thread.id, turnId: `${id}-a`, done };
}

async function runTurn(deps: WorkflowThreadDeps, workspaceId: string, threadId: string, personTurnId: string, text: string): Promise<void> {
  const store = deps.store;
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const replyId = `${personTurnId}-a`;
  const createdAt = (deps.now?.() ?? new Date()).toISOString();
  const thread = () => store.getWorkflowThread(workspaceId, threadId)!;
  const items: WorkflowTurnItem[] = [];
  let shown = "";
  const save = (state: "running" | "done" | "failed", words = shown) => store.saveWorkflowTurn({ workspaceId, id: replyId, threadId, role: "assistant", text: words, items, state, createdAt });
  try {
    const client = deps.client(workspaceId);
    if (!client) { save("failed", t("模型还没有连上，连上后再说一次。")); return; }
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label }));
    const context = () => ({ kind: thread().kind, workflowId: thread().workflowId, lineIds: lines.map((line) => line.id) });
    const tools = toolsFor(deps, workspaceId, thread, (item) => { items.push(item); save("running"); });
    const onProgress = (progress: { text: string }) => { const reply = streamedReply(progress.text); if (reply && reply !== shown) { shown = reply; save("running"); } };
    const onAudit = (audit: { threadId?: string }) => {
      if (audit.threadId && audit.threadId !== thread().codexThreadId) store.saveWorkflowThread({ ...thread(), codexThreadId: audit.threadId, updatedAt: new Date().toISOString() });
    };
    const message = JSON.stringify({ request: text, current: currentOf(store, workspaceId, thread()) });
    const fresh = () => {
      const history = store.listWorkflowTurns(workspaceId, threadId).filter((turn) => turn.id !== personTurnId && turn.id !== replyId && turn.text)
        .slice(-12).map((turn) => ({ role: turn.role, text: turn.text.slice(0, 1500) }));
      const input = { workflow: { kind: thread().kind, id: thread().workflowId }, current: currentOf(store, workspaceId, thread()), lines, lineHint: thread().lineId,
        today: createdAt.slice(0, 10), timeZone: deps.zone(workspaceId), categories: Object.entries(AGENT_CATEGORIES).map(([id, label]) => ({ id, label })),
        connected: { mail: Boolean(store.getSetting(workspaceId, "mail.accounts")?.includes("\"id\"")) }, assistant: { commandLine: Boolean(deps.shell?.(workspaceId)) },
        conversation: history, request: text };
      return runCodexSkill<WorkflowTurnAnswer>(client, input, { skillName: AUTOMATION_DESIGNER_SKILL, cwd: deps.cwd, keepThread: true, locale, secondPerson: ["reply"],
        developerInstructions: AUTHOR_INSTRUCTIONS, outputSchema: WORKFLOW_TURN_SCHEMA as unknown as Record<string, unknown>, prepareInput: () => input,
        validateOutput: (output) => validateWorkflowTurn(output, context()), onAudit, onProgress, tools, timeoutMs: 30 * 60_000 });
    };
    let result: SkillRunResult<WorkflowTurnAnswer> = thread().codexThreadId
      ? await continueSkillTurn<WorkflowTurnAnswer>(client, thread().codexThreadId, message, { skillName: AUTOMATION_DESIGNER_SKILL, cwd: deps.cwd, locale,
        outputSchema: WORKFLOW_TURN_SCHEMA, validateOutput: (output) => validateWorkflowTurn(output, context()), onAudit, onProgress, tools, timeoutMs: 30 * 60_000 })
      : await fresh();
    // The runtime no longer has the thread (a restart): a new one, given the conversation so far.
    if (!result.ok && result.blocker.code === "SKILL_THREAD_LOST") { store.saveWorkflowThread({ ...thread(), codexThreadId: "" }); result = await fresh(); }
    if (!result.ok) { save("failed", shown || result.blocker.message || t("这次没有回答成功")); return; }
    shown = result.output.reply;
    apply(deps, workspaceId, thread(), result.output, replyId, items, t);
    save("done");
  } catch (error) {
    save("failed", shown || (error instanceof Error ? error.message : t("这次没有回答成功")));
  }
}

function apply(deps: WorkflowThreadDeps, workspaceId: string, thread: WorkflowThread, answer: WorkflowTurnAnswer, turnId: string, items: WorkflowTurnItem[], t: ReturnType<typeof tFor>): void {
  const store = deps.store;
  const now = deps.now?.() ?? new Date();
  if (answer.change === "revise") {
    if (!addWorkflowFeedback(store, workspaceId, thread.workflowId, answer.revision, now)) { items.push({ type: "status", text: t("找不到这个工作流，没有交出修改") }); return; }
    deps.improveNow?.(workspaceId);
    items.push({ type: "status", text: t("已交给助手改：改好并通过扫描与审查后成为新版本，会在这里出现") });
    return;
  }
  if (answer.change !== "automation") return;
  const plan = answer.plan;
  const list = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
  const previous = thread.workflowId ? list.find((item) => item.id === thread.workflowId) : undefined;
  if (thread.workflowId && !previous) { items.push({ type: "status", text: t("这个工作流已删除，没有改动") }); return; }
  if (!previous && list.length >= AUTOMATIONS_MAX) { items.push({ type: "status", text: t("已经有 {{count}} 个自动化，先删掉不用的。", { count: AUTOMATIONS_MAX }) }); return; }
  const id = previous?.id ?? `auto-${createHash("sha256").update(`${workspaceId}:${thread.id}`).digest("hex").slice(0, 8)}`;
  const before = store.listWorkflowVersions(workspaceId, "automation", id).length;
  const firstWords = store.listWorkflowTurns(workspaceId, thread.id).find((turn) => turn.role === "person")?.text ?? "";
  const { automation } = installAutomation(store, workspaceId, plan, id, { kind: "asked", text: firstWords, requestId: thread.id }, previous, now);
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `automation.${previous ? "changed" : "created"}:${turnId}`,
    type: previous ? "automation.changed" : "automation.created", entityId: id, payload: { requestId: thread.id, turnId, name: plan.name, trigger: plan.trigger.type, action: plan.action.kind } });
  if (store.listWorkflowVersions(workspaceId, "automation", id).length > before) {
    const version = store.annotateWorkflowVersion(workspaceId, "automation", id, { source: "thread", note: plan.summary, turnId });
    if (version) items.push({ type: "version", version, note: plan.summary });
  } else items.push({ type: "status", text: automation.status === "off" ? t("已暂停，内容没有变") : t("内容没有变，没有新版本") });
  if (!thread.workflowId) store.saveWorkflowThread({ ...thread, workflowId: id, lineId: plan.lineId, title: plan.name, updatedAt: now.toISOString() });
  if (plan.runNow && automation.status === "active") fireOrQueue(deps, workspaceId, automation as Automation, { reason: t("本人要求建好后先跑一次"), context: "" });
}

/** The supervisor's `/v1/workflow-threads` route: `POST { threadId? | workflowId?, text, lineId? }` starts a turn and answers at once. */
export function createWorkflowThreadService(deps: WorkflowThreadDeps) {
  return {
    async handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
      if (method !== "POST" || pathname !== "/v1/workflow-threads/turn") return undefined;
      const text = typeof body?.text === "string" ? body.text : "";
      const pick = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
      const threadId = pick(body?.threadId), workflowId = pick(body?.workflowId), lineId = pick(body?.lineId);
      const started = startWorkflowTurn(deps, workspaceId, { text, ...(threadId ? { threadId } : {}), ...(workflowId ? { workflowId } : {}), ...(lineId ? { lineId } : {}) });
      if (!started.ok) return { status: started.status, body: { ok: false, blocker: { code: started.code, message: started.message } } };
      void started.done.catch(() => undefined);
      return { status: 202, body: { ok: true, threadId: started.threadId, turnId: started.turnId } };
    }
  };
}
