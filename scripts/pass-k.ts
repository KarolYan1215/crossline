/**
 * pass^k for the Skills whose answer decides something (docs/plans/harness-1125.md §10): each case is run k times through the real worker
 * path (a fresh in-memory ledger per run, the real Codex runtime), and the report says how often every one of the k runs passed (pass^k),
 * how often a single run passed (pass@1), how often the k runs disagreed with each other, and the disagreeing cases.
 *
 *   pnpm exec tsx scripts/pass-k.ts [--suite mail|gate|steps|all] [--k 3] [--limit 2] [--cases a,b] [--out <dir>] [--dry]
 *
 * Suites:
 *   mail   crossline-inbox-triage:mail on testing/fixtures/mail-intake-1120.json; a run passes when the captures and the mail log are the case's
 *          `expect` (the same check the replay test makes with recorded answers). Decision: the log kinds and the capture count.
 *   gate   crossline-evidence-judge:milestone on hand-written evidence (no personal data); passes when the verdict is one the case allows.
 *   steps  crossline-task-planner:steps (and its validation reviewer) on a task with no method on record; passes when a plan is stored and none
 *          of its steps is a drill form the person never described (訂正/错题, the owner's rule of 2026-11-10). Decision: the archetype,
 *          the step count and which steps are external.
 *
 * Spends the owner's ChatGPT/Codex quota: reads `account/rateLimits/read` first and does not run when a limit is reached or the short
 * window is above `--max-used` percent (default 80). Never touches a ledger on disk. Not run in CI (public repository, no credentials).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FIXED_EVENTS, MAIL_LOG_SETTING } from "../packages/core/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { readCostSignal, startCodexSupervisor, type CodexRpcBoundary } from "../packages/codex/src/index";
import type { ImapFactory, SecretStore } from "../packages/connectors/src/index";
import { addMailAccount, MAIL_TRIAGE_SKILL, readNewMail, triageMail } from "../apps/worker/src/mailbox";
import { createMilestoneGate, MILESTONE_GATE_SKILL } from "../apps/worker/src/milestone-gate-runner";
import { createStepPlanner } from "../apps/worker/src/step-planner";

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const repoRoot = path.resolve(import.meta.dirname, "..");
const K = Math.max(1, Number(flag("--k") ?? 3));
const LIMIT = Math.max(1, Number(flag("--limit") ?? 2));
const MAX_USED = Number(flag("--max-used") ?? 80);
const ONLY = flag("--cases")?.split(",").map((item) => item.trim()).filter(Boolean);
const SUITE = flag("--suite") ?? "all";
const OUT = flag("--out") ?? path.join(tmpdir(), "crossline-eval");

export type RunResult = { decision: string; pass: boolean; note?: string };
type Suite = { name: string; skills: string[]; cases: () => string[]; run: (name: string, client: CodexRpcBoundary) => Promise<RunResult> };

// ── mail triage ────────────────────────────────────────────────────────────────────────────────────────────────────────
type IntakeCase = { mails: Array<{ uid: number; subject: string; body: string; headers?: string; to?: string[] }>; expect: { captures: number; log: string[]; events?: number } };
const INTAKE = (JSON.parse(readFileSync(path.join(repoRoot, "apps/worker/src/testing/fixtures/mail-intake-1120.json"), "utf8")) as { cases: Record<string, IntakeCase> }).cases;

/** An IMAP mailbox in memory, as mailbox.test.ts builds it (the sender is a course's professor; the case says the rest). */
function memoryMailbox() {
  const messages: IntakeCase["mails"] = [];
  const raw = (m: IntakeCase["mails"][number]) => Buffer.from(`From: Prof Lin <lin@uni.edu>\r\nSubject: ${m.subject}\r\n${m.headers ?? ""}Content-Type: text/plain\r\n\r\n${m.body}\r\n`);
  const factory: ImapFactory = () => ({
    connect: async () => undefined, logout: async () => undefined,
    mailboxOpen: async () => ({ uidValidity: 1n, uidNext: (messages.at(-1)?.uid ?? 0) + 1 }) as never,
    search: (async (query: { uid?: string }) => query.uid ? messages.filter((m) => m.uid >= Number(query.uid!.split(":")[0])).map((m) => m.uid) : messages.map((m) => m.uid)) as never,
    fetchAll: (async (uids: number[]) => messages.filter((m) => uids.includes(m.uid)).map((m) => ({ seq: m.uid, uid: m.uid,
      envelope: { subject: m.subject, from: [{ name: "Prof Lin", address: "lin@uni.edu" }], date: new Date("2026-11-10T08:00:00Z"),
        ...(m.to ? { to: m.to.map((address) => ({ address })) } : {}) }, source: raw(m) }))) as never,
    fetchOne: (async () => false) as never
  });
  return { messages, factory };
}
const memorySecrets = (): SecretStore => {
  const values = new Map<string, string>();
  return { read: async (w, n) => values.get(`${w}/${n}`), write: async (w, n, v) => { values.set(`${w}/${n}`, v); }, remove: (w, n) => { values.delete(`${w}/${n}`); } };
};

const mailSuite: Suite = {
  name: "mail", skills: [MAIL_TRIAGE_SKILL], cases: () => Object.keys(INTAKE),
  async run(name, client) {
    const item = INTAKE[name]!;
    const store = new CrosslineStore(":memory:");
    try {
      const { principal, workspace } = store.createPrincipalWithWorkspace("eval-user", "w");
      const workspaceId = workspace.id;
      store.saveMilestone({ id: "m-ctrl", ownerId: principal.id, workspaceId, identityId: "research", projectId: "p", title: "控制方向资格考", version: 1, status: "approved" });
      store.setSetting(workspaceId, FIXED_EVENTS, JSON.stringify([{ id: "fixed-group", title: "组会", lineId: "research", date: "2026-11-03", start: "14:00", end: "15:00",
        location: "", source: "input", repeat: { weekdays: [2], from: "2026-11-03", until: "2026-12-15", exceptions: [] } }]));
      const box = memoryMailbox();
      let now = new Date("2026-11-10T09:00:00Z");
      const deps = { store, secrets: memorySecrets(), resolve: async () => "203.0.113.10", factory: box.factory, now: () => now };
      await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
      await readNewMail(deps, workspaceId);
      box.messages.push(...item.mails);
      now = new Date("2026-11-10T09:20:00Z");
      const fresh = await readNewMail(deps, workspaceId);
      const done = await triageMail({ ...deps, client, cwd: repoRoot }, workspaceId, fresh);
      if (done.state !== "done") return { decision: `skipped:${done.reason}`, pass: false };
      const log = (JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING) ?? "[]") as Array<{ kind: string }>).map((entry) => entry.kind);
      const decision = `log=${log.join("+")} captures=${done.captured}${item.expect.events !== undefined ? ` events=${done.events}` : ""}`;
      const pass = done.captured === item.expect.captures && log.join("+") === item.expect.log.join("+")
        && (item.expect.events === undefined || done.events === item.expect.events);
      return { decision, pass };
    } finally { store.close(); }
  }
};

// ── milestone gate ─────────────────────────────────────────────────────────────────────────────────────────────────────
const WS = "eval-ws";
const OWNER = "local-owner";
type GateCase = { evidence: string; contract: string; criterion: string; allowed: string[] };
const GATE_CASES: Record<string, GateCase> = {
  "delivered-with-file": { contract: "实验结论记录（三条结论，每条附数据出处）", criterion: "写出一份实验结论记录",
    evidence: "结论记录写完了：conclusions.md，三条结论——阈值电压随温度线性下降（数据 run-12.csv）、漏电流在 85°C 翻倍（run-14.csv）、迁移率与掺杂浓度无关（run-15.csv）。",
    allowed: ["pass"] },
  "claimed-without-content": { contract: "实验结论记录（三条结论，每条附数据出处）", criterion: "写出一份实验结论记录",
    evidence: "做完了。", allowed: ["partial", "insufficient", "refuted"] },
  "half-delivered": { contract: "两份周报：第 46 周、第 47 周", criterion: "交两份周报",
    evidence: "第 46 周的周报已发给导师（附件 week46.pdf）。第 47 周的还没写。", allowed: ["partial", "insufficient"] }
};

const gateSuite: Suite = {
  name: "gate", skills: [MILESTONE_GATE_SKILL], cases: () => Object.keys(GATE_CASES),
  async run(name, client) {
    const item = GATE_CASES[name]!;
    const store = new CrosslineStore(":memory:");
    try {
      store.saveMilestone({ id: "m", ownerId: OWNER, workspaceId: WS, identityId: "research", projectId: "p", title: "器件表征阶段性成果", version: 1, status: "approved",
        successCriteria: [{ id: "c", statement: item.criterion, required: true, measure: { kind: "count", unit: "份", atLeast: 1 } }] });
      store.saveWorkOrder({ id: "w1", ownerId: OWNER, workspaceId: WS, identityId: "research", projectId: "p", milestoneId: "m", intent: item.criterion, state: "ready_for_human",
        riskTier: "milestone", payload: { evidenceContract: [{ kind: "record", description: item.contract, why: "本作业的交付物", required: true }] },
        estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 120, source: "llm_prior", observationCount: 0, confidence: "low" } });
      store.transitionWorkOrder(WS, "w1", { type: "human.started" }, "start:w1");
      store.transitionWorkOrder(WS, "w1", { type: "human.completed" }, "done:w1", { evidence: [{ kind: "record", uri: "local://r", description: item.evidence }] });
      const outcome = await createMilestoneGate(store, WS, repoRoot, () => client)("w1") as { state: string; verdict?: string; code?: string };
      const verdict = outcome.verdict ?? outcome.code ?? "";
      return { decision: `${outcome.state}:${verdict}`, pass: item.allowed.includes(verdict) };
    } finally { store.close(); }
  }
};

// ── step planner ───────────────────────────────────────────────────────────────────────────────────────────────────────
type StepCase = { intent: string; milestone: string; facts: Array<{ slot: string; value: string }> };
const STEP_CASES: Record<string, StepCase> = {
  "exam-prep-no-method": { intent: "准备 ECE 555 期中考试（第 1–6 讲）", milestone: "ECE 555 期中", facts: [] },
  "homework": { intent: "完成 ECE 555 作业 4（5 道题，周五交）", milestone: "ECE 555 期中", facts: [] },
  "own-method": { intent: "准备 ECE 555 期中考试（第 1–6 讲）", milestone: "ECE 555 期中",
    facts: [{ slot: "method_exam_prep", value: "做完往年卷我习惯对着答案订正，错题记进错题本" }] }
};
const DRILL = /订正|错题/u;

const stepsSuite: Suite = {
  name: "steps", skills: ["crossline:crossline-task-planner:steps", "crossline:crossline-validation-reviewer"], cases: () => Object.keys(STEP_CASES),
  async run(name, client) {
    const item = STEP_CASES[name]!;
    const store = new CrosslineStore(":memory:");
    try {
      store.saveMilestone({ id: "m", ownerId: OWNER, workspaceId: WS, identityId: "research", projectId: "ece555", title: item.milestone, status: "approved", version: 1 });
      store.saveWorkOrder({ id: "wo", ownerId: OWNER, workspaceId: WS, identityId: "research", projectId: "ece555", milestoneId: "m", intent: item.intent, state: "approved",
        riskTier: "milestone", estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { family: "deep_work" } });
      for (const fact of item.facts) store.upsertProfileFact({ workspaceId: WS, identityId: "person", projectId: "", slot: fact.slot, value: fact.value, status: "confirmed",
        sourceRef: "reply-1", sourceQuote: fact.value, updatedAt: "2026-11-10T00:00:00Z" });
      const outcome = await createStepPlanner(store, WS, repoRoot, () => client)("wo");
      if (outcome.state !== "planned") return { decision: `blocked:${outcome.code}`, pass: false };
      const plan = store.getStepPlan(WS, "wo")!;
      const written = plan.steps.map((step) => `${step.title} ${step.deliverable}`).join(" ");
      const external = plan.steps.map((step) => ((step as { external?: boolean }).external ? "E" : "-")).join("");
      const decision = `${plan.archetypeId} steps=${plan.steps.length} external=${external}`;
      const drilled = DRILL.test(written);
      return { decision, pass: item.facts.length ? true : !drilled, note: plan.steps.map((step) => step.title).join(" / ") };
    } finally { store.close(); }
  }
};

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type CaseReport = { suite: string; name: string; runs: RunResult[]; allPass: boolean; agree: boolean };
export type SuiteReport = { suite: string; k: number; cases: number; passK: number; pass1: number; disagreement: number; examples: CaseReport[] };

/** pass^k: the share of cases where all k runs passed; pass@1: the share of single runs that passed; disagreement: cases whose k decisions differ. */
export function summarize(suite: string, k: number, cases: CaseReport[]): SuiteReport {
  const runs = cases.flatMap((item) => item.runs);
  const share = (count: number, of: number) => of ? Math.round((count / of) * 1000) / 1000 : 0;
  return { suite, k, cases: cases.length, passK: share(cases.filter((item) => item.allPass).length, cases.length),
    pass1: share(runs.filter((run) => run.pass).length, runs.length), disagreement: share(cases.filter((item) => !item.agree).length, cases.length),
    examples: cases.filter((item) => !item.agree || !item.allPass) };
}

async function main() {
  const suites = [mailSuite, gateSuite, stepsSuite].filter((suite) => SUITE === "all" || suite.name === SUITE);
  if (!suites.length) throw new Error("usage: --suite mail|gate|steps|all");
  const plan = suites.map((suite) => ({ suite, names: (ONLY ? suite.cases().filter((name) => ONLY.includes(name)) : suite.cases()).slice(0, LIMIT) }));
  const total = plan.reduce((sum, item) => sum + item.names.length * K, 0);
  console.log(`pass-k: k=${K}, ${plan.map((item) => `${item.suite.name}[${item.names.join(",")}]`).join(" ")} → ${total} runs`);
  if (args.includes("--dry")) return;
  const supervisor = await startCodexSupervisor({ port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
    plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
      requiredSkills: [...new Set(suites.flatMap((suite) => suite.skills))] } });
  const reports: SuiteReport[] = [];
  try {
    const cost = await readCostSignal(supervisor.client);
    console.log(`quota: ${JSON.stringify(cost)}`);
    if (cost.available && (cost.limitReached || (cost.short?.usedPercent ?? 0) > MAX_USED)) {
      console.log(`NOT RUN: the Codex quota is at ${cost.short?.usedPercent}% of its short window${cost.limitReached ? " (limit reached)" : ""}; --max-used ${MAX_USED}.`);
      process.exitCode = 2;
      return;
    }
    for (const { suite, names } of plan) {
      const cases: CaseReport[] = [];
      for (const name of names) {
        const runs: RunResult[] = [];
        for (let at = 0; at < K; at += 1) {
          const started = Date.now();
          try { runs.push(await suite.run(name, supervisor.client)); } catch (error) { runs.push({ decision: `error:${error instanceof Error ? error.message.slice(0, 80) : "?"}`, pass: false }); }
          console.log(`  ${suite.name}/${name} #${at + 1}: ${runs.at(-1)!.pass ? "pass" : "FAIL"} ${runs.at(-1)!.decision} (${Math.round((Date.now() - started) / 1000)}s)`);
          if (/SKILL_USAGE_LIMIT|usageLimitExceeded/.test(runs.at(-1)!.decision)) throw new Error("Codex quota ran out mid-run");
        }
        cases.push({ suite: suite.name, name, runs, allPass: runs.every((run) => run.pass), agree: new Set(runs.map((run) => run.decision)).size === 1 });
      }
      reports.push(summarize(suite.name, K, cases));
    }
  } finally {
    await supervisor.stop();
  }
  console.log("\n| suite | cases | k | pass^k | pass@1 | 分歧率 |\n|---|---|---|---|---|---|");
  for (const report of reports) console.log(`| ${report.suite} | ${report.cases} | ${report.k} | ${report.passK} | ${report.pass1} | ${report.disagreement} |`);
  for (const report of reports) for (const example of report.examples)
    console.log(`\n${example.suite}/${example.name}${example.agree ? "" : " (分歧)"}:\n${example.runs.map((run, index) => `  #${index + 1} ${run.pass ? "pass" : "FAIL"} ${run.decision}${run.note ? ` — ${run.note}` : ""}`).join("\n")}`);
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `pass-k-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), k: K, reports }, null, 2), "utf8");
  console.log(`\nreport: ${file}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === "pass-k.ts") await main();
