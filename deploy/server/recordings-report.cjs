// Read-only report on 录音在服务器转写, run by server.yml's diagnose against a copy of the ledger (stdin to `node -`): the last
// recording events per workspace and, for each transcript, how many lines it has and how many name a speaker. No transcript text,
// no file names — counts only.
const Database = require("better-sqlite3");
const db = new Database("/tmp/copy/crossline.db", { readonly: true });
const since = new Date(Date.now() - 3 * 86400000).toISOString();
const events = db.prepare("SELECT workspace_id, type, created_at, payload_json FROM events WHERE type LIKE 'recording.%' AND created_at >= ? ORDER BY created_at").all(since);
if (!events.length) console.log("no recording events in 3 days");
const doc = db.prepare("SELECT extracted_text FROM source_documents WHERE workspace_id = ? AND id = ?");
for (const e of events) {
  const p = JSON.parse(e.payload_json || "{}");
  const row = [e.created_at.slice(5, 19), e.workspace_id.slice(0, 8), e.type];
  if (p.seconds !== undefined) row.push(`audio=${p.seconds}s`, `speech=${p.speechSeconds}s`, `work=${Math.round((p.workMs || 0) / 1000)}s`);
  if (p.where || p.engine) row.push(`${p.where || ""}/${p.engine || ""}`);
  if (p.message) row.push(`message=${String(p.message).slice(0, 120)}`);
  if (p.documentId) {
    const text = (doc.get(e.workspace_id, p.documentId) || {}).extracted_text || "";
    const lines = text.split("\n").filter((line) => /^\[\d/.test(line));
    const labels = new Set(lines.map((line) => (/^\[[^\]]+\]\s*(本人|说话人 \d+)：/.exec(line) || [])[1]).filter(Boolean));
    row.push(`lines=${lines.length}`, `labelled=${lines.filter((line) => /^\[[^\]]+\]\s*(本人|说话人 \d+)：/.test(line)).length}`, `speakers=${[...labels].sort().join(",") || "none"}`);
  }
  console.log(row.join("  "));
}
