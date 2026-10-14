import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dataDir } from "./config";

/**
 * The public test's own SQLite file (`<dataDir>/assess.db`), never the private app's ledger. WAL, so the hourly purge and the online
 * backup (docs/assess-deploy.md) never block a reader. Schema changes are numbered migrations gated on `PRAGMA user_version`, each run
 * whole inside one transaction together with the version it writes, so a crash can never leave the file half-migrated.
 */

type Migration = (db: Database.Database) => void;

const MIGRATIONS: Migration[] = [
  // 1: results and the pairs made through their invitations. Answers are never stored: the four scores are all a view needs.
  (db) => db.exec(`
    CREATE TABLE results (
      id TEXT PRIMARY KEY,
      result_token TEXT NOT NULL UNIQUE,
      invite_token TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      nickname TEXT NOT NULL,
      scores_json TEXT NOT NULL,
      code TEXT NOT NULL,
      appearance_json TEXT NOT NULL,
      send_email INTEGER NOT NULL,
      avatar_state TEXT NOT NULL DEFAULT 'queued',
      avatar_file TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX results_email ON results(email);
    CREATE INDEX results_expires_at ON results(expires_at);
    CREATE TABLE pairs (
      id TEXT PRIMARY KEY,
      pair_token TEXT NOT NULL UNIQUE,
      inviter_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
      invitee_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX pairs_inviter ON pairs(inviter_id);
    CREATE INDEX pairs_invitee ON pairs(invitee_id);
  `),
  // 2: figures drawn, keyed by a keyed hash of the address, so deleting and retaking does not reset the per-address limit. Holds no
  // address and no result content; rows go after the retention period.
  (db) => db.exec(`
    CREATE TABLE avatar_draws (
      result_id TEXT PRIMARY KEY,
      email_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX avatar_draws_email ON avatar_draws(email_key);
  `)
];

let open: { file: string; db: Database.Database } | undefined;

export const dbFile = (): string => path.join(dataDir(), "assess.db");

/** The open database, opened (and migrated) on first use; reopened when `ASSESS_DATA_DIR` changes, which only tests do. */
export function db(): Database.Database {
  const file = dbFile();
  if (open?.file === file) return open.db;
  closeDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.pragma("journal_mode = WAL");
  handle.pragma("synchronous = NORMAL");
  handle.pragma("foreign_keys = ON");
  migrate(handle);
  open = { file, db: handle };
  return handle;
}

export function closeDb(): void {
  open?.db.close();
  open = undefined;
}

function migrate(handle: Database.Database): void {
  const current = handle.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    handle.transaction(() => {
      MIGRATIONS[version]!(handle);
      handle.pragma(`user_version = ${version + 1}`);
    }).immediate();
  }
}
