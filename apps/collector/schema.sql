-- The owner's collector for installed copies (docs/local-installer.md, 接收端). Applied by
--   pnpm dlx wrangler d1 execute crossline-collector --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS installs (
  install TEXT PRIMARY KEY,
  account TEXT,
  version TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_requests INTEGER NOT NULL DEFAULT 0,
  snapshot_day TEXT NOT NULL DEFAULT '',
  snapshot_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install TEXT NOT NULL,
  received_at TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  version TEXT NOT NULL,
  page TEXT, stage TEXT, skill TEXT, code TEXT, entity TEXT,
  ms INTEGER, repairs INTEGER, stalls INTEGER, ok INTEGER,
  input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
  counts_json TEXT
);
CREATE INDEX IF NOT EXISTS events_install_at ON events(install, at);
CREATE INDEX IF NOT EXISTS events_type_at ON events(type, at);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  install TEXT NOT NULL,
  account TEXT,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  feedback TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_install ON snapshots(install, received_at);
