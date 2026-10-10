/**
 * F5's acceptance replay (docs/flywheel-and-views.md §7): redesign **one line** with artifact-first planning against a **copy** of the
 * real ledger (the live database is only read, through SQLite's online backup; opening the copy runs migration 13 on the copy alone),
 * with the real Codex: the artifact plan for that line, then the line's milestones, then the cross-line relations derived from the
 * references. It prints the cross-line relations before and after, the artifact plan, and which relations survived — the claim under test
 * is that redoing a line no longer loses the links to the other lines.
 *
 *   pnpm exec tsx scripts/artifact-plan-replay.ts [lineId]
 *
 * Without a line id it takes the first line that has confirmed facts. Nothing reaches the live ledger. It spends real quota (two top-tier
 * runs, more with repairs); never run as a side effect.
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-artifact-replay-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";

const { CrosslineStore, readStoredArtifactPlan } = await import("../packages/db/src/index");
const { setUsageSink, startCodexSupervisor } = await import("../packages/codex/src/index");
const { createMilestoneProposer, MILESTONE_ARCHITECT_SKILL, ARTIFACT_PLANNER_SKILL } = await import("../apps/worker/src/milestone-proposer");
const { identityLines } = await import("../apps/worker/src/lines");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));

const workspace = store.listWorkspaces().find((item) => store.listMilestones(item.id).length > 0) ?? store.listWorkspaces()[0]!;
const labels = new Map(identityLines(store, workspace.id).map((pack) => [pack.id, pack.label]));
const facts = store.listProfileFacts(workspace.id);
const line = process.argv[2] ?? identityLines(store, workspace.id).map((pack) => pack.id)
  .find((id) => facts.some((fact) => fact.identityId === id && fact.status === "confirmed"));
if (!line) { console.error("没有可重算的主线（没有已确认的事实）。"); process.exit(1); }

/** Every live cross-line relation, readable: both ends with their line, status, and what it carries. */
function relations() {
  const milestones = new Map(store.listMilestones(workspace.id).map((milestone) => [milestone.id, milestone]));
  return store.listMilestoneRelations(workspace.id).flatMap((relation) => {
    const from = milestones.get(relation.fromMilestoneId), to = milestones.get(relation.toMilestoneId);
    if (!from || !to || from.status === "archived" || to.status === "archived") return [];
    return [{ id: relation.id, status: relation.status, kind: relation.kind,
      from: `${labels.get(from.identityId) ?? from.identityId} · ${from.title}`, to: `${labels.get(to.identityId) ?? to.identityId} · ${to.title}`,
      touchesLine: from.identityId === line || to.identityId === line,
      ...(relation.artifactId ? { artifact: relation.artifactId, transfer: relation.transfer, checkOn: relation.checkOn, counterfactual: relation.counterfactual } : {}) }];
  });
}
const print = (title: string, rows: ReturnType<typeof relations>) => {
  console.info(`\n== ${title}：${rows.length} 条（其中 ${rows.filter((row) => row.status === "approved").length} 条已批准，${rows.filter((row) => row.artifact).length} 条带产物）`);
  for (const row of rows) console.info(JSON.stringify(row));
};

const before = relations();
print(`重算「${labels.get(line) ?? line}」之前的跨主线关系`, before);

const durations: Array<{ skill: string; seconds: number; repairs: number; ok: boolean }> = [];
setUsageSink((usage) => { durations.push({ skill: usage.skillName, seconds: Math.round(usage.durationMs / 1000), repairs: usage.repairs, ok: usage.ok }); });
const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3397),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: [MILESTONE_ARCHITECT_SKILL, ARTIFACT_PLANNER_SKILL] }
});

const started = Date.now();
const outcome = await createMilestoneProposer(store, workspace.id, repoRoot, () => supervisor.client)("", undefined, [line]);
console.info(`\n== 结果（${Math.round((Date.now() - started) / 1000)} 秒）`);
console.info(JSON.stringify(outcome.state === "proposed"
  ? { state: outcome.state, drafts: outcome.drafts.map((draft) => draft.title), skipped: outcome.skipped ?? [], assumptions: outcome.assumptions,
    derived: outcome.relations?.derived.length ?? 0, refused: outcome.relations?.refused ?? [] }
  : outcome, null, 1));
console.info(JSON.stringify({ runs: durations }));

const plan = readStoredArtifactPlan(store, workspace.id);
console.info(`\n== 产物计划：${plan.artifacts.length} 个产物，${plan.supplies.length} 条供需对`);
for (const artifact of plan.artifacts) console.info(JSON.stringify(artifact));
for (const pair of plan.supplies) console.info(JSON.stringify(pair));

const after = relations();
print(`重算之后的跨主线关系`, after);
// What the redesign was supposed to keep: every relation that did not touch the redone line, and every approved one.
const afterIds = new Set(after.map((row) => row.id));
const lost = before.filter((row) => (!row.touchesLine || row.status === "approved") && !afterIds.has(row.id));
console.info(`\n== 不涉及该主线或已批准的关系中丢失的：${lost.length} 条`);
for (const row of lost) console.info(JSON.stringify(row));
console.info(JSON.stringify({ line, before: before.length, after: after.length, lost: lost.length, dataDir }));
await supervisor.stop();
store.close();
process.exit(0);
