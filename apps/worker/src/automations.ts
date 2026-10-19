import { createHash } from "node:crypto";
import {
  AUTOMATION_PLAN_SCHEMA, AUTOMATION_RUNS_PER_DAY, AUTOMATION_RUNS_SETTING, AUTOMATIONS_MAX, AUTOMATIONS_SETTING, AGENT_CATEGORIES, addedLines, fileMatches,
  mailMatches, readAutomationRuns, readAutomations, timeTriggerDue, triggerLabel, validateAutomationPlan,
  type AgentCategory, type Automation, type AutomationRun
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { approveCategory, readCategories, requestAutomation, type CrosslineStore } from "@crossline/db";
import type { AgentOutcome, AgentTaskInput } from "./agent-task";
import type { DispatchResult } from "./agent-service";
import { identityLines } from "./lines";
import type { NewMail } from "./mailbox";
import { ownerOf } from "./owner";
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
export type AutomationDeps = {
  store: CrosslineStore; cwd: string;
  client: (workspaceId: string) => CodexRpcBoundary | undefined;
  runFree: (workspaceId: string, input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void) => DispatchResult;
  zone: (workspaceId: string) => string;
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

const pendingRequests = (store: CrosslineStore, workspaceId: string) => {
  const settled = new Set([...store.listEvents(workspaceId, { type: "automation.created" }), ...store.listEvents(workspaceId, { type: "automation.design_failed" })]
    .map((event) => String((event.payload as { requestId?: string }).requestId ?? "")));
  return store.listEvents(workspaceId, { type: "automation.requested" }).filter((event) => !settled.has(event.entityId));
};

/** What the person sees and controls on the settings card. */
export function automationsView(store: CrosslineStore, workspaceId: string) {
  return { automations: read(store, workspaceId).map((item) => ({ ...item, triggerLabel: triggerLabel(item.trigger) })),
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
  const fail = (reason: string) => {
    deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `automation.design_failed:${requestId}`, type: "automation.design_failed", entityId: requestId, payload: { requestId, reason } });
    sayToPerson(deps.store, workspaceId, `没能把「${text.slice(0, 60)}」建成自动化：${reason}`, "automation_failed", `automation-failed:${requestId}`, [{ label: "去设置", href: "/settings#automation" }], now);
    return { state: "failed" };
  };
  const existing = read(deps.store, workspaceId);
  if (existing.length >= AUTOMATIONS_MAX) return fail(`已经有 ${AUTOMATIONS_MAX} 个自动化，先删掉不用的。`);
  const client = deps.client(workspaceId);
  if (!client) return { state: "waiting" };
  const lines = identityLines(deps.store, workspaceId).map((line) => ({ id: line.id, label: line.label }));
  const input = { request: text, lineHint, lines, today: now.toISOString().slice(0, 10), timeZone: deps.zone(workspaceId),
    categories: Object.entries(AGENT_CATEGORIES).map(([id, label]) => ({ id, label })),
    connected: { mail: Boolean(deps.store.getSetting(workspaceId, "mail.accounts")?.includes("\"id\"")) } };
  const result = await runCodexSkill<ReturnType<typeof validateAutomationPlan>>(client, input, {
    skillName: AUTOMATION_DESIGNER_SKILL, cwd: deps.cwd, outputSchema: AUTOMATION_PLAN_SCHEMA as unknown as Record<string, unknown>,
    developerInstructions: "Turn the request into one automation: a trigger Crossline can watch and an action the assistant can do with its functions. Answer in the schema only.",
    prepareInput: () => input, validateOutput: (output) => validateAutomationPlan(output, lines.map((line) => line.id)), onAudit: () => {}, timeoutMs: 30 * 60_000
  });
  if (!result.ok) return result.blocker.code.startsWith("SKILL_") || result.blocker.code.startsWith("MODEL_") || result.blocker.code.startsWith("RUNTIME_")
    ? { state: "waiting" } : fail(result.blocker.message);
  const plan = result.output;
  const id = `auto-${createHash("sha256").update(requestId).digest("hex").slice(0, 8)}`;
  const automation: Automation = { id, name: plan.name, summary: plan.summary, lineId: plan.lineId, status: "active", trigger: plan.trigger, action: plan.action, steps: plan.steps,
    origin: { kind: "asked", text, requestId }, createdAt: now.toISOString(), updatedAt: now.toISOString(), runs: 0 };
  write(deps.store, workspaceId, [...read(deps.store, workspaceId).filter((item) => item.id !== id), automation]);
  // The person asked for this in words: the kind of work it does is allowed by that request (said in the message, switchable in 设置).
  const allowed = automation.action.kind === "run" && !readCategories(deps.store, workspaceId)[automation.action.category];
  if (automation.action.kind === "run" && allowed) approveCategory(deps.store, workspaceId, automation.action.category);
  deps.store.appendEvent({ ownerId, workspaceId, idempotencyKey: `automation.created:${id}`, type: "automation.created", entityId: id,
    payload: { requestId, name: plan.name, trigger: plan.trigger.type, action: plan.action.kind } });
  const person = plan.steps.filter((step) => step.by === "person").map((step) => step.title);
  sayToPerson(deps.store, workspaceId, [`已建好自动化「${plan.name}」：${triggerLabel(plan.trigger)}，${plan.summary}`,
    person.length ? `其中「${person.join("」「")}」由本人完成。` : "", allowed && automation.action.kind === "run" ? `已按这个请求为助手开启「${AGENT_CATEGORIES[automation.action.category]}」。` : "",
    plan.assumptions ? `按以下理解建立：${plan.assumptions}` : ""].filter(Boolean).join("\n"), "automation_created", `automation:${id}`,
  [{ label: "查看与修改", href: "/settings#automation" }], now);
  return { state: "created", id };
}

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

const firedToday = (store: CrosslineStore, workspaceId: string, id: string, now: Date) =>
  runs(store, workspaceId).filter((run) => run.automationId === id && run.state !== "skipped" && now.getTime() - Date.parse(run.firedAt) < 86_400_000).length;

/** Starts one firing: the reminder said, or the assistant started with the instructions and what fired it. */
export function fire(deps: AutomationDeps, workspaceId: string, automation: Automation, why: Fire, force = false): AutomationRun {
  const now = deps.now?.() ?? new Date();
  const base = { automationId: automation.id, firedAt: now.toISOString(), reason: why.reason };
  if (!force && firedToday(deps.store, workspaceId, automation.id, now) >= AUTOMATION_RUNS_PER_DAY) {
    const run = { ...base, taskId: "", state: "skipped" as const, detail: `今天已运行 ${AUTOMATION_RUNS_PER_DAY} 次` };
    noteRun(deps.store, workspaceId, run);
    return run;
  }
  if (automation.action.kind === "remind") {
    sayToPerson(deps.store, workspaceId, automation.action.text, "automation_remind", `remind:${automation.id}:${now.toISOString().slice(0, 13)}`, [], now);
    update(deps.store, workspaceId, automation.id, (item) => ({ ...item, lastFiredAt: now.toISOString(), runs: item.runs + 1 }));
    const run = { ...base, taskId: "", state: "reminded" as const };
    noteRun(deps.store, workspaceId, run);
    return run;
  }
  const action = automation.action;
  const taskId = `${automation.id}-${now.getTime().toString(36)}`;
  const input: AgentTaskInput & { taskId: string } = {
    taskId, title: `自动化「${automation.name}」`, category: action.category as AgentCategory, lineId: automation.lineId,
    what: `${action.instructions}\n\n这次运行的原因：${why.reason}${why.context ? `\n\n${why.context}` : ""}${action.outputs.length ? `\n\n要交出：${action.outputs.join("、")}` : ""}`,
    humanPart: automation.steps.filter((step) => step.by === "person").map((step) => step.title).join("；") || "查看结果",
    notes: `这是本人设的自动化，第 ${automation.runs + 1} 次运行。每次只做这一轮的事，结果写进任务目录。`,
    ...(why.inputs?.length ? { inputs: why.inputs } : {})
  };
  const started = deps.runFree(workspaceId, input, (outcome) => {
    const at = deps.now?.() ?? new Date();
    if (outcome.state === "done") {
      const files = outcome.artifacts.slice(0, 4).map((artifact) => ({ label: artifact.path.split("/").pop() ?? artifact.path,
        href: `/api/agent/tasks/${encodeURIComponent(taskId)}/file?path=${encodeURIComponent(artifact.path)}` }));
      sayToPerson(deps.store, workspaceId, `自动化「${automation.name}」跑完了：${outcome.summary.summary.slice(0, 300)}${outcome.reviewRequired ? "\n有需要本人看的地方，在待确认里。" : ""}`,
        "automation_done", `automation-done:${taskId}`, [...files, ...(outcome.reviewRequired ? [{ label: "去待确认", href: "/approvals#assistant" }] : [])], at);
    } else if (outcome.state === "blocked" || outcome.state === "failed") {
      sayToPerson(deps.store, workspaceId, `自动化「${automation.name}」这次没跑完：${(outcome.message || "").slice(0, 200)}`, "automation_failed", `automation-failed:${taskId}`,
        [{ label: "查看", href: "/settings#automation" }], at);
    }
  });
  const state = started.state === "started" ? "started" as const : "queued" as const;
  if (state === "started") update(deps.store, workspaceId, automation.id, (item) => ({ ...item, lastFiredAt: now.toISOString(), runs: item.runs + 1 }));
  const run = { ...base, taskId: state === "started" ? taskId : "", state, ...(state === "queued" ? { detail: started.state === "blocked" ? started.message : "等待批准这类工作" } : {}) };
  noteRun(deps.store, workspaceId, run);
  return run;
}

/** Firings that could not start (the assistant busy): retried on the next ticks, oldest first, for a day. */
const QUEUE_SETTING = "automations.queue";
type Queued = Fire & { automationId: string; at: string };
const queue = (store: CrosslineStore, workspaceId: string): Queued[] => { try { return JSON.parse(store.getSetting(workspaceId, QUEUE_SETTING) ?? "[]") as Queued[]; } catch { return []; } };
const saveQueue = (store: CrosslineStore, workspaceId: string, items: Queued[]) => store.setSetting(workspaceId, QUEUE_SETTING, JSON.stringify(items.slice(-30)));

/** New mail fired at the engine (from the mailbox pass): each matching automation is queued once per batch. */
export function onNewMail(store: CrosslineStore, workspaceId: string, messages: NewMail[], now = new Date()): number {
  const queued: Queued[] = [];
  for (const automation of read(store, workspaceId).filter((item) => item.status === "active" && item.trigger.type === "mail")) {
    const trigger = automation.trigger as Extract<Automation["trigger"], { type: "mail" }>;
    const hits = messages.filter((message) => mailMatches(trigger, message)).slice(-10);
    if (!hits.length) continue;
    queued.push({ automationId: automation.id, at: now.toISOString(), reason: `收到 ${hits.length} 封符合条件的邮件`,
      context: `新邮件（可用 mail_read 按 id 读全文）：\n${hits.map((hit) => `- id ${hit.accountId}:${hit.uid} · ${hit.from} · 「${hit.subject}」 · ${hit.date.slice(0, 16)}\n  ${hit.snippet.slice(0, 200)}`).join("\n")}` });
  }
  if (queued.length) saveQueue(store, workspaceId, [...queue(store, workspaceId), ...queued]);
  return queued.length;
}

/**
 * One tick for one workspace: queued firings first, then each active automation's own trigger — a time, a page's text, new files,
 * task events — at most `AUTOMATION_RUNS_PER_DAY` runs each a day. The assistant runs one thing at a time; what cannot start waits.
 */
export async function automationPass(deps: AutomationDeps, workspaceId: string): Promise<AutomationRun[]> {
  const now = deps.now?.() ?? new Date();
  const fired: AutomationRun[] = [];
  const active = () => read(deps.store, workspaceId).filter((item) => item.status === "active");
  // Queued firings, for a day.
  const waiting = queue(deps.store, workspaceId).filter((item) => now.getTime() - Date.parse(item.at) < 86_400_000);
  const left: Queued[] = [];
  for (const item of waiting) {
    const automation = active().find((entry) => entry.id === item.automationId);
    if (!automation) continue;
    const run = fire(deps, workspaceId, automation, item);
    fired.push(run);
    if (run.state === "queued") left.push(item);
  }
  saveQueue(deps.store, workspaceId, left);
  const busy = () => fired.some((run) => run.state === "queued");
  for (const automation of active()) {
    if (busy()) break;
    const { trigger } = automation;
    if (trigger.type === "schedule" || trigger.type === "interval") {
      if (timeTriggerDue(automation, now, deps.zone(workspaceId))) fired.push(fire(deps, workspaceId, automation, { reason: trigger.type === "schedule" ? `到了设定时间（${triggerLabel(trigger)}）` : triggerLabel(trigger), context: "" }));
    } else if (trigger.type === "watch") {
      if (!timeTriggerDue(automation, now, deps.zone(workspaceId))) continue;
      const page = await safeGet(trigger.url, deps.fetch ?? defaultSafeGetDeps(), { maxBytes: 3_000_000, timeoutMs: 20_000 }).catch(() => undefined);
      if (!page?.ok) { update(deps.store, workspaceId, automation.id, (item) => ({ ...item, watch: { ...(item.watch ?? { hash: "", excerpt: "" }), checkedAt: now.toISOString() } })); continue; }
      const text = page.contentType.includes("html") ? htmlToText(new TextDecoder().decode(page.bytes)) : new TextDecoder().decode(page.bytes);
      const hash = createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
      const before = automation.watch;
      update(deps.store, workspaceId, automation.id, (item) => ({ ...item, watch: { hash, checkedAt: now.toISOString(), excerpt: text.slice(0, 6000) } }));
      // The first read is the baseline; a change after it fires, with the lines that are new.
      if (before?.hash && before.hash !== hash) {
        const added = addedLines(before.excerpt, text.slice(0, 6000));
        fired.push(fire(deps, workspaceId, automation, { reason: `${trigger.url} 的内容变了`,
          context: `页面 ${trigger.url} 新出现的内容：\n${added.length ? added.map((line) => `- ${line}`).join("\n") : "（文字有改动，但没有整行新增；用 web_fetch 打开页面看）"}` }));
      }
    } else if (trigger.type === "file") {
      const since = automation.lastFiredAt ?? automation.createdAt;
      const docs = deps.store.listSourceDocuments(workspaceId).filter((doc) => doc.createdAt > since && doc.extractionStatus !== "pending"
        && fileMatches(trigger, { fileName: doc.fileName, text: doc.extractedText }));
      if (docs.length) fired.push(fire(deps, workspaceId, automation, { reason: `新添加了 ${docs.length} 个文件`,
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
        if (done.length) fired.push(fire(deps, workspaceId, automation, { reason: `${done.length} 个任务完成验收`,
          context: `完成的任务（用 read_task 按 id 读）：\n${[...new Set(done)].slice(0, 10).map((id) => `- id ${id} · ${title(id)}`).join("\n")}` }));
      } else {
        const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: deps.zone(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now.getTime() + 86_400_000));
        const lastDay = automation.lastFiredAt ? new Intl.DateTimeFormat("en-CA", { timeZone: deps.zone(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(automation.lastFiredAt)) : "";
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: deps.zone(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
        const due = [...orders.values()].filter((order) => !["accepted", "archived"].includes(order.state) && (order.payload as { dueDate?: string }).dueDate === tomorrow && ofLine(order.id));
        if (due.length && lastDay !== today) fired.push(fire(deps, workspaceId, automation, { reason: `${due.length} 个任务明天到期`,
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
        if (!text) return { status: 400, body: { ok: false, blocker: { code: "AUTOMATION_TEXT_REQUIRED", message: "写一句想让它做什么、什么时候做。" } } };
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
        if (!automation) return { status: 404, body: { ok: false, blocker: { code: "AUTOMATION_NOT_FOUND", message: "找不到这个自动化。" } } };
        const run = fire(deps, workspaceId, automation, { reason: "本人点了立即运行", context: automation.trigger.type === "watch" ? `要看的页面：${automation.trigger.url}` : "" }, true);
        return { status: 200, body: { ok: run.state !== "skipped", run } };
      }
      return undefined;
    }
  };
}
