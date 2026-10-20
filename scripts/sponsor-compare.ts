/**
 * Two of the developer's models on real work (the owner's decision of 2026-10-20: read both side by side before the planning Skills
 * move to the cheaper one). On a copy of the hosted ledger the real step planner and the real backplanner run the same tasks and
 * milestones once per model, each model on its own copy so neither sees what the other wrote; every run's outcome, repairs, model time,
 * tokens and price is kept with what it produced, and a report puts the two next to each other for reading — including how the text
 * reads (the owner, the same day: how machine-made it sounds, whether it is clear and keeps the Skills' writing rules).
 *
 *   tsx scripts/sponsor-compare.ts list   --ledger <crossline.db> [--auth <auth.db>]
 *   tsx scripts/sponsor-compare.ts run    --ledger <crossline.db> [--auth <auth.db>] --workspace <id,…> | --email <address,…> --out <dir>
 *                                         [--models A,B] [--steps 6] [--backplans 3] [--dialogues <dir>]   (the counts are per account)
 *   tsx scripts/sponsor-compare.ts report --run <out>/<stamp> [--auth <auth.db>] [--dialogues <dir>]
 *
 * The ledger given is never written: it is copied by SQLite's online backup first, and the backplanned milestones are reset on the
 * copies only (their earlier tasks and the record of the backplan removed, so both models split them from the same start). The copies
 * are kept in the run's folder (`copies/`), so `report` can rebuild the report from them without running a model again; `--dialogues`
 * is the evaluation's log folder (`sponsor-eval/`), whose sample interviews add each model's conversational replies to the reading.
 * Runs go through the path the worker uses for an invited account — a Codex app-server (in a throwaway home), the model gateway, the
 * developer's key from `CROSSLINE_SPONSOR_*` — with the model pinned per copy. It spends the key; never run as a side effect. On the
 * hosted beta it is the `compare` action of .github/workflows/server.yml, and `compare-report` prints the newest report.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureModelGate, setProviderResolver, setUsageSink, startCodexAppServer, startCodexSupervisor, startModelGateway, withUsageWorkspace,
  type ProviderRouting, type SkillUsage } from "../packages/codex/src/index";
import { webSearchFromEnv } from "../packages/connectors/src/index";
import { parseSponsorModels, plainVoiceMarkers, sponsorSpend, taskTitleOf, THIRD_PARTY_CAPABILITIES } from "../packages/core/src/index";
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
if (!((mode === "list" || mode === "run") && ledgerPath) && !(mode === "report" && arg("run"))) {
  console.error("usage: sponsor-compare.ts list|run --ledger <crossline.db> … | report --run <dir>");
  process.exit(2);
}
const authPath = arg("auth") ?? (ledgerPath ? path.join(path.dirname(ledgerPath), "auth.db") : "");
const repoRoot = path.resolve(import.meta.dirname, "..");

/** An address as the log may show it: the first two letters and the domain. */
const masked = (email: string) => email.replace(/^(.{2}).*(@.*)$/, "$1***$2");
const slug = (model: string) => model.replace(/[^A-Za-z0-9._-]+/g, "_");
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0; };
const length = (text: string) => [...text].length;

/** Every account's address by workspace (auth.db's user → principals → workspace_members, owners only). */
function emailsByWorkspace(ledger: string): Map<string, string> {
  const users = new Map<string, string>();
  try {
    const auth = new Database(authPath, { readonly: true, fileMustExist: true });
    for (const row of auth.prepare("SELECT id, email FROM user").all() as Array<{ id: string; email: string }>) users.set(row.id, row.email);
    auth.close();
  } catch { /* no auth.db: workspaces are named by id only */ }
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

// ---- the report: rebuilt from the run's records and the copies, so it can be redone without running a model ----

type RunRecord = {
  model: string; workspace: string; kind: "steps" | "backplan"; subject: string; title: string; ok: boolean; code?: string; message?: string;
  seconds: number; modelSeconds: number; repairs: number; tokens: { input: number; cached: number; output: number; reasoning: number }; yuan: number;
  result: unknown;
};
/** What was compared: the models and, per account, the tasks re-planned and the milestones split again (written when a run starts). */
type Meta = { models: string[]; accounts: Array<{ workspaceId: string; label: string; tasks: string[]; milestones: string[] }> };
type StoredPlan = NonNullable<ReturnType<CrosslineStore["getStepPlan"]>>;
type PlanStep = StoredPlan["steps"][number] & { why?: string; firstAction?: string };
/** One piece of text a person reads, with where it came from, for the writing checks. */
type Piece = { field: string; text: string };

const MARKER_LABEL: Record<string, string> = { dash: "破折号", contrast: "对比句式", formula: "套话", metaphor: "比喻", aphorism: "格言式" };
// Internal names leaking into text the person reads: estimate jargon, document and step ids, JSON keys.
const JARGON = /\bp(?:25|50|85)\b|\bdoc-\d+\b|\bv\d+s\d+\b|(?<![A-Za-z])[squ]\d{1,2}(?!\d)|\b[a-z]+_[a-z_]+\b/;
// Addressing the reader or speaking as the writer: the Skills write in the objective third person.
const ADDRESS = /[你您]|(?<!自)我(?!国)/;
// A done criterion that can be checked: a number, a count, or a word for all of something.
const QUANTIFIED = /\d|[一二两三四五六七八九十百千]+\s*(?:个|道|页|题|节|章|篇|条|次|分钟|小时|处|项|段|张|份|遍|轮)|全部|所有|每[个道页题节章篇条项段张份]|逐[个道题条项]|至少|不少于|不超过|无遗漏|[≥≤]/;

/** How a model's text reads: machine-made shapes per thousand characters, address, leaked names, sentence length, with examples. */
function writingOf(pieces: Piece[], options: { address?: boolean } = {}) {
  const texts = pieces.filter((piece) => piece.text.trim());
  const chars = texts.reduce((sum, piece) => sum + length(piece.text), 0);
  const markers: Record<string, number> = {};
  const examples: string[] = [];
  for (const piece of texts) for (const [kind, count] of Object.entries(plainVoiceMarkers(piece.text))) {
    if (!count || kind === "echoOpening") continue;
    markers[kind] = (markers[kind] ?? 0) + count;
    if (examples.length < 8) examples.push(`[${MARKER_LABEL[kind] ?? kind}] ${piece.field}：${piece.text.slice(0, 140)}`);
  }
  const hits = Object.values(markers).reduce((sum, value) => sum + value, 0);
  const addressed = options.address === false ? [] : texts.filter((piece) => ADDRESS.test(piece.text));
  const leaked = texts.filter((piece) => JARGON.test(piece.text));
  const sentences = texts.flatMap((piece) => piece.text.split(/[。！？；!?;\n]+/)).map((sentence) => length(sentence.trim())).filter((size) => size > 0);
  return { chars, hits, rate: chars ? Math.round(hits * 10_000 / chars) / 10 : 0, markers, examples,
    addressed: addressed.map((piece) => `${piece.field}：${piece.text.slice(0, 120)}`), leaked: leaked.map((piece) => `${piece.field}：${piece.text.slice(0, 120)}`),
    sentenceMedian: median(sentences), sentenceMax: Math.max(0, ...sentences) };
}

/** The step planner's own rules, as far as code can read them: the person's steps start concretely and end checkably. */
function stepChecks(steps: PlanStep[]) {
  const person = steps.filter((step) => step.executor !== "agent" && step.role !== "wait");
  return { steps: steps.length, person: person.length, agent: steps.filter((step) => step.executor === "agent").length,
    noFirstAction: person.filter((step) => !step.firstAction?.trim()).length,
    vagueDone: person.filter((step) => !QUANTIFIED.test(step.doneCriterion)).length,
    longTitle: steps.filter((step) => length(step.title) > 30).length };
}

/** A plan's text, piece by piece, for the writing checks. */
function planPieces(plan: StoredPlan): Piece[] {
  const steps = plan.steps.filter((step) => step.status === "planned") as PlanStep[];
  return [{ field: "计划依据", text: plan.rationale },
    ...plan.questions.flatMap((question) => [{ field: "问题", text: question.text ?? "" }, { field: "问题理由", text: question.why ?? "" }]),
    ...steps.flatMap((step) => [{ field: "步骤", text: step.title }, { field: "产出", text: step.deliverable }, { field: "完成标准", text: step.doneCriterion },
      { field: "第一步", text: step.firstAction ?? "" }, { field: "理由", text: step.why ?? "" }])];
}

type Backplanned = { title: string; intent: string; rationale: string; evidence: string; p50: number; p85: number; due: string };
/** The tasks a backplan run wrote on this copy for one milestone (those the untouched copy does not have). */
function backplannedTasks(store: CrosslineStore, base: CrosslineStore, workspaceId: string, milestoneId: string): Backplanned[] {
  const before = new Set(base.listWorkOrders(workspaceId).map((order) => order.id));
  return store.listWorkOrders(workspaceId).filter((order) => order.milestoneId === milestoneId && !before.has(order.id)).map((order) => {
    const payload = (order.payload ?? {}) as { backplan?: { rationale?: string }; evidenceContract?: Array<{ description: string }>; dueDate?: string };
    return { title: taskTitleOf(order), intent: order.intent, rationale: payload.backplan?.rationale ?? "", evidence: payload.evidenceContract?.[0]?.description ?? "",
      p50: order.estimate.p50Minutes, p85: order.estimate.p85Minutes, due: payload.dueDate ?? "" };
  });
}

/** Each model's sample-interview replies from the evaluation's logs (its own words to a person, as opposed to planning output). */
function dialogues(dir: string, model: string): Array<{ turn: number; reply: string; questions: string[] }> {
  const file = path.join(dir, `${slug(model)}.dialogue.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { const row = JSON.parse(line) as { turn: number; ok: boolean; reply: string; questions?: Array<{ text: string }> };
      return row.ok ? [{ turn: row.turn, reply: row.reply, questions: (row.questions ?? []).map((question) => question.text) }] : []; } catch { return []; }
  });
}

function writeReport(dir: string, options: { dialogues?: string | undefined } = {}): string {
  const runs = readFileSync(path.join(dir, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunRecord);
  const copies = path.join(dir, "copies");
  const metaFile = path.join(dir, "meta.json");
  // A run started before meta.json existed: the models and accounts are read off its records in the order they ran.
  const meta: Meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) as Meta : (() => {
    const emails = existsSync(path.join(copies, "base.db")) ? emailsByWorkspace(path.join(copies, "base.db")) : new Map<string, string>();
    const accounts = [...new Set(runs.map((run) => run.workspace))].map((workspaceId) => ({ workspaceId,
      label: emails.has(workspaceId) ? masked(emails.get(workspaceId)!) : workspaceId,
      tasks: [...new Set(runs.filter((run) => run.workspace === workspaceId && run.kind === "steps").map((run) => run.subject))],
      milestones: [...new Set(runs.filter((run) => run.workspace === workspaceId && run.kind === "backplan").map((run) => run.subject))] }));
    return { models: [...new Set(runs.map((run) => run.model))], accounts };
  })();
  const base = existsSync(path.join(copies, "base.db")) ? new CrosslineStore(path.join(copies, "base.db")) : undefined;
  const stores = new Map(meta.models.flatMap((model) => existsSync(path.join(copies, `${slug(model)}.db`))
    ? [[model, new CrosslineStore(path.join(copies, `${slug(model)}.db`))] as const] : []));
  const find = (model: string, workspace: string, kind: RunRecord["kind"], subject: string) =>
    runs.find((run) => run.model === model && run.workspace === workspace && run.kind === kind && run.subject === subject);
  const planOf = (model: string, workspace: string, subject: string) => find(model, workspace, "steps", subject)?.ok ? stores.get(model)?.getStepPlan(workspace, subject) : undefined;
  const tasksOf = (model: string, workspace: string, milestone: string) => {
    const store = stores.get(model);
    return store && base && find(model, workspace, "backplan", milestone)?.ok ? backplannedTasks(store, base, workspace, milestone) : [];
  };

  // From meta.json (written as the run starts) to the last record; a run from before meta.json says nothing about its length.
  const minutes = existsSync(metaFile) ? Math.round((statSync(path.join(dir, "runs.jsonl")).mtimeMs - statSync(metaFile).mtimeMs) / 60_000) : 0;
  const lines: string[] = [`# 开发者模型对比：${meta.models.join(" 对 ")}`, "",
    `账本副本上的 ${meta.accounts.map((account) => `${account.label}（${account.tasks.length} 个任务重新拆步骤，${account.milestones.length} 个里程碑重新倒推）`).join("、")}`
      + `${minutes > 0 ? `；用时约 ${minutes} 分钟` : ""}。`, "",
    "## 成败、用时与费用", "",
    "| 模型 | 工作 | 运行 | 成功 | 修复 | 模型用时中位/最长 | 每次费用 | 每次成功费用 |", "|---|---|---|---|---|---|---|---|"];
  for (const model of meta.models) for (const kind of ["steps", "backplan"] as const) {
    const own = runs.filter((run) => run.model === model && run.kind === kind);
    if (!own.length) continue;
    const total = own.reduce((sum, run) => sum + run.yuan, 0);
    const ok = own.filter((run) => run.ok).length;
    lines.push(`| ${model} | ${kind === "steps" ? "拆步骤" : "倒推任务"} | ${own.length} | ${ok} | ${own.reduce((sum, run) => sum + run.repairs, 0)} | `
      + `${median(own.map((run) => run.modelSeconds))} s / ${Math.max(0, ...own.map((run) => run.modelSeconds))} s | ¥${(total / own.length).toFixed(4)} | `
      + `${ok ? `¥${(total / ok).toFixed(4)}` : "-"} |`);
  }

  // ---- how the text reads ----
  const writing = new Map(meta.models.map((model) => {
    const pieces: Piece[] = [];
    const steps: PlanStep[] = [];
    let backplanned: Backplanned[] = [];
    for (const account of meta.accounts) {
      for (const task of account.tasks) {
        const plan = planOf(model, account.workspaceId, task);
        if (plan) { pieces.push(...planPieces(plan)); steps.push(...(plan.steps.filter((step) => step.status === "planned") as PlanStep[])); }
      }
      for (const milestone of account.milestones) backplanned = [...backplanned, ...tasksOf(model, account.workspaceId, milestone)];
    }
    for (const task of backplanned) pieces.push({ field: "任务名", text: task.title }, { field: "任务说明", text: task.intent },
      { field: "任务理由", text: task.rationale }, { field: "交付", text: task.evidence });
    return [model, { text: writingOf(pieces), checks: stepChecks(steps), backplanned }] as const;
  }));
  lines.push("", "## 文字质量", "",
    "AI 味按「每千字命中」比（破折号、「不是……而是」类对比句式、「先别/理清/落地」类套话、比喻、「这说明/本质上」类格言式）；单次命中说明不了什么，看比率。",
    "", "| 模型 | 文字量（字） | AI 味（每千字） | 分项 | 称「你/您/我」 | 内部名称外露 | 句子中位/最长（字） |", "|---|---|---|---|---|---|---|");
  for (const [model, { text }] of writing) lines.push(`| ${model} | ${text.chars} | ${text.rate} | ${Object.entries(text.markers)
    .map(([kind, count]) => `${MARKER_LABEL[kind] ?? kind} ${count}`).join("、") || "无"} | ${text.addressed.length} | ${text.leaked.length} | ${text.sentenceMedian} / ${text.sentenceMax} |`);
  lines.push("", "| 模型 | 步骤（本人/助手） | 本人步骤缺第一步 | 完成标准没有数量 | 步骤名超过 30 字 | 倒推任务名超过 24 字 | 倒推任务不在 30–480 分钟 |", "|---|---|---|---|---|---|---|");
  for (const [model, { checks, backplanned }] of writing) lines.push(`| ${model} | ${checks.steps}（${checks.person}/${checks.agent}） | ${checks.noFirstAction} | `
    + `${checks.vagueDone} | ${checks.longTitle} | ${backplanned.filter((task) => length(task.title) > 24).length} | ${backplanned.filter((task) => task.p50 < 30 || task.p50 > 480).length} |`);
  for (const [model, { text }] of writing) {
    if (!text.examples.length && !text.addressed.length && !text.leaked.length) continue;
    lines.push("", `**${model} 的例句**`, "", ...text.examples.map((line) => `- ${line}`), ...text.addressed.slice(0, 4).map((line) => `- [称呼] ${line}`),
      ...text.leaked.slice(0, 4).map((line) => `- [外露] ${line}`));
  }
  if (options.dialogues) {
    lines.push("", "## 样例访谈的回复（检验时三轮对虚构学生的访谈；访谈本就称「你」，这里不算称呼）");
    for (const model of meta.models) {
      const turns = dialogues(options.dialogues, model);
      if (!turns.length) continue;
      const text = writingOf(turns.flatMap((turn) => [{ field: `第 ${turn.turn} 轮回复`, text: turn.reply },
        ...turn.questions.map((question) => ({ field: `第 ${turn.turn} 轮问题`, text: question }))]), { address: false });
      lines.push("", `**${model}**：AI 味 ${text.rate}/千字（${Object.entries(text.markers).map(([kind, count]) => `${MARKER_LABEL[kind] ?? kind} ${count}`).join("、") || "无"}），`
        + `句子中位 ${text.sentenceMedian} 字`, "", ...turns.flatMap((turn) => [`- 第 ${turn.turn} 轮：${turn.reply}`,
        ...turn.questions.slice(0, 4).map((question) => `  - 问：${question}`)]));
    }
  }

  // ---- what each produced, account by account ----
  const runHead = (run: RunRecord | undefined) => !run ? "（没有运行）"
    : `${run.ok ? "成功" : `失败 ${run.code ?? ""} ${run.message ?? ""}`}；模型 ${run.modelSeconds} s，修复 ${run.repairs}，¥${run.yuan}`;
  const executor = (value: string) => value === "human" ? "本人" : value === "agent" ? "助手" : "本人+助手";
  for (const account of meta.accounts) {
    lines.push("", `## ${account.label}`);
    if (account.tasks.length) lines.push("", "### 拆步骤");
    for (const task of account.tasks) {
      const order = base?.listWorkOrders(account.workspaceId).find((item) => item.id === task);
      const existing = base?.getStepPlan(account.workspaceId, task);
      lines.push("", `#### ${order ? taskTitleOf(order) : task}`, "", `现有计划：${existing ? existing.steps.map((step) => step.title).join(" → ") : "无"}`);
      for (const model of meta.models) {
        const run = find(model, account.workspaceId, "steps", task);
        const plan = planOf(model, account.workspaceId, task);
        lines.push("", `**${model}**：${runHead(run)}`);
        // Without the copies, the summary the run kept (step titles, minutes, done criteria) is what there is to read.
        const kept = (run?.result as { steps?: Array<{ title: string; executor: string; p50: number; done: string; firstAction: string }> } | null)?.steps;
        if (!plan && kept) lines.push("", ...kept.map((step, index) => `- ${index + 1}. [${executor(step.executor)}] ${step.title}（${step.p50} 分）`
          + `${step.done ? `；完成标准：${step.done}` : ""}${step.firstAction ? `；第一步：${step.firstAction}` : ""}`));
        if (!plan) continue;
        lines.push("", `- 依据：${plan.rationale || "（无）"}`, ...(plan.steps.filter((step) => step.status === "planned") as PlanStep[]).map((step, index) =>
          `- ${index + 1}. [${executor(step.executor)}] ${step.title}（${step.estimate.p50Minutes} 分）${step.doneCriterion ? `；完成标准：${step.doneCriterion}` : ""}`
          + `${step.firstAction ? `；第一步：${step.firstAction}` : ""}${step.why ? `；理由：${step.why}` : ""}`),
          ...plan.questions.map((question) => `- 问：${question.text}${question.options?.length ? `（${question.options.join(" / ")}）` : ""}`));
      }
    }
    if (account.milestones.length) lines.push("", "### 倒推任务");
    for (const milestone of account.milestones) {
      const item = base?.listMilestones(account.workspaceId).filter((entry) => entry.id === milestone).at(-1);
      const existing = base?.listWorkOrders(account.workspaceId).filter((order) => order.milestoneId === milestone && (order.payload as { backplan?: unknown } | undefined)?.backplan) ?? [];
      lines.push("", `#### ${item?.title ?? milestone}`, "", `现有任务：${existing.map((order) => `${taskTitleOf(order)}（${order.estimate.p50Minutes} 分）`).join("、") || "无"}`);
      for (const model of meta.models) {
        lines.push("", `**${model}**：${runHead(find(model, account.workspaceId, "backplan", milestone))}`);
        const tasks = tasksOf(model, account.workspaceId, milestone);
        if (tasks.length) lines.push("", ...tasks.map((task, index) => `- ${index + 1}. ${task.title}（${task.p50}–${task.p85} 分${task.due ? `，截止 ${task.due}` : ""}）`
          + `；说明：${task.intent}${task.rationale ? `；理由：${task.rationale}` : ""}${task.evidence ? `；交付：${task.evidence}` : ""}`));
      }
    }
  }
  base?.close();
  for (const store of stores.values()) store.close();
  const report = `${lines.join("\n")}\n`;
  writeFileSync(path.join(dir, "report.md"), report, "utf8");
  return report;
}

if (mode === "report") {
  console.info(writeReport(arg("run")!, { dialogues: arg("dialogues") }));
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
// The copies stay with the run (its folder is root's and the app user's only), so the report can be rebuilt from them later.
const copies = path.join(out, "copies");
mkdirSync(copies, { recursive: true });
const scratch = mkdtempSync(path.join(tmpdir(), "crossline-compare-"));
// The step planner writes the line's own skills beside the Codex home: a throwaway state directory, never the server's.
process.env.CROSSLINE_STATE_DIR = path.join(scratch, "state");
const base = path.join(copies, "base.db");
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
  return { workspaceId, label: emails.has(workspaceId) ? masked(emails.get(workspaceId)!) : workspaceId, tasks, milestones };
});
probe.close();
writeFileSync(path.join(out, "meta.json"), JSON.stringify({ models, accounts: picks.map((pick) => ({ workspaceId: pick.workspaceId, label: pick.label,
  tasks: pick.tasks.map((order) => order.id), milestones: pick.milestones.map((milestone) => milestone.id) })) } satisfies Meta, null, 2), "utf8");
console.info(JSON.stringify({ step: "picked", accounts: picks.map((pick) => ({ workspace: pick.workspaceId, tasks: pick.tasks.length, milestones: pick.milestones.length })), models }));

/** One copy per model; the picked milestones reset on it (their unstarted tasks and the record of the backplan removed). */
async function copyFor(model: string): Promise<CrosslineStore> {
  const file = path.join(copies, `${slug(model)}.db`);
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
async function compareOne(model: string): Promise<void> {
  const store = await copyFor(model);
  const keep = (record: RunRecord) => {
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
      keep({ model, workspace: workspaceId, kind: "steps", subject: order.id, title: taskTitleOf(order), ok: run.outcome.ok, ...(run.outcome.code ? { code: run.outcome.code } : {}),
        ...("message" in run.outcome && run.outcome.message ? { message: run.outcome.message.slice(0, 300) } : {}),
        seconds: run.seconds, modelSeconds: run.modelSeconds, repairs: run.repairs, tokens: run.tokens, yuan: run.yuan,
        result: planned?.state === "planned" ? { warnings: planned.warnings.map((warning) => warning.code) } : null });
    }
    const backplanner = createGoalBackplanner(store, workspaceId, repoRoot, () => supervisor.client, { rolling: true });
    for (const milestone of milestones) {
      const foldedBefore = store.listEvents(workspaceId, { type: "task.duplicate_prevented" }).length;
      let answer: { state: string; code?: string; message?: string } | undefined;
      const run = await measured(model, async () => { answer = await backplanner(milestone.id) as typeof answer;
        return answer?.state === "proposed" ? { ok: true } : { ok: false, code: answer?.code ?? "BACKPLAN_FAILED", message: answer?.message ?? "" }; });
      keep({ model, workspace: workspaceId, kind: "backplan", subject: milestone.id, title: milestone.title, ok: run.outcome.ok, ...(run.outcome.code ? { code: run.outcome.code } : {}),
        ...("message" in run.outcome && run.outcome.message ? { message: run.outcome.message.slice(0, 300) } : {}),
        seconds: run.seconds, modelSeconds: run.modelSeconds, repairs: run.repairs, tokens: run.tokens, yuan: run.yuan,
        result: { folded: store.listEvents(workspaceId, { type: "task.duplicate_prevented" }).length - foldedBefore } });
    }
  }
  store.close();
}

await Promise.all(models.map((model) => compareOne(model).catch((error: unknown) => {
  console.error(JSON.stringify({ step: "model_failed", model, message: error instanceof Error ? error.message : String(error) }));
})));
await supervisor.stop();
await gateway.close();
console.info(writeReport(out, { dialogues: arg("dialogues") }));
console.info(JSON.stringify({ step: "done", out }));
process.exit(0);
