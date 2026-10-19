/**
 * Reads the live ledger and reports anything structurally wrong with it.
 *
 *   pnpm exec tsx scripts/doctor.ts            # the live ledger
 *   pnpm exec tsx scripts/doctor.ts path.db    # some other file, e.g. a restored backup
 *
 * This is what stands in for foreign keys. SQLite cannot add one to an existing table without
 * rebuilding it, and the relationship that matters most — `work_orders.milestone_id` — cannot have one
 * at all, because `milestones` is keyed `(id, version)` so a single id is not a unique target. Four
 * table rebuilds to constrain the easy half, while the important half stayed unconstrained, is a poor
 * trade against the app being the only writer. Detection is the honest alternative: it cannot prevent
 * an orphan, but it will not let one sit unnoticed either.
 *
 * Exits non-zero when it finds something, so it can gate a release without anyone reading the output.
 */
// Relative import, not @crossline/db: the repo root is not a workspace package, so it has no such deps.
import Database from "better-sqlite3";
import { statSync } from "node:fs";
import path from "node:path";

const file = process.argv[2] ?? path.resolve(process.cwd(), "data", "crossline.db");
const db = new Database(file, { readonly: true });
const findings: string[] = [];

/** Rows whose reference points at nothing. */
const orphans = (label: string, sql: string): void => {
  const rows = db.prepare(sql).all() as Array<{ id: string; target: string }>;
  for (const row of rows) findings.push(`${label}: ${row.id} → 找不到 ${row.target}`);
};

// An empty milestone_id is a deliberate, valid state — manual creation lets a routine work order skip
// binding to any milestone at all (`evidenceRequiredFor` treats it the same way: `Boolean("")` is
// false). Flagging it here read as "找不到 " with a blank target, a false positive this walkthrough's
// first-ever unbound manual work order actually tripped.
orphans("work_order 指向不存在的里程碑",
  `SELECT w.id AS id, w.milestone_id AS target FROM work_orders w
   WHERE w.milestone_id != ''
     AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.id = w.milestone_id AND m.workspace_id = w.workspace_id)`);
orphans("execution 指向不存在的作业",
  `SELECT e.id AS id, e.work_order_id AS target FROM executions e
   WHERE NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = e.work_order_id AND w.workspace_id = e.workspace_id)`);
orphans("evidence 指向不存在的作业",
  `SELECT c.id AS id, c.work_order_id AS target FROM evidence_claims c
   WHERE NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = c.work_order_id AND w.workspace_id = c.workspace_id)`);
orphans("等待项指向不存在的作业",
  `SELECT i.id AS id, b.value AS target FROM waiting_items i, json_each(i.blocks_json) b
   WHERE NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = b.value AND w.workspace_id = i.workspace_id)`);
orphans("material 指向不存在的作业",
  `SELECT m.id AS id, m.work_order_id AS target FROM materials m
   WHERE NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = m.work_order_id AND w.workspace_id = m.workspace_id)`);
orphans("关系指向不存在的里程碑",
  `SELECT r.id AS id, r.to_milestone_id AS target FROM milestone_relations r
   WHERE NOT EXISTS (SELECT 1 FROM milestones m WHERE m.id = r.to_milestone_id AND m.workspace_id = r.workspace_id)`);

// A capture and the work order it was promoted into share an id. A promoted capture with no work
// order means the promotion half-happened.
orphans("已上板的捕获没有对应作业",
  `SELECT c.id AS id, c.id AS target FROM captures c WHERE c.state = 'promoted'
   AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = c.id AND w.workspace_id = c.workspace_id)`);

// A database stopped between two steps of the old probe-based migration would sit here forever with
// nothing to notice it. The migration runner replaced that, but an old file can still arrive.
const columns = (table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
const expected: Array<[string, string]> = [
  ["milestones", "success_criteria_json"], ["milestones", "verifiability"], ["milestones", "project_id"],
  ["captures", "attempt"], ["work_orders", "recurrence_json"], ["work_orders", "tombstone_json"],
  ["milestone_relations", "explanation"], ["milestone_relations", "refuted_when"], ["milestone_relations", "evidence_json"],
  // Migration 13 (artifact-first planning): only once the file says it ran; a file still at 12 is not yet migrated, not half-migrated.
  ...(Number(db.pragma("user_version", { simple: true })) >= 13 ? [["milestone_anchors", "outputs_json"], ["milestone_anchors", "inputs_json"],
    ["milestone_relations", "artifact_id"], ["milestone_relations", "transfer_json"], ["milestone_relations", "check_on"],
    ["milestone_relations", "counterfactual"]] as Array<[string, string]> : [])
];
for (const [table, column] of expected) {
  if (!columns(table).includes(column)) findings.push(`schema 不完整：${table} 缺少 ${column}（半迁移）`);
}
const retired = ["outbox", "identities", "projects", "milestone_versions", "insight_proposals", "skill_versions"];
const present = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
  .map((row) => row.name);
for (const table of retired.filter((name) => present.includes(name))) {
  findings.push(`schema 陈旧：${table} 本应在迁移 4 删除`);
}

// Numbered evidence (migration 16): a fact pointing at a sentence that is not there, or a sentence whose reply or file is gone. Removing
// a file deletes its sentences and unhooks the facts, so either is a half-applied change, not normal use.
if (Number(db.pragma("user_version", { simple: true })) >= 16) {
  for (const [table, column] of [["profile_facts", "source_sentences"], ["source_documents", "ref_no"]] as const)
    if (!columns(table).includes(column)) findings.push(`schema 不完整：${table} 缺少 ${column}（半迁移）`);
  if (!present.includes("evidence_sentences")) findings.push("schema 不完整：缺少 evidence_sentences（半迁移）");
  else {
    const dangling = (db.prepare(`SELECT f.slot AS slot, s.value AS id FROM profile_facts f, json_each(f.source_sentences) s
      WHERE NOT EXISTS (SELECT 1 FROM evidence_sentences e WHERE e.workspace_id = f.workspace_id AND e.id = s.value)`).all() as Array<{ slot: string; id: number }>);
    for (const row of dangling) findings.push(`事实指向不存在的句子：${row.slot} → [${row.id}]`);
    orphans("句子的文件已不存在",
      `SELECT DISTINCT e.source_id AS id, e.source_id AS target FROM evidence_sentences e WHERE e.source_kind = 'document' AND e.retired = 0
       AND NOT EXISTS (SELECT 1 FROM source_documents d WHERE d.workspace_id = e.workspace_id AND d.id = e.source_id)`);
    orphans("句子的回复已不存在",
      `SELECT DISTINCT e.source_id AS id, e.source_id AS target FROM evidence_sentences e WHERE e.source_kind = 'reply'
       AND NOT EXISTS (SELECT 1 FROM onboarding_messages m WHERE m.workspace_id = e.workspace_id
         AND m.session_id || '#' || m.seq = e.source_id AND m.role = 'user')`);
    const numbers = db.prepare(`SELECT workspace_id AS ws, ref_no AS n, COUNT(*) AS c FROM source_documents WHERE ref_no IS NOT NULL
      GROUP BY workspace_id, ref_no HAVING COUNT(*) > 1`).all() as Array<{ ws: string; n: number }>;
    for (const row of numbers) findings.push(`文件编号重复：src-${row.n}（${row.ws}）`);
    const unnumbered = (db.prepare("SELECT COUNT(*) AS c FROM source_documents WHERE ref_no IS NULL").get() as { c: number }).c;
    if (unnumbered) findings.push(`${unnumbered} 个文件没有固定编号（迁移 16 未回填）`);
  }
}

const version = Number(db.pragma("user_version", { simple: true }));
const wal = (() => { try { return statSync(`${file}-wal`).size; } catch { return 0; } })();
const counts = Object.fromEntries(["events", "work_orders", "captures", "milestones", "materials"]
  .map((table) => [table, (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c]));
db.close();

console.log(JSON.stringify({ file, schemaVersion: version, walBytes: wal, counts, findings }, null, 2));
if (findings.length) {
  console.error(`\n${findings.length} 项需要处理。`);
  process.exit(1);
}
console.log("\n未发现问题。");
