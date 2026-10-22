/**
 * What the one-time work-split reorganisation (docs/work-split.md §5, `apps/worker/src/work-split-repair.ts`) would do to a ledger, without
 * doing it: per workspace, how many open tasks go to the assistant, become a question or stay the person's, which are left alone, which
 * approved milestones are only preparation, and which milestones would be worked backwards again — with sample titles per class, so the
 * rules can be checked against real work.
 *
 *   pnpm exec tsx scripts/work-split-dry-run.ts C:\path\to\copy-of-crossline.db [workspaceId] [--samples=10]
 *
 * The file given is copied to a temporary file first and only the copy is opened (opening a database runs its migrations); the live
 * ledger is refused outright. Calls no model, writes nothing anywhere else.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "../packages/db/src/index";
import { planWorkSplit } from "../apps/worker/src/work-split-repair";

const repoRoot = path.resolve(import.meta.dirname, "..");
const liveDatabase = path.join(path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data")), "crossline.db");
const fail = (code: string, message: string): never => {
  console.error(JSON.stringify({ status: "blocked", code, message }));
  process.exit(1);
};

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const samples = Number(args.find((arg) => arg.startsWith("--samples="))?.slice("--samples=".length) ?? 10);
const [target, only] = args.filter((arg) => !arg.startsWith("--"));
if (!target) fail("WORK_SPLIT_DB_REQUIRED", "用法：pnpm exec tsx scripts/work-split-dry-run.ts <账本副本.db> [workspaceId]");
const resolved = path.resolve(target!);
if (path.normalize(resolved).toLowerCase() === path.normalize(liveDatabase).toLowerCase())
  fail("WORK_SPLIT_TARGET_IS_LIVE_LEDGER", "这是正在使用的账本；请先复制到别处，再对副本运行。");
if (!existsSync(resolved)) fail("WORK_SPLIT_DB_NOT_FOUND", `找不到数据库：${resolved}`);

// The given file is never opened: a copy of it (with its -wal, when there is one) is.
const dir = mkdtempSync(path.join(tmpdir(), "work-split-"));
const copy = path.join(dir, "ledger.db");
copyFileSync(resolved, copy);
for (const suffix of ["-wal", "-shm"]) if (existsSync(`${resolved}${suffix}`)) copyFileSync(`${resolved}${suffix}`, `${copy}${suffix}`);

const store = new CrosslineStore(copy);
try {
  for (const workspace of store.listWorkspaces().filter((item) => !only || item.id === only)) {
    const plan = planWorkSplit(store, workspace.id);
    const assistant = plan.moves.filter((move) => move.owner === "assistant");
    const ask = plan.moves.filter((move) => move.owner === "ask");
    console.info(`# ${workspace.name}（${workspace.id}）`);
    const stepChanges = plan.steps.reduce((sum, split) => sum + split.changes.length, 0);
    console.info(`转给助手 ${assistant.length} · 改为问题 ${ask.length} · 留给本人 ${plan.person.length} · 整体不动 ${plan.untouched.length}`
      + ` · 步骤重新分工 ${stepChanges}（${plan.steps.length} 个任务） · 资料就绪类里程碑 ${plan.prepOnly.length} · 重新倒推 ${plan.backplan.length}`);
    const count = (codes: string[]) => Object.entries(codes.reduce<Record<string, number>>((acc, code) => ({ ...acc, [code]: (acc[code] ?? 0) + 1 }), {}))
      .map(([code, n]) => `${code} ${n}`).join("，");
    console.info(`  助手的依据：${count(assistant.map((move) => move.code))}`);
    console.info(`  本人的依据：${count(plan.person.map((item) => item.code))}`);
    const linked = assistant.filter((move) => move.prepares).length + ask.filter((move) => move.prepares).length;
    console.info(`  指向本人核心任务的：${linked}/${plan.moves.length}`);
    const titleOf = new Map([...plan.person.map((item) => [item.order.id, item.title] as const)]);
    console.info("\n## 转给助手");
    for (const move of assistant.slice(0, samples)) console.info(`- ${move.title}  [${move.code}]${move.prepares ? ` → 为「${titleOf.get(move.prepares) ?? move.prepares}」` : ""}`);
    console.info("\n## 改为问题");
    for (const move of ask.slice(0, samples)) console.info(`- ${move.title}  [${move.code}]  问：${move.question}`);
    console.info("\n## 留给本人");
    for (const item of plan.person.slice(0, samples)) console.info(`- ${item.title}  [${item.code}]`);
    console.info("\n## 整体不动（正在进行、本人计过时或本人做过其中的步骤；其开着的步骤仍可能重新分工）");
    for (const item of plan.untouched.slice(0, samples)) console.info(`- ${item.title}  （${item.why}）`);
    console.info("\n## 步骤重新分工（任务 · 步骤 · 原 executor → 新）");
    for (const split of plan.steps) for (const change of split.changes)
      console.info(`- ${split.title} · ${change.title} · ${change.from} → ${change.to === "folded" ? `并入「${change.into ?? "下一个本人步骤"}」开始时的一眼` : change.to}`);
    const asked = plan.steps.flatMap((split) => split.questions.filter((question) => !split.plan.questions.some((old) => old.text === question.text))
      .map((question) => `${split.title}：${question.text}`));
    if (asked.length) { console.info("  新增的问题："); for (const line of asked) console.info(`  - ${line}`); }
    console.info("\n## 资料就绪类里程碑");
    for (const item of plan.prepOnly) console.info(`- ${item.title}${item.next ? `  → 下一个有本人产出的：「${item.next.title}」` : "  → 同线同项目没有有本人产出的里程碑，建议改标准"}`);
    console.info("\n## 重新倒推");
    for (const item of plan.backplan) console.info(`- ${item.title}（${item.why}）`);
    console.info("");
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
