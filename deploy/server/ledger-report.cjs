// Read-only report from a copy of the ledger, piped into `node -` inside the web image by server.yml's [usage] step.
// The interview's extraction outcomes and failures of the last six hours, per workspace, so a run that succeeds and writes nothing is seen.
const Database = require("better-sqlite3");
const db = new Database("/tmp/copy/crossline.db", { readonly: true });
const since = new Date(Date.now() - 6 * 3600000).toISOString();
const types = ["onboarding.extracted", "onboarding.extract_failed", "onboarding.citation_warned", "onboarding.questions_repeated"];
const rows = db.prepare(`SELECT workspace_id, type, created_at, payload_json FROM events WHERE type IN (${types.map(() => "?").join(",")}) AND created_at >= ? ORDER BY created_at`).all(...types, since);
for (const row of rows) console.log([row.created_at.slice(5, 19), row.workspace_id.slice(0, 8), row.type, String(row.payload_json).slice(0, 600)].join("  "));
for (const row of db.prepare("SELECT workspace_id, key, value FROM settings WHERE key LIKE 'onboarding.extract%' OR key = 'profile.sections'").all())
  console.log(["setting", row.workspace_id.slice(0, 8), row.key, String(row.value).slice(0, 800)].join("  "));

// The assistant's runs of the last six hours, with what each did: its own summary, files, and every function it called (tools mode),
// read from the run's audit.json (the ledger keeps the path; the data directory is mounted at /live here).
const fs = require("fs");
for (const row of db.prepare("SELECT workspace_id, type, created_at, payload_json FROM events WHERE type LIKE 'agent.task.%' AND created_at >= ? ORDER BY created_at").all(since)) {
  const payload = JSON.parse(row.payload_json);
  console.log([row.created_at.slice(5, 19), row.workspace_id.slice(0, 8), row.type, payload.taskId ?? "", payload.mode ?? "", payload.code ?? "",
    String(payload.summary ?? payload.message ?? payload.title ?? "").slice(0, 200)].join("  "));
  if (!payload.auditFile) continue;
  const file = String(payload.auditFile).replace(/^.*?\/ai-output\//, "/live/ai-output/");
  try {
    const audit = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log("   audit:", JSON.stringify({ artifacts: audit.artifacts, toolCalls: (audit.toolCalls ?? []).map((call) => `${call.tool}:${call.ok === false ? "fail" : "ok"}`),
      repairs: audit.audit?.repairs, turns: audit.audit?.turns, needsHuman: audit.needsHuman }).slice(0, 1500));
  } catch (error) { console.log("   audit unreadable:", file, String(error.message).slice(0, 120)); }
}

// The first milestone drafts: where each line's architect run is (`milestones.drafting`) and the drafts' own events.
for (const row of db.prepare("SELECT workspace_id, key, value FROM settings WHERE key IN ('milestones.drafting', 'flywheel.artifacts') OR key LIKE 'firstDrafts%' OR key LIKE 'milestones.first%'").all())
  console.log(["setting", row.workspace_id.slice(0, 8), row.key, String(row.value).slice(0, 600)].join("  "));
for (const row of db.prepare("SELECT workspace_id, type, created_at, payload_json FROM events WHERE (type LIKE 'milestone%' OR type LIKE 'artifact%' OR type LIKE 'first_drafts%') AND created_at >= ? ORDER BY created_at").all(since))
  console.log([row.created_at.slice(5, 19), row.workspace_id.slice(0, 8), row.type, String(row.payload_json).slice(0, 300)].join("  "));

// Tasks and their step plans: what the backplanner wrote and whether the step planner has reached them.
for (const row of db.prepare("SELECT workspace_id, type, created_at, payload_json FROM events WHERE (type LIKE 'goal.backplan%' OR type LIKE 'task.steps%' OR type LIKE 'step_plan%' OR type LIKE 'backplan%') AND created_at >= ? ORDER BY created_at").all(since))
  console.log([row.created_at.slice(5, 19), row.workspace_id.slice(0, 8), row.type, String(row.payload_json).slice(0, 240)].join("  "));
try {
  for (const row of db.prepare("SELECT workspace_id, COUNT(*) AS n FROM task_step_plans GROUP BY workspace_id").all()) console.log(["step plans", row.workspace_id.slice(0, 8), row.n].join("  "));
} catch (error) { console.log("step plans unreadable", String(error.message).slice(0, 120)); }

// Mail: each sorting pass, the captures it wrote (title and state only; the context holds the sender and subject) and what became of them.
for (const row of db.prepare("SELECT workspace_id, type, created_at, payload_json FROM events WHERE type IN ('mail.triaged', 'waiting.mail_seen') AND created_at >= ? ORDER BY created_at").all(since))
  console.log([row.created_at.slice(5, 19), row.workspace_id.slice(0, 8), row.type, String(row.payload_json).slice(0, 200)].join("  "));
for (const row of db.prepare("SELECT id, workspace_id, title, state, audit_json FROM captures WHERE id LIKE 'cap-mail-%'").all()) {
  const audit = (() => { try { return JSON.parse(row.audit_json); } catch { return {}; } })();
  const order = db.prepare("SELECT id, state FROM work_orders WHERE workspace_id = ? AND (id = ? OR payload_json LIKE ?)").get(row.workspace_id, row.id, `%${row.id}%`);
  console.log(["mail capture", row.workspace_id.slice(0, 8), row.id, row.state, row.title.slice(0, 80), audit.blocker?.code ?? "", order ? `order ${order.id} ${order.state}` : "no order"].join("  "));
}
