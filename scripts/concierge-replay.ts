/**
 * The one input box's acceptance replay (docs/one-input.md §8, P1 and P2): thirty sentences written the way the person types, each sent as a
 * fresh turn of `crossline-concierge` against a **copy** of the real ledger (the live database is only read, through SQLite's online
 * backup), with the real Codex. Each case states what a right reading is — which action, on which object — and the run prints, per
 * case, what came back, how long it took and whether it matches; at the end the pass count and the median time to the first card.
 *
 *   pnpm exec tsx scripts/concierge-replay.ts [caseNumber…]
 *
 * Nothing is carried out: a turn only proposes. The copy gets three operations of its own first (a 「不等了」 among them), so the
 * undo cases have something recent to refer to — the failure of 2026-10-08 is case 1. It spends real quota; never run as a side effect.
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The web library guards itself with `import "server-only"`, which only Next resolves; here it is an empty module.
register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-concierge-replay-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";

const { CrosslineStore } = await import("../packages/db/src/index");
const { setUsageSink, startCodexSupervisor } = await import("../packages/codex/src/index");
const { createConcierge } = await import("../apps/worker/src/concierge");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { contextPack, conciergeSnapshot } = await import("../apps/web/lib/conversation");
const { executeAction } = await import("../apps/web/lib/actions");
type Turn = import("../packages/core/src/index").ConciergeTurn;
type Pack = import("../packages/core/src/index").ConciergePack;

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const principalId = store.getWorkspaceOwnerId(workspace.id)!;
const ctx = { principalId, workspaceId: workspace.id, role: "owner", identity: { provider: "credential", issuer: "replay", subject: principalId },
  authMethod: "session", requestId: "concierge-replay" } as import("../packages/core/src/index").AccessContext;

// Three recent operations on the copy: a 「不等了」 (the real failure), an energy reading and a note on a task.
const pack0 = await contextPack(ctx, { kind: "today", entityId: "" });
const hw2 = pack0.tasks.find((task) => /作业\s*2/.test(task.title));
if (hw2) {
  const today = pack0.today;
  await executeAction(ctx, { action: "task.op", summary: `等师兄的数据`, args: { workOrderId: hw2.id, type: "waiting", date: today, minutes: 0, stepId: "", text: "测量数据", who: "师兄", energy: "" } });
  const ask = (await contextPack(ctx, { kind: "today", entityId: "" })).asks.find((item) => item.kind === "waiting_due" && item.title.includes("测量数据"));
  if (ask) await executeAction(ctx, { action: "ask.answer", summary: "不等了：测量数据", args: { askId: ask.id, optionId: "cancelled", fields: [] } });
}
await executeAction(ctx, { action: "energy.report", summary: "精力中", args: { level: "medium", note: "" } });

setUsageSink((usage) => { if (usage.skillName.endsWith("concierge")) lastUsage = usage; });
let lastUsage: { durationMs: number; repairs: number; outputTokens: number } | undefined;
const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3398),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: ["crossline:crossline-concierge"] }
});
const client = () => supervisor.client;

type Check = (turn: Turn, pack: Pack) => string;   // "" = right
const only = (...ids: string[]): Check => (turn) => {
  const got = turn.actions.filter((_, index) => !turn.clarify.options.some((option) => option.actions.includes(index))).map((item) => item.action).sort();
  return JSON.stringify(got) === JSON.stringify([...ids].sort()) ? "" : `期望 ${ids.join("+") || "无动作"}，得到 ${got.join("+") || "无动作"}${turn.clarify.question ? `（追问：${turn.clarify.question}）` : ""}`;
};
const both = (...checks: Check[]): Check => (turn, pack) => checks.map((check) => check(turn, pack)).find(Boolean) ?? "";
const arg = (name: string, test: (value: unknown, pack: Pack) => boolean, what: string): Check => (turn, pack) =>
  turn.actions.some((item) => test((item.args as Record<string, unknown>)[name], pack)) ? "" : `${name} 不对（应为${what}）`;
const either = (...checks: Check[]): Check => (turn, pack) => checks.some((check) => !check(turn, pack)) ? "" : checks.map((check) => check(turn, pack)).join(" / ");
const asksOrClarifies: Check = (turn) => turn.clarify.question || (!turn.actions.length && turn.reply) ? "" : "应追问或说明，不应直接提出写入";
const taskId = (pattern: RegExp) => (value: unknown, pack: Pack) => pack.tasks.some((task) => task.id === value && pattern.test(task.title));

const cases: Array<[string, Check]> = [
  ["撤销刚刚的不等了", both(only("undo"), arg("opId", (value, pack) => pack.ops.find((op) => op.id === value)?.label.includes("不等了") ?? false, "「不等了」那次操作"))],
  ["ECE 555 作业2截止改到下周五", both(only("task.op"), arg("type", (value) => value === "due", "due"), arg("workOrderId", taskId(/作业\s*2/), "作业 2"))],
  ["作业2多给一小时", both(only("task.op"), arg("type", (value) => value === "estimate", "estimate"), arg("workOrderId", taskId(/作业\s*2/), "作业 2"))],
  ["ECE 548 复习提纲那个推到周日再做", both(only("task.op"), arg("type", (value) => value === "defer", "defer"), arg("workOrderId", taskId(/548/), "ECE 548 复习提纲"))],
  ["开始做作业2", both(only("task.op"), arg("type", (value) => value === "start", "start"))],
  ["作业2第一步做完了", both(either(only("task.op"), only("task.op", "task.op")), arg("type", (value) => value === "step_done", "step_done"))],
  ["刚才做了40分钟作业2，题目拆完了", either(only("task.op"), only("task.op", "task.op"))],
  ["今天好累，没什么精力", either(both(only("energy.report"), arg("level", (value) => value === "low", "low")), only("energy.report", "task.op"))],
  ["周四下午三点和导师开会一小时", both(only("event.create"), arg("startTime", (value) => value === "15:00", "15:00"), arg("endTime", (value) => value === "16:00", "16:00"))],
  ["每周二四 9:00–10:30 健身", both(only("event.create"), arg("weekdays", (value) => JSON.stringify(value) === "[2,4]", "[2,4]"))],
  // On a Friday evening 「这周五下午」 has passed: asking which afternoon is the right reading too.
  ["这周五下午不可用", either(only("event.create"), asksOrClarifies)],
  ["记一下：Cadence 安装要找实验室管理员", either(only("note.add"), only("task.create"), asksOrClarifies)],
  ["下周找时间读 hippocampus replay 的两篇综述", only("task.create")],
  ["我想成为能独立带项目的研究者", both(only("goal.add"), arg("lineId", (value, pack) => pack.lines.find((line) => line.id === value)?.label === "研究者", "研究者"))],
  // The account already has a paper milestone due 10/31: asking whether this is the same one is the right reading too.
  ["研究者里程碑：12 月前投出第一篇论文", either(only("milestone.draft"), asksOrClarifies)],
  ["加一条主线：跑者", both(only("line.add"), arg("label", (value) => value === "跑者", "跑者"))],
  ["我其实晚上效率更高", only("profile.tell")],
  ["这周还有多少空闲时间？", only()],
  ["为什么先排作业 2", only()],
  ["ECE 548 期中复习进度怎么样？", only()],
  ["批准 6T SRAM 那个任务提案", both(only("proposal.decide"), arg("decision", (value) => value === "approve", "approve"))],
  ["ECE 548 的里程碑草稿都批准", both(only("milestones.decide"), arg("milestoneIds", (value, pack) => Array.isArray(value) && value.length > 0
    && value.every((id) => pack.milestones.find((item) => item.id === id)?.title.includes("548")), "ECE 548 的草稿"))],
  ["「当前薄弱讲次」那个问题选 L3–L8", both(only("ask.answer"), arg("askId", (value) => String(value).startsWith("stepq:"), "步骤问题"))],
  ["券商结单那个待决明天再问", both(only("ask.snooze"), arg("until", (value) => value === "tomorrow", "tomorrow"))],
  ["采纳助手做的 ECE555 课程安排摘录", both(only("agent_result.review"), arg("decision", (value) => value === "accepted", "accepted"))],
  ["把 ECE 555 四次作业那个里程碑的重要性调到 80", both(only("importance.set"), arg("weight", (value) => value === 80, "80"))],
  ["那个", asksOrClarifies],
  ["撤销", only("undo")],
  ["作业3等师兄发题目，大概下周二", both(only("task.op"), arg("type", (value) => value === "waiting", "waiting"), arg("workOrderId", taskId(/作业\s*3/), "作业 3"))],
  ["选定首轮选题那个提案不要了，方向变了", both(only("proposal.decide"), arg("decision", (value) => value === "reject", "reject"))]
];

// P2: three lines said on a task's page (「这一步」 is its current step), and a correction across two turns.
const hw2Task = pack0.tasks.find((task) => /作业\s*2/.test(task.title));
const taskPage = { kind: "task", entityId: hw2Task?.id ?? "" };
const currentStep = (pack: Pack) => pack.tasks.find((task) => task.id === taskPage.entityId)?.steps.find((step) => step.status === "planned")?.id;
type Case = { text: string; check: Check; page?: { kind: string; entityId: string }; then?: { text: string; check: Check } };
const all: Case[] = [...cases.map(([text, check]) => ({ text, check })),
  { text: "这一步做完了", page: taskPage, check: both(only("task.op"), arg("stepId", (value, pack) => value === currentStep(pack), "本页任务的当前步骤")) },
  { text: "截止推迟两天", page: taskPage, check: both(only("task.op"), arg("workOrderId", (value) => value === taskPage.entityId, "本页任务")) },
  { text: "用了 30 分钟，卡在第三题", page: taskPage, check: either(only("task.op"), only("task.op", "task.op")) },
  { text: "作业2截止改到周四", check: only("task.op"), then: { text: "不对，是周五",
    check: (turn) => turn.corrects ? both(only("task.op"), arg("date", (value) => new Date(`${String(value)}T12:00:00Z`).getUTCDay() === 5, "周五"))(turn, pack0) : "未标为更正" } }
];

const picked = process.argv.slice(2).map(Number).filter((n) => n >= 1 && n <= all.length);
const results: Array<{ n: number; ok: boolean; seconds: number; reviewed: boolean; changed: boolean }> = [];
const run = createConcierge(store, workspace.id, repoRoot, client);
const { needsReview } = await import("../packages/core/src/index");
/** One turn as the web runs it: the quick reading, and when it needs one, the second look on the stronger model. */
const turnOf = async (conversationId: string, text: string, page: { kind: string; entityId: string }, corrected: boolean) => {
  const pack = await contextPack(ctx, page);
  const request = { conversationId, text, mentions: [], snapshot: conciergeSnapshot(pack, new Date(), { lists: true }), pack, history: [], ...(corrected ? { corrected } : {}) };
  const first = await run(request);
  if (first.state !== "replied" || corrected || !needsReview(first.turn, first.warnings)) return { pack, outcome: first, reviewed: false, changed: false };
  const second = await run({ ...request, review: true });
  if (second.state !== "replied") return { pack, outcome: first, reviewed: true, changed: false };
  return { pack, outcome: second, reviewed: true, changed: JSON.stringify(second.turn.actions) !== JSON.stringify(first.turn.actions) };
};
for (const [index, item] of all.entries()) {
  if (picked.length && !picked.includes(index + 1)) continue;
  const conversation = store.conversationFor(workspace.id, `replay-${String(index + 1).padStart(2, "0")}`);
  const started = Date.now();
  lastUsage = undefined;
  let { pack, outcome, reviewed, changed } = await turnOf(conversation.id, item.text, item.page ?? { kind: "today", entityId: "" }, false);
  let check = item.check;
  let text = item.text;
  if (item.then && outcome.state === "replied" && !item.check(outcome.turn, pack)) {
    // The correction is the next line on the same thread; from then on the stronger model reads at once.
    ({ pack, outcome, reviewed, changed } = await turnOf(conversation.id, item.then.text, item.page ?? { kind: "today", entityId: "" }, false));
    check = item.then.check; text = `${item.text} → ${item.then.text}`;
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (outcome.state !== "replied") {
    console.info(JSON.stringify({ n: index + 1, text, ok: false, seconds, blocked: outcome.code, message: outcome.message }));
    results.push({ n: index + 1, ok: false, seconds, reviewed, changed });
    continue;
  }
  const problem = check(outcome.turn, pack);
  results.push({ n: index + 1, ok: !problem, seconds, reviewed, changed });
  console.info(JSON.stringify({ n: index + 1, text, ok: !problem, seconds, reviewed, changed, ...(problem ? { problem } : {}),
    reply: outcome.turn.reply.slice(0, 160), actions: outcome.turn.actions.map((entry) => `${entry.action}:${entry.summary}`),
    ...(outcome.turn.clarify.question ? { clarify: `${outcome.turn.clarify.question} [${outcome.turn.clarify.options.map((option) => option.label).join(" | ")}]` } : {}) }));
}
const times = results.map((item) => item.seconds).sort((a, b) => a - b);
console.info(JSON.stringify({ passed: results.filter((item) => item.ok).length, of: results.length, medianSeconds: times[Math.floor(times.length / 2)] ?? null,
  reviewed: results.filter((item) => item.reviewed).map((item) => item.n), changedByReview: results.filter((item) => item.changed).map((item) => item.n),
  failed: results.filter((item) => !item.ok).map((item) => item.n), captures: store.listCaptures(workspace.id).length, dataDir }));
await supervisor.stop();
store.close();
process.exit(0);
