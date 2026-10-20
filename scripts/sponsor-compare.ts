/**
 * Two of the developer's models on real work (the owner's decision of 2026-10-20: read both side by side before the planning Skills
 * move to the cheaper one). On a copy of the hosted ledger the real step planner and the real backplanner run the same tasks and
 * milestones once per model, each model on its own copy so neither sees what the other wrote; every run's outcome, repairs, model time,
 * tokens and price is kept with what it produced, and a report puts the two next to each other for reading.
 *
 *   tsx scripts/sponsor-compare.ts list --ledger <crossline.db> [--auth <auth.db>]
 *   tsx scripts/sponsor-compare.ts run  --ledger <crossline.db> [--auth <auth.db>] --workspace <id,…> | --email <address,…> --out <dir>
 *                                       [--models A,B] [--steps 6] [--backplans 3]     (the counts are per account)
 *
 * The ledger given is never written: it is copied by SQLite's online backup first, and the backplanned milestones are reset on the
 * copies only (their earlier tasks and the record of the backplan removed, so both models split them from the same start). Runs go
 * through the path the worker uses for an invited account — a Codex app-server (in a throwaway home), the model gateway, the developer's
 * key from `CROSSLINE_SPONSOR_*` — with the model pinned per copy. It spends the key; never run as a side effect. On the hosted beta it
 * is the `compare` action of .github/workflows/server.yml, and `compare-report` prints the newest report.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureModelGate, setProviderResolver, setUsageSink, startCodexAppServer, startCodexSupervisor, startModelGateway, withUsageWorkspace,
  type ProviderRouting, type SkillUsage } from "../packages/codex/src/index";
import { webSearchFromEnv } from "../packages/connectors/src/index";
import { parseSponsorModels, sponsorSpend, taskTitleOf, THIRD_PARTY_CAPABILITIES } from "../packages/core/src/index";
import { CrosslineStore, sponsorshipOf } from "../packages/db/src/index";
import { createGoalBackplanner } from "../apps/worker/src/goal-backplanner";
import { identityLines } from "../apps/worker/src/lines";
import { planningContext, createStepPlanner } from "../apps/worker/src/step-planner";
import { sponsorFromEnv, SPONSOR_PROVIDER_ID } from "../apps/worker/src/sponsor";
import { createWebTools } from "../apps/worker/src/web-tools";

type Raw = { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown };
  backup: (to: string) => Promise<unknown>; close: () => void };
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as
  new (file: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => Raw;

const STEP_SKILL = "crossline-step-planner";
const BACKPLAN_SKILL = "crossline-goal-backplanner";
const DEFAULT_MODELS = ["deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3-Flash"];
const OPEN_STATES = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active"]);
// What a backplan leaves on a milestone that nobody has started: removed from each copy before the milestone is split again.
const UNSTARTED = new Set(["awaiting_plan_approval", "approved"]);

const [mode, ...rest] = process.argv.slice(2);
const arg = (name: string): string | undefined => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : undefined; };
const ledgerPath = arg("ledger");
if ((mode !== "list" && mode !== "run") || !ledgerPath) {
  console.error("usage: sponsor-compare.ts list|run --ledger <crossline.db> [--auth <auth.db>] [--email <address> --out <dir>]");
  process.exit(2);
}
const authPath = arg("auth") ?? path.join(path.dirname(ledgerPath), "auth.db");
const repoRoot = path.resolve(import.meta.dirname, "..");

/** An address as the log may show it: the first two letters and the domain. */
const masked = (email: string) => email.replace(/^(.{2}).*(@.*)$/, "$1***$2");

/** Every account's address by workspace (auth.db's user → principals → workspace_members, owners only). */
function emailsByWorkspace(ledger: string): Map<string, string> {
  const users = new Map<string, string>();
  try {
    const auth = new Database(authPath, { readonly: true, fileMustExist: true });
    for (const row of auth.prepare("SELECT id, email FROM user").all() as Array<{ id: string; email: string }>) users.set(row.id, row.email);
    auth.close();
  } catch { /* no auth.db beside the ledger: workspaces are listed by id only */ }
  const db = new Database(ledger, { readonly: true, fileMustExist: true });
  const rows = db.prepare(`SELECT m.workspace_id AS ws, p.better_auth_user_id AS user FROM principals p JOIN workspace_members m ON m.principal_id = p.id
    WHERE m.role = 'owner'`).all() as Array<{ ws: string; user: string | null }>;
  db.close();
  return new Map(rows.flatMap((row) => row.user && users.has(row.user) ? [[row.ws, users.get(row.user)!] as const] : []));
}

/** A consistent copy of the ledger (online backup: the app may be writing to it). */
async function copyLedger(to: string): Promise<void> {
  const live = new Database(ledgerPath!, { readonly: true, fileMustExist: true });
  await live.backup(to);
  live.close();
}

/** The work a comparison can run on: open tasks the step planner has planned, and approved milestones a backplan has split. */
function candidates(store: CrosslineStore, workspaceId: string) {
  const lines = new Set(identityLines(store, workspaceId).map((pack) => pack.id));
  const orders = store.listWorkOrders(workspaceId).filter((order) => OPEN_STATES.has(order.state) && lines.has(order.identityId));
  const planned = new Set(store.listStepPlans(workspaceId).map((plan) => plan.workOrderId));
  const tasks = orders.filter((order) => planned.has(order.id)).map((order) => ({ order, documents: planningContext(store, workspaceId, order).documents.length }));
  const backplanned = new Set(store.listEvents(workspaceId, { type: "goal.backplan_proposed" }).map((event) => event.entityId));
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline ?? ""]));
  const milestones = store.listMilestones(workspaceId).filter((item) => item.status === "approved" && item.projectId && lines.has(item.identityId)
    && backplanned.has(item.id)).map((item) => ({ milestone: item, deadline: anchors.get(item.id) ?? "" }));
  return { tasks, milestones };
}

if (mode === "list") {
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-compare-list-"));
  await copyLedger(path.join(dir, "crossline.db"));
  const store = new CrosslineStore(path.join(dir, "crossline.db"));
  const emails = emailsByWorkspace(path.join(dir, "crossline.db"));
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  for (const workspace of store.listWorkspaces()) {
    const { tasks, milestones } = candidates(store, workspace.id);
    const runs = store.summarizeModelUsage(workspace.id, since).filter((row) => row.skill === STEP_SKILL || row.skill === BACKPLAN_SKILL)
      .map((row) => `${row.skill.replace("crossline-", "")}@${row.model}×${row.runs}`);
    console.info(JSON.stringify({ workspace: workspace.id, email: emails.has(workspace.id) ? masked(emails.get(workspace.id)!) : null,
      sponsored: Boolean(sponsorshipOf(store, workspace.id)), plannedTasks: tasks.length, withFiles: tasks.filter((task) => task.documents > 0).length,
      backplannedMilestones: milestones.length, runs30d: runs }));
  }
  store.close();
  process.exit(0);
}

// ---- run ----
const outRoot = arg("out");
// Accounts by workspace id or sign-in address, several at once (comma-separated).
const wanted = [...(arg("workspace") ?? "").split(","), ...(arg("email") ?? "").split(",")].map((item) => item.trim()).filter(Boolean);
if (!wanted.length || !outRoot) { console.error("run needs --workspace <id,…> or --email <address,…>, and --out <dir>"); process.exit(2); }
const sponsor = sponsorFromEnv();
if (!sponsor) { console.error("CROSSLINE_SPONSOR_API_KEY / CROSSLINE_SPONSOR_MODELS are not set"); process.exit(2); }
const models = (arg("models") ?? DEFAULT_MODELS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
const priced = parseSponsorModels(process.env.CROSSLINE_SPONSOR_MODELS);
for (const model of models) if (!priced.some((item) => item.model === model)) { console.error(`${model} is not in CROSSLINE_SPONSOR_MODELS`); process.exit(2); }
const stepCount = Math.max(0, Number(arg("steps") ?? 6));
const backplanCount = Math.max(0, Number(arg("backplans") ?? 3));

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(outRoot, stamp);
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "crossline-compare-"));
// The step planner writes the line's own skills beside the Codex home: a throwaway state directory, never the server's.
process.env.CROSSLINE_STATE_DIR = path.join(scratch, "state");
const base = path.join(scratch, "base.db");
await copyLedger(base);
const emails = emailsByWorkspace(base);
const workspaceIds = [...new Set(wanted.map((item) => item.includes("@")
  ? [...emails].find(([, address]) => address.toLowerCase() === item.toLowerCase())?.[0] ?? `missing:${masked(item)}` : item))];

// The same tasks and milestones for every model, chosen on the untouched copy: tasks with files of their own first, one project at a
// time; milestones due soonest first, one per project while there are enough. A task whose milestone is reset is not also re-planned.
const probe = new CrosslineStore(base);
const known = new Set(probe.listWorkspaces().map((workspace) => workspace.id));
const picks = workspaceIds.map((workspaceId) => {
  if (!known.has(workspaceId)) { console.error(`no workspace ${workspaceId}`); process.exit(1); }
  const pool = candidates(probe, workspaceId);
  const milestones = [...pool.milestones].sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"))
    .filter((item, index, list) => list.findIndex((other) => other.milestone.projectId === item.milestone.projectId) === index || list.length <= backplanCount)
    .slice(0, backplanCount).map((item) => item.milestone);
  const reset = new Set(milestones.map((item) => item.id));
  const byProject = new Map<string, typeof pool.tasks>();
  for (const task of [...pool.tasks].filter((task) => !reset.has(task.order.milestoneId)).sort((a, b) => b.documents - a.documents))
    byProject.set(task.order.projectId, [...(byProject.get(task.order.projectId) ?? []), task]);
  const tasks: Array<(typeof pool.tasks)[number]["order"]> = [];
  while (tasks.length < stepCount && [...byProject.values()].some((list) => list.length))
    for (const list of byProject.values()) { const next = list.shift(); if (next && tasks.length < stepCount) tasks.push(next.order); }
  return { workspaceId, label: emails.has(workspaceId) ? masked(emails.get(workspaceId)!) : workspaceId, tasks, milestones,
    existingPlans: new Map(tasks.map((order) => [order.id, probe.getStepPlan(workspaceId, order.id)])),
    existingBackplans: new Map(milestones.map((milestone) => [milestone.id, probe.listWorkOrders(workspaceId)
      .filter((order) => order.milestoneId === milestone.id && (order.payload as { backplan?: unknown } | undefined)?.backplan)
      .map((order) => ({ title: taskTitleOf(order), p50: order.estimate.p50Minutes }))])) };
});
probe.close();
console.info(JSON.stringify({ step: "picked", accounts: picks.map((pick) => ({ workspace: pick.workspaceId, tasks: pick.tasks.length, milestones: pick.milestones.length })), models }));

/** One copy per model; the picked milestones reset on it (their unstarted tasks and the record of the backplan removed). */
async function copyFor(model: string): Promise<CrosslineStore> {
  const file = path.join(scratch, `${model.replace(/[^A-Za-z0-9._-]+/g, "_")}.db`);
  const source = new Database(base, { readonly: true, fileMustExist: true });
  await source.backup(file);
  source.close();
  const db = new Database(file);
  for (const { workspaceId, milestones } of picks) for (const milestone of milestones) {
    const orders = (db.prepare("SELECT id, state, payload_json FROM work_orders WHERE workspace_id = ? AND milestone_id = ?").all(workspaceId, milestone.id) as
      Array<{ id: string; state: string; payload_json: string }>).filter((row) => UNSTARTED.has(row.state) && JSON.parse(row.payload_json || "{}").backplan
      && !db.prepare("SELECT 1 FROM executions WHERE workspace_id = ? AND work_order_id = ?").get(workspaceId, row.id));
    for (const order of orders) for (const table of ["work_orders", "task_step_plans", "task_steps"])
      db.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND ${table === "work_orders" ? "id" : "work_order_id"} = ?`).run(workspaceId, order.id);
    db.prepare("DELETE FROM events WHERE workspace_id = ? AND entity_id = ? AND type IN ('goal.backplan_proposed', 'goal.backplan_blocked')").run(workspaceId, milestone.id);
  }
  db.close();
  return new CrosslineStore(file);
}

// ---- the runtime, the gateway and the routing: what the worker gives an invited account, with the model pinned per copy ----
const usageKey = (model: string) => `sponsor-eval:compare:${model}`;
const runUsage = new Map<string, SkillUsage[]>();
setUsageSink((usage) => { if (usage.workspaceId) runUsage.set(usage.workspaceId, [...(runUsage.get(usage.workspaceId) ?? []), usage]); });
// No person shares this process: every slot is the comparison's, one run per model at a time.
configureModelGate({ limit: models.length * 2, perTenant: models.length * 2, reserve: 0 });
const search = webSearchFromEnv();
const capabilities = { ...THIRD_PARTY_CAPABILITIES, webSearch: Boolean(search) };
const gateway = await startModelGateway({ resolve: (key) => key.startsWith("sponsor-eval:compare:")
  ? { kind: "chat", baseUrl: sponsor.baseUrl, responseFormat: "json_object", key: sponsor.key, thinkingControl: true, patient: true } : undefined });
const routing = (model: string): ProviderRouting => {
  const contextK = sponsor.models.find((item) => item.model === model)?.contextK;
  return { provider: { id: SPONSOR_PROVIDER_ID, kind: "chat", label: "开发者提供的模型", baseUrl: sponsor.baseUrl, model, responseFormat: "json_object",
    keyLast4: null, updatedAt: "1970-01-01T00:00:00.000Z", ...(contextK ? { contextK } : {}) },
    gatewayUrl: gateway.urlFor(usageKey(model), SPONSOR_PROVIDER_ID), admitted: new Set([STEP_SKILL, BACKPLAN_SKILL]), codexSignedIn: false, capabilities,
    ...(search ? { webTools: createWebTools(search) } : {}) };
};
setProviderResolver((key) => { const model = models.find((item) => key === usageKey(item)); return model ? routing(model) : undefined; });
const supervisor = await startCodexSupervisor({ port: 3393, sidecarFactory: () => startCodexAppServer(path.join(scratch, "codex-home")),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: [`crossline:${STEP_SKILL}`, `crossline:${BACKPLAN_SKILL}`] } });

type RunRecord = {
  model: string; workspace: string; kind: "steps" | "backplan"; subject: string; title: string; ok: boolean; code?: string; message?: string;
  seconds: number; modelSeconds: number; repairs: number; tokens: { input: number; cached: number; output: number; reasoning: number }; yuan: number;
  result: unknown;
};
const runsFile = path.join(out, "runs.jsonl");

/** Runs `work` with the model pinned, and what it cost from the usage of every model run inside it. */
async function measured(model: string, work: () => Promise<{ ok: boolean; code?: string; message?: string }>) {
  const key = usageKey(model);
  runUsage.delete(key);
  const started = Date.now();
  const outcome = await withUsageWorkspace(key, work).catch((error: unknown) => ({ ok: false, code: error instanceof Error ? error.message.slice(0, 120) : "FAILED" }));
  const usage = runUsage.get(key) ?? [];
  const tokens = usage.reduce((sum, row) => ({ input: sum.input + row.inputTokens, cached: sum.cached + row.cachedInputTokens,
    output: sum.output + row.outputTokens, reasoning: sum.reasoning + row.reasoningOutputTokens }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  const yuan = sponsorSpend(usage.map((row) => ({ model, inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens })), priced);
  return { outcome, seconds: Math.round((Date.now() - started) / 1000), modelSeconds: Math.round(usage.reduce((sum, row) => sum + row.durationMs, 0) / 1000),
    repairs: usage.reduce((sum, row) => sum + row.repairs, 0), tokens, yuan: Math.round(yuan * 10_000) / 10_000 };
}

/** Everything one model does, account by account: the tasks' steps, then the milestones' tasks. */
async function compareOne(model: string): Promise<RunRecord[]> {
  const store = await copyFor(model);
  const records: RunRecord[] = [];
  const keep = (record: RunRecord) => {
    records.push(record);
    appendFileSync(runsFile, `${JSON.stringify(record)}\n`, "utf8");
    console.info(JSON.stringify({ step: "ran", model, kind: record.kind, subject: record.subject, ok: record.ok, code: record.code, seconds: record.seconds,
      modelSeconds: record.modelSeconds, repairs: record.repairs, yuan: record.yuan }));
  };
  for (const { workspaceId, tasks, milestones } of picks) {
    const planner = createStepPlanner(store, workspaceId, repoRoot, () => supervisor.client);
    for (const order of tasks) {
      let planned: Awaited<ReturnType<typeof planner>> | undefined;
      const run = await measured(model, async () => { planned = await planner(order.id); return planned.state === "planned" ? { ok: true }
        : { ok: false, code: planned.code, message: planned.message }; });
      const plan = store.getStepPlan(workspaceId, order.id);
      keep({ model, workspace: workspaceId, kind: "steps", subject: order.id, title: taskTitleOf(order), ok: run.outcome.ok, ...(run.outcome.code ? { code: run.outcome.code } : {}),
        ...("message" in run.outcome && run.outcome.message ? { message: run.outcome.message.slice(0, 300) } : {}),
        seconds: run.seconds, modelSeconds: run.modelSeconds, repairs: run.repairs, tokens: run.tokens, yuan: run.yuan,
        result: run.outcome.ok && plan ? { warnings: planned?.state === "planned" ? planned.warnings.map((warning) => warning.code) : [], ...planSummary(plan) } : null });
    }
    const backplanner = createGoalBackplanner(store, workspaceId, repoRoot, () => supervisor.client, { rolling: true });
    for (const milestone of milestones) {
      const before = new Set(store.listWorkOrders(workspaceId).map((order) => order.id));
      const foldedBefore = store.listEvents(workspaceId, { type: "task.duplicate_prevented" }).length;
      let answer: { state: string; code?: string; message?: string } | undefined;
      const run = await measured(model, async () => { answer = await backplanner(milestone.id) as typeof answer;
        return answer?.state === "proposed" ? { ok: true } : { ok: false, code: answer?.code ?? "BACKPLAN_FAILED", message: answer?.message ?? "" }; });
      const created = store.listWorkOrders(workspaceId).filter((order) => !before.has(order.id));
      const folded = store.listEvents(workspaceId, { type: "task.duplicate_prevented" }).length - foldedBefore;
      keep({ model, workspace: workspaceId, kind: "backplan", subject: milestone.id, title: milestone.title, ok: run.outcome.ok, ...(run.outcome.code ? { code: run.outcome.code } : {}),
        ...("message" in run.outcome && run.outcome.message ? { message: run.outcome.message.slice(0, 300) } : {}),
        seconds: run.seconds, modelSeconds: run.modelSeconds, repairs: run.repairs, tokens: run.tokens, yuan: run.yuan,
        result: { folded, tasks: created.map((order) => ({ title: taskTitleOf(order), p50: order.estimate.p50Minutes, p85: order.estimate.p85Minutes,
          due: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "", deliver: ((order.payload as { evidenceContract?: Array<{ description: string }> } | undefined)
            ?.evidenceContract ?? []).map((item) => item.description).slice(0, 3) })) } });
    }
  }
  store.close();
  return records;
}

/** A plan as the report shows it: the steps with who does them and how long, what was counted from the files, what is asked. */
function planSummary(plan: NonNullable<ReturnType<CrosslineStore["getStepPlan"]>>) {
  return { archetype: plan.archetypeId, units: plan.units.length, questions: plan.questions.map((question) => question.text ?? String(question)),
    steps: plan.steps.filter((step) => step.status === "planned").map((step) => ({ title: step.title, executor: step.executor, role: step.role,
      p50: step.estimate.p50Minutes, done: step.doneCriterion, firstAction: (step as { firstAction?: string }).firstAction ?? "" })) };
}

const started = Date.now();
const results = (await Promise.all(models.map((model) => compareOne(model).catch((error: unknown) => {
  console.error(JSON.stringify({ step: "model_failed", model, message: error instanceof Error ? error.message : String(error) }));
  return [] as RunRecord[];
})))).flat();
await supervisor.stop();
await gateway.close();

// ---- the report ----
const lines: string[] = [`# 开发者模型对比：${models.join(" 对 ")}`, "",
  `账本副本上的 ${picks.map((pick) => `${pick.label}（${pick.tasks.length} 个任务重新拆步骤，${pick.milestones.length} 个里程碑重新倒推）`).join("、")}；`
    + `用时 ${Math.round((Date.now() - started) / 60_000)} 分钟。`, "",
  "| 模型 | 工作 | 运行 | 成功 | 修复 | 模型用时中位/最长 | 每次费用 | 每次成功费用 |", "|---|---|---|---|---|---|---|---|"];
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0; };
for (const model of models) for (const kind of ["steps", "backplan"] as const) {
  const own = results.filter((record) => record.model === model && record.kind === kind);
  if (!own.length) continue;
  const total = own.reduce((sum, record) => sum + record.yuan, 0);
  const ok = own.filter((record) => record.ok).length;
  lines.push(`| ${model} | ${kind === "steps" ? "拆步骤" : "倒推任务"} | ${own.length} | ${ok} | ${own.reduce((sum, record) => sum + record.repairs, 0)} | `
    + `${median(own.map((record) => record.modelSeconds))} s / ${Math.max(0, ...own.map((record) => record.modelSeconds))} s | ¥${(total / own.length).toFixed(4)} | `
    + `${ok ? `¥${(total / ok).toFixed(4)}` : "-"} |`);
}
const describe = (record: RunRecord | undefined): string[] => {
  if (!record) return ["（没有运行）"];
  const head = `${record.ok ? "成功" : `失败 ${record.code ?? ""} ${record.message ?? ""}`}；模型 ${record.modelSeconds} s，修复 ${record.repairs}，¥${record.yuan}`;
  if (!record.ok || !record.result) return [head];
  if (record.kind === "steps") {
    const plan = record.result as ReturnType<typeof planSummary> & { warnings: string[] };
    return [head, `类型 ${plan.archetype}，单元 ${plan.units}，提醒 ${plan.warnings.join("、") || "无"}`,
      ...plan.steps.map((step, index) => `${index + 1}. [${step.executor === "human" ? "本人" : step.executor === "agent" ? "助手" : step.executor}] ${step.title}（${step.p50} 分）`
        + `${step.done ? `；完成标准：${step.done}` : ""}${step.firstAction ? `；第一步：${step.firstAction}` : ""}`),
      ...(plan.questions.length ? [`问题：${plan.questions.join(" / ")}`] : [])];
  }
  const answer = record.result as { folded: number; tasks: Array<{ title: string; p50: number; p85: number; due: string; deliver: string[] }> };
  return [head, `新任务 ${answer.tasks.length} 个，并入已有 ${answer.folded} 个`,
    ...answer.tasks.map((task, index) => `${index + 1}. ${task.title}（${task.p50}–${task.p85} 分${task.due ? `，截止 ${task.due}` : ""}）${task.deliver.length ? `；交付：${task.deliver.join("；")}` : ""}`)];
};
const find = (model: string, workspace: string, kind: RunRecord["kind"], subject: string) =>
  results.find((record) => record.model === model && record.workspace === workspace && record.kind === kind && record.subject === subject);
for (const pick of picks) {
  lines.push("", `## ${pick.label}`);
  if (pick.tasks.length) lines.push("", "### 拆步骤");
  for (const order of pick.tasks) {
    const existing = pick.existingPlans.get(order.id);
    lines.push("", `#### ${taskTitleOf(order)}`, "", `现有计划：${existing ? existing.steps.map((step) => step.title).join(" → ") : "无"}`);
    for (const model of models) lines.push("", `**${model}**`, "", ...describe(find(model, pick.workspaceId, "steps", order.id)).map((line) => `- ${line}`));
  }
  if (pick.milestones.length) lines.push("", "### 倒推任务");
  for (const milestone of pick.milestones) {
    const existing = pick.existingBackplans.get(milestone.id) ?? [];
    lines.push("", `#### ${milestone.title}`, "", `现有任务：${existing.map((task) => `${task.title}（${task.p50} 分）`).join("、") || "无"}`);
    for (const model of models) lines.push("", `**${model}**`, "", ...describe(find(model, pick.workspaceId, "backplan", milestone.id)).map((line) => `- ${line}`));
  }
}
writeFileSync(path.join(out, "report.md"), `${lines.join("\n")}\n`, "utf8");
console.info(lines.join("\n"));
console.info(JSON.stringify({ step: "done", out }));
process.exit(0);
