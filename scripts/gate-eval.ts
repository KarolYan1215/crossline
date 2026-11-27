/**
 * J1's evaluation (docs/plans/execution-gates-1124.md §一.3 and §四 J1): is the completion gate right often enough to act on?
 *
 *   pnpm exec tsx scripts/gate-eval.ts backfill <copy.db> [--workspace <id>] [--days 60]
 *     Judges, on the copy only, every task of the person's that was open or finished in the last `--days` (the resident gate looks only
 *     two weeks back, so a fresh deployment has too few judgements to label). Spends the owner's Codex quota; writes nothing else.
 *
 *   pnpm exec tsx scripts/gate-eval.ts export <copy.db> <out-dir> [--workspace <id>] [--days 60]
 *     Writes `label.html` (the labelling page with the cases inside: open it and label), `cases.json` (each judged task with the evidence
 *     the gate could see, nothing of its verdict) and `key.json` (the gate's verdicts, kept apart so the labelling is blind). The page's
 *     「保存」 downloads `labels.json`.
 *
 *   pnpm exec tsx scripts/gate-eval.ts score <out-dir> [--labels <labels.json>]
 *     Compares `key.json` with the labels (`--labels`, else `labels.json` in the folder, else the newest `labels*.json` in Downloads that
 *     belongs to this export): the confusion matrix, agreement, Cohen's kappa, and the precision of `done` with its Wilson lower bound
 *     (one-sided 95%). The bar (§一.3): at least 51 `done` judgements with no error — otherwise J1 stays record-only.
 *
 * Mail text is never stored, so a case shows sent mail by its domains and subject only (what the gate saw beside a 500-character excerpt
 * it read at the time). Refuses a file in a folder named `data` (the live ledger): pass a copy.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { CANNOT_JUDGE, GATE_JUDGED, GATE_SPEC, latestGateJudgements, type GateJudgedPayload } from "../packages/core/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { COMPLETION_SKILL, COMPLETION_WINDOW_DAYS, completionEvidence, judgeCompletion } from "../apps/worker/src/gates/completion";
import { GATE_LIMITS } from "../apps/worker/src/gates/context";
import { boardTasks, gateLookups, gateTask, isFinished, isOpen } from "../apps/worker/src/gates/tasks";

const CLASSES = [...GATE_SPEC.completion.verdicts, CANNOT_JUDGE];
type Key = { caseId: string; judgedId: string; taskId: string; verdict: string; pair?: string; disagrees: boolean; confidence: string; at: string };
type Label = { caseId: string; label: string; note?: string };

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const [command, first, second] = args;

const repoRoot = path.resolve(import.meta.dirname, "..");
const since = () => new Date(Date.now() - Number(flag("--days") ?? 60) * 86_400_000).toISOString();

if (command === "backfill") await backfill(first);
else if (command === "export") exportCases(first, second);
else if (command === "score") score(first);
else throw new Error("usage: gate-eval.ts backfill <copy.db> | export <copy.db> <out-dir> | score <out-dir>");

function refuseLive(file: string) {
  if (path.basename(path.dirname(path.resolve(file))).toLowerCase() === "data") throw new Error("REFUSED_LIVE_LEDGER: pass a copy, not a file in data/");
}

/** The workspace named, else the one that ranks first by `by`. */
function pickWorkspace(store: CrosslineStore, by: (id: string) => number): string {
  const named = flag("--workspace");
  if (named) return named;
  const best = [...store.listWorkspaces()].sort((a, b) => by(b.id) - by(a.id))[0];
  if (!best) throw new Error("NO_WORKSPACE in this ledger");
  return best.id;
}

async function backfill(file: string | undefined) {
  if (!file) throw new Error("usage: gate-eval.ts backfill <copy.db>");
  refuseLive(file);
  const store = new CrosslineStore(file);
  const workspaceId = pickWorkspace(store, (id) => store.listWorkOrders(id).length);
  const from = since();
  const finishedAt = new Map(store.listEvents(workspaceId, { type: "work_order.transitioned" }).filter((event) => (event.payload as { event?: { type?: string } }).event?.type === "human.completed").map((event) => [String((event.payload as { workOrderId?: string }).workOrderId ?? event.entityId), event.createdAt]));
  const judged = new Set(store.listEvents(workspaceId, { type: GATE_JUDGED }).filter((event) => (event.payload as GateJudgedPayload).gate === "completion").map((event) => event.entityId));
  const orders = boardTasks(store, workspaceId).filter((order) => !judged.has(order.id) && (isOpen(order) || (isFinished(order) && (finishedAt.get(order.id) ?? "") >= from)));
  console.log(`backfill: ${orders.length} tasks in workspace ${workspaceId} since ${from.slice(0, 10)}`);
  const supervisor = await startCodexSupervisor({ port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
    plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
      requiredSkills: [`crossline:${COMPLETION_SKILL}`] } });
  try {
    for (let at = 0; at < orders.length; at += GATE_LIMITS.tasksPerCall) {
      const results = await judgeCompletion({ store, workspaceId, client: supervisor.client, cwd: repoRoot }, orders.slice(at, at + GATE_LIMITS.tasksPerCall), from);
      console.log(`  ${Math.min(at + GATE_LIMITS.tasksPerCall, orders.length)}/${orders.length}: ${results.map((item) => item.output.verdict).join(", ") || "no answer"}`);
    }
  } finally {
    await supervisor.stop();
    store.close();
  }
}

function exportCases(file: string | undefined, out: string | undefined) {
  if (!file || !out) throw new Error("usage: gate-eval.ts export <copy.db> <out-dir>");
  refuseLive(file);
  // Opening a ledger runs pending migrations; a second copy keeps even the person's copy untouched.
  const scratch = path.join(tmpdir(), `gate-eval-${process.pid}.db`);
  copyFileSync(file, scratch);
  const store = new CrosslineStore(scratch);
  const workspaceId = pickWorkspace(store, (id) => store.listEvents(id, { type: GATE_JUDGED }).length);
  const from = since();
  const events = [...store.listEvents(workspaceId, { type: GATE_JUDGED }), ...store.listEvents(workspaceId, { type: "gate.changed", change: "overridden" })];
  const pairs = new Map(events.filter((event) => event.type === GATE_JUDGED && (event.payload as GateJudgedPayload).run === 2)
    .map((event) => [(event.payload as GateJudgedPayload).pairedWith ?? "", event.payload as GateJudgedPayload]));
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  const lookups = gateLookups(store, workspaceId);
  const cases: unknown[] = [];
  const keys: Key[] = [];
  for (const judgement of latestGateJudgements(events, "completion").values()) {
    if (judgement.at < from) continue;
    const order = orders.get(judgement.payload.subject.id);
    if (!order) continue;
    const caseId = `c${String(cases.length + 1).padStart(3, "0")}`;
    // What the gate could see when it judged: its window, up to the judgement (a backfilled judgement looked back `--days`).
    const windowStart = new Date(Math.min(Date.parse(judgement.at) - COMPLETION_WINDOW_DAYS * 86_400_000, Date.parse(from))).toISOString();
    const evidence = completionEvidence(store, workspaceId, windowStart, new Map(), judgement.at);
    cases.push({ caseId, judgedAt: judgement.at, task: gateTask(store, workspaceId, order, lookups), evidence });
    const pair = pairs.get(judgement.eventId);
    keys.push({ caseId, judgedId: judgement.eventId, taskId: order.id, verdict: judgement.payload.output.verdict, ...(pair ? { pair: pair.output.verdict } : {}),
      disagrees: Boolean(pair?.disagrees), confidence: judgement.payload.output.confidence, at: judgement.at });
  }
  store.close();
  mkdirSync(out, { recursive: true });
  // Shuffled, so the order says nothing about when or how a case was judged.
  const order = cases.map((_, index) => index).sort(() => Math.random() - 0.5);
  const exportedAt = new Date().toISOString();
  const payload = { workspaceId, exportedAt, cases: order.map((index) => cases[index]) };
  writeFileSync(path.join(out, "cases.json"), JSON.stringify(payload, null, 2));
  writeFileSync(path.join(out, "key.json"), JSON.stringify({ workspaceId, exportedAt, keys }, null, 2));
  // The page with the cases inside, so labelling is opening one file. `<` is escaped so no case text can close the script element.
  const embedded = JSON.stringify(payload).replaceAll("<", "\\u003c");
  const page = readFileSync(path.join(repoRoot, "scripts", "gate-eval", "label.html"), "utf8").replace("<script>", () => `<script>window.GATE_EVAL_CASES = ${embedded};</script>\n<script>`);
  writeFileSync(path.join(out, "label.html"), page);
  console.log(`exported ${cases.length} cases (workspace ${workspaceId}); open ${path.resolve(out, "label.html")} to label them`);
}

/** Wilson score interval's lower bound, one-sided at `z` (1.645 for 95%). */
export function wilsonLower(successes: number, n: number, z = 1.645): number {
  if (!n) return 0;
  const p = successes / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export function cohenKappa(pairs: ReadonlyArray<[string, string]>): number {
  const n = pairs.length;
  if (!n) return 0;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = CLASSES.reduce((sum, name) => sum + (pairs.filter(([a]) => a === name).length / n) * (pairs.filter(([, b]) => b === name).length / n), 0);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

/** `--labels`, else `labels.json` beside the key, else the newest `labels*.json` in Downloads written for this export. */
function findLabels(out: string, exportedAt: string | undefined): string {
  const named = flag("--labels");
  if (named) return named;
  if (existsSync(path.join(out, "labels.json"))) return path.join(out, "labels.json");
  const downloads = path.join(homedir(), "Downloads");
  const found = (existsSync(downloads) ? readdirSync(downloads) : []).filter((name) => /^labels.*\.json$/.test(name)).map((name) => path.join(downloads, name))
    .filter((file) => { try { return (JSON.parse(readFileSync(file, "utf8")) as { exportedAt?: string }).exportedAt === exportedAt; } catch { return false; } })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!found) throw new Error(`no labels for this export: pass --labels <file>, or put labels.json in ${out}`);
  return found;
}

function score(out: string | undefined) {
  if (!out) throw new Error("usage: gate-eval.ts score <out-dir>");
  if (!existsSync(path.join(out, "key.json"))) throw new Error(`missing key.json in ${out}`);
  const key = JSON.parse(readFileSync(path.join(out, "key.json"), "utf8")) as { exportedAt?: string; keys: Key[] };
  const keys = key.keys;
  const labelFile = findLabels(out, key.exportedAt);
  console.log(`labels: ${labelFile}`);
  const labels = new Map((JSON.parse(readFileSync(labelFile, "utf8")) as { labels: Label[] }).labels.map((item) => [item.caseId, item]));
  const pairs: Array<[string, string]> = keys.flatMap((key) => { const label = labels.get(key.caseId)?.label; return label ? [[key.verdict, label] as [string, string]] : []; });
  const matrix = CLASSES.map((model) => CLASSES.map((person) => pairs.filter(([a, b]) => a === model && b === person).length));
  const done = pairs.filter(([model]) => model === "done");
  const doneRight = done.filter(([, person]) => person === "done").length;
  const agreement = pairs.length ? pairs.filter(([a, b]) => a === b).length / pairs.length : 0;
  const lower = wilsonLower(doneRight, done.length);
  const disagreed = keys.filter((key) => key.pair !== undefined);
  const caught = disagreed.filter((key) => key.disagrees && labels.get(key.caseId)?.label !== key.verdict).length;
  const missed = disagreed.filter((key) => !key.disagrees && labels.has(key.caseId) && labels.get(key.caseId)!.label !== key.verdict).length;
  console.log(`## J1 completion gate: ${pairs.length} labelled of ${keys.length} cases`);
  console.log();
  console.log(`| model \\ person | ${CLASSES.join(" | ")} |`);
  console.log(`|---|${CLASSES.map(() => "---").join("|")}|`);
  CLASSES.forEach((name, index) => console.log(`| ${name} | ${matrix[index]!.join(" | ")} |`));
  console.log();
  console.log(`- agreement: ${(agreement * 100).toFixed(1)}% (target ≥ 85%)`);
  console.log(`- Cohen's kappa: ${cohenKappa(pairs).toFixed(3)}`);
  console.log(`- done precision: ${doneRight}/${done.length}, Wilson lower bound (one-sided 95%) ${(lower * 100).toFixed(1)}%`);
  console.log(`- bar (§一.3, ≥ 51 done with 0 errors): ${done.length >= 51 && doneRight === done.length ? "MET" : "NOT MET — J1 stays record-only"}`);
  console.log(`- dual runs: ${disagreed.length}; wrong and caught by disagreement ${caught}; wrong although both runs agreed ${missed}`);
}
