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
