import Database from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";
import { migratedTags } from "@crossline/core";
import { condenseEventTypes } from "./event-condense";
import { RETIRED_TABLES } from "./schema";

/** What the migrations need from the store: its connection and the few helpers a step shares with a restore or a read. */
export type MigrationLedger = {
  db: Database.Database;
  prepare(sql: string): Database.Statement;
  hasTable(name: string): boolean;
  columnIsNotNull(table: string, column: string): boolean;
  archivePlanChangeRows(query: string, params?: unknown[]): void;
  collapsePlanVersions(workspaceId?: string): void;
  numberDocuments(workspaceId?: string): void;
  indexDocuments(workspaceId?: string): void;
  adoptLegacyWorkflowSettings(): void;
};

/**
 * Applies every migration the database has not seen, in order, one transaction each.
 *
 * What this replaces was a run of `PRAGMA table_info` probes, and it was broken in a way that could
 * not be noticed: several probed for one column and then added two. Die between the two `exec`
 * calls and the guard column exists while the second does not, so the condition is false forever —
 * a permanently half-migrated database with nothing to detect it. `user_version` was written
 * unconditionally at the end and gated nothing.
 *
 * That was survivable while one person had one database. It is not survivable once anyone else runs
 * this, because a schema change then executes against databases nobody can inspect — which is the
 * real thing standing between this and being shippable, far more than any query or index.
 *
 * Rules: append only, never edit a shipped step, and keep each one idempotent anyway so a
 * half-applied step from the old regime can still be stepped over.
 */
export function runMigrations(ledger: MigrationLedger, path: string): void {
  const has = (table: string, column: string) =>
    (ledger.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);

  const migrations: Array<{ version: number; up: () => void }> = [
    // Everything through v2 is what the probe-based code used to do, restated as ordered steps. A
    // database that already ran the probes lands here at user_version 2 and skips all of it.
    { version: 3, up: () => {
      if (!has("milestones", "project_id")) ledger.db.exec("ALTER TABLE milestones ADD COLUMN project_id TEXT");
      if (!has("captures", "attempt")) ledger.db.exec("ALTER TABLE captures ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
      // Existing milestones predate success criteria. They are marked `unstated` rather than given
      // invented criteria — the gate refuses them until a human writes what would count.
      if (!has("milestones", "success_criteria_json")) ledger.db.exec("ALTER TABLE milestones ADD COLUMN success_criteria_json TEXT NOT NULL DEFAULT '[]'");
      if (!has("milestones", "verifiability")) ledger.db.exec("ALTER TABLE milestones ADD COLUMN verifiability TEXT NOT NULL DEFAULT 'unstated'");
      if (!has("work_orders", "recurrence_json")) ledger.db.exec("ALTER TABLE work_orders ADD COLUMN recurrence_json TEXT");
      if (!has("work_orders", "tombstone_json")) ledger.db.exec("ALTER TABLE work_orders ADD COLUMN tombstone_json TEXT");
      // SQLite cannot widen a CHECK in place, so the relation table is rebuilt once to admit
      // `refuted` and to carry the evidence a relation needs before it may influence anything.
      if (!has("milestone_relations", "evidence_json")) {
        ledger.db.exec(`
          CREATE TABLE milestone_relations_v2 (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
            status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived','refuted')),
            evidence_json TEXT NOT NULL DEFAULT '[]',
            counterexample_json TEXT NOT NULL DEFAULT '[]',
            cost_minutes REAL,
            last_validated_at TEXT,
            updated_at TEXT NOT NULL
          );
          INSERT INTO milestone_relations_v2
            (id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at)
            SELECT id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at
            FROM milestone_relations;
          DROP TABLE milestone_relations;
          ALTER TABLE milestone_relations_v2 RENAME TO milestone_relations;
        `);
      }
      // A relation used to be two milestone ids and a kind — an arrow with no stated claim, which
      // nobody can review and nothing can refute. `explanation` is what it asserts, `refuted_when`
      // is what would show it wrong. Existing rows keep NULL rather than an invented reason.
      if (!has("milestone_relations", "explanation")) ledger.db.exec("ALTER TABLE milestone_relations ADD COLUMN explanation TEXT");
      if (!has("milestone_relations", "refuted_when")) ledger.db.exec("ALTER TABLE milestone_relations ADD COLUMN refuted_when TEXT");
    } },

    // Six tables nothing has ever written, and one column nothing has ever read. They were carried
    // into every backup, every snapshot and every restore drill, and reading the schema suggested
    // capabilities that do not exist. `expires_at` is left over from the energy expiry model that
    // was deliberately removed.
    { version: 4, up: () => {
      for (const table of RETIRED_TABLES) {
        const rows = ledger.hasTable(table)
          ? (ledger.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
          : 0;
        // Never drop data. These are empty everywhere they have been looked at, but a row here would
        // mean the assumption was wrong, and finding that out by deleting it is not acceptable.
        if (rows > 0) throw new Error("MIGRATION_RETIRED_TABLE_NOT_EMPTY");
        ledger.db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      if (has("energy_observations", "expires_at")) ledger.db.exec("ALTER TABLE energy_observations DROP COLUMN expires_at");

      // Every table's only index was the implicit one on its PRIMARY KEY, so each `WHERE
      // workspace_id = ?` was a full scan — fine at 146 events, not fine after a year of daily use,
      // and nothing here ever deletes a row.
      ledger.db.exec(`
        CREATE INDEX IF NOT EXISTS events_workspace_type ON events(workspace_id, type);
        CREATE INDEX IF NOT EXISTS events_workspace_entity ON events(workspace_id, entity_id);
        CREATE INDEX IF NOT EXISTS work_orders_workspace_state ON work_orders(workspace_id, state);
        CREATE INDEX IF NOT EXISTS captures_workspace_state ON captures(workspace_id, state);
        CREATE INDEX IF NOT EXISTS executions_workspace_order ON executions(workspace_id, work_order_id);
        CREATE INDEX IF NOT EXISTS evidence_workspace_order ON evidence_claims(workspace_id, work_order_id);
        CREATE INDEX IF NOT EXISTS materials_workspace_order ON materials(workspace_id, work_order_id);
        CREATE INDEX IF NOT EXISTS milestones_workspace ON milestones(workspace_id, id);
      `);
      // Since migration 14 a new database has no `plan_changes`; only an old one gets its index here.
      if (ledger.hasTable("plan_changes")) ledger.db.exec("CREATE INDEX IF NOT EXISTS plan_changes_version ON plan_changes(plan_version_id)");
    } },

    // Migration 4 dropped the six tables and the base DDL created them straight back on the next
    // open, so the live ledger sat at version 4 with every one of them present. Found by
    // `pnpm doctor:ledger` on the real database, not by a test — the round-trip tests all compare
    // against `tableNames()`, which agreed with itself either way. The DDL no longer creates them;
    // this drops them once more for a database that already recorded version 4.
    { version: 5, up: () => {
      for (const table of RETIRED_TABLES) {
        if (!ledger.hasTable(table)) continue;
        const rows = (ledger.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
        if (rows > 0) throw new Error("MIGRATION_RETIRED_TABLE_NOT_EMPTY");
        ledger.db.exec(`DROP TABLE ${table}`);
      }
    } },

    // `node_key TEXT NOT NULL` was written against a guess about what `tailscale serve` forwards to a
    // proxied backend. Verified against Tailscale's own docs before wiring up stage six's "trust this
    // Tailscale identity" binding: Serve forwards exactly three identity headers on tailnet traffic —
    // `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic` — and no node
    // identifier at all. A column the app can never honestly populate is worse than one that admits it
    // does not have the value; this table has never been written to (`tailscale_bindings` is on the
    // retired-table-emptiness check list precisely because nothing has used it yet), so the rebuild
    // carries zero rows and the uniqueness constraint narrows to `(workspace_id, tailscale_login)` —
    // one binding per Tailscale account per workspace, since there is no node id left to distinguish by.
    { version: 6, up: () => {
      if (!has("tailscale_bindings", "node_key") || ledger.columnIsNotNull("tailscale_bindings", "node_key")) {
        const rows = (ledger.prepare("SELECT COUNT(*) AS count FROM tailscale_bindings").get() as { count: number }).count;
        if (rows > 0) throw new Error("MIGRATION_TAILSCALE_BINDINGS_NOT_EMPTY");
        ledger.db.exec(`
          DROP TABLE tailscale_bindings;
          CREATE TABLE tailscale_bindings (
            id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            tailscale_login TEXT NOT NULL, node_key TEXT, created_at TEXT NOT NULL,
            UNIQUE(workspace_id, tailscale_login)
          );
        `);
      }
    } },

    // `ensureSeeded()` (apps/web/lib/crossline.ts) seeds these four tables with fixed literal ids
    // ("personal-plan-v1", "research-starter", "research-startup", "research-starter-work-order") —
    // the same id for every workspace, on purpose, so re-seeding an already-seeded workspace is a
    // no-op. That only works if the id is scoped to the workspace: none of these four primary/unique
    // keys included `workspace_id`, so the ledger's *first* workspace to ever use one of these ids
    // owns it forever, and `ON CONFLICT DO UPDATE` (deliberately, elsewhere, to stop a write from
    // reassigning ownership) never reassigns `workspace_id` either — every other workspace's seed
    // attempt silently rewrites the first workspace's row and still finds nothing under its own id.
    // Confirmed on the real ledger: a second real account's `milestones`/`milestone_relations`/
    // `plan_versions` all read back empty, and `/plan`/`/approvals` threw `PLAN_VERSION_NOT_FOUND`.
    // Real rows exist here, so — unlike v6's tailscale_bindings, which this otherwise mirrors — this
    // must copy forward rather than refuse on non-empty.
    { version: 7, up: () => {
      // Each table's extra columns arrived together in migration 3's ALTERs, so one representative
      // column's presence stands for all of them. A database can reach this migration without ever
      // having actually run migration 3's ALTERs — a hand-built fixture pinned straight to a later
      // `user_version` to test a *different* migration in isolation, same as `tailscale-binding.test.ts`
      // already does for migration 6 — so this cannot assume the columns are always there.
      const milestonesHasExtra = has("milestones", "project_id");
      ledger.db.exec(`
        CREATE TABLE milestones_v2 (
          id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          identity_id TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
          updated_at TEXT NOT NULL, project_id TEXT,
          success_criteria_json TEXT NOT NULL DEFAULT '[]', verifiability TEXT NOT NULL DEFAULT 'unstated',
          PRIMARY KEY(workspace_id, id, version)
        );
      `);
      ledger.db.exec(milestonesHasExtra
        ? `INSERT INTO milestones_v2 (id, owner_id, workspace_id, identity_id, title, version, status,
             updated_at, project_id, success_criteria_json, verifiability)
           SELECT id, owner_id, workspace_id, identity_id, title, version, status,
             updated_at, project_id, success_criteria_json, verifiability FROM milestones;`
        : `INSERT INTO milestones_v2 (id, owner_id, workspace_id, identity_id, title, version, status, updated_at)
           SELECT id, owner_id, workspace_id, identity_id, title, version, status, updated_at FROM milestones;`);
      ledger.db.exec("DROP TABLE milestones; ALTER TABLE milestones_v2 RENAME TO milestones;");

      ledger.db.exec(`
        CREATE TABLE plan_versions_v2 (
          id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          version INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id)
        );
        INSERT INTO plan_versions_v2 (id, owner_id, workspace_id, version, status, payload_json, created_at)
          SELECT id, owner_id, workspace_id, version, status, payload_json, created_at FROM plan_versions;
        DROP TABLE plan_versions;
        ALTER TABLE plan_versions_v2 RENAME TO plan_versions;
      `);

      const relationsHasExtra = has("milestone_relations", "evidence_json");
      const relationsHasExplanation = has("milestone_relations", "explanation");
      ledger.db.exec(`
        CREATE TABLE milestone_relations_v3 (
          id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
          status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived','refuted')),
          evidence_json TEXT NOT NULL DEFAULT '[]', counterexample_json TEXT NOT NULL DEFAULT '[]',
          cost_minutes REAL, last_validated_at TEXT, updated_at TEXT NOT NULL,
          explanation TEXT, refuted_when TEXT,
          PRIMARY KEY(workspace_id, id)
        );
      `);
      ledger.db.exec(relationsHasExtra
        ? `INSERT INTO milestone_relations_v3 (id, owner_id, workspace_id, from_milestone_id, to_milestone_id,
             kind, status, evidence_json, counterexample_json, cost_minutes, last_validated_at, updated_at
             ${relationsHasExplanation ? ", explanation, refuted_when" : ""})
           SELECT id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status,
             evidence_json, counterexample_json, cost_minutes, last_validated_at, updated_at
             ${relationsHasExplanation ? ", explanation, refuted_when" : ""} FROM milestone_relations;`
        : `INSERT INTO milestone_relations_v3 (id, owner_id, workspace_id, from_milestone_id, to_milestone_id,
             kind, status, updated_at)
           SELECT id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at
             FROM milestone_relations;`);
      ledger.db.exec("DROP TABLE milestone_relations; ALTER TABLE milestone_relations_v3 RENAME TO milestone_relations;");

      const workOrdersHasExtra = has("work_orders", "recurrence_json");
      ledger.db.exec(`
        CREATE TABLE work_orders_v2 (
          id TEXT NOT NULL, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          identity_id TEXT NOT NULL, project_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
          intent TEXT NOT NULL, state TEXT NOT NULL, risk_tier TEXT NOT NULL,
          estimate_json TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
          recurrence_json TEXT, tombstone_json TEXT,
          PRIMARY KEY(workspace_id, id)
        );
      `);
      ledger.db.exec(workOrdersHasExtra
        ? `INSERT INTO work_orders_v2 (id, owner_id, workspace_id, identity_id, project_id, milestone_id,
             intent, state, risk_tier, estimate_json, payload_json, updated_at, recurrence_json, tombstone_json)
           SELECT id, owner_id, workspace_id, identity_id, project_id, milestone_id,
             intent, state, risk_tier, estimate_json, payload_json, updated_at, recurrence_json, tombstone_json
             FROM work_orders;`
        : `INSERT INTO work_orders_v2 (id, owner_id, workspace_id, identity_id, project_id, milestone_id,
             intent, state, risk_tier, estimate_json, payload_json, updated_at)
           SELECT id, owner_id, workspace_id, identity_id, project_id, milestone_id,
             intent, state, risk_tier, estimate_json, payload_json, updated_at FROM work_orders;`);
      ledger.db.exec("DROP TABLE work_orders; ALTER TABLE work_orders_v2 RENAME TO work_orders;");
    } },

    // Plain nullable columns, not a rebuild: neither changes a CHECK constraint or the primary key,
    // so an in-place ALTER is enough (unlike migration 7's milestones_v2, which had to widen the key
    // itself). Both are absent, not defaulted, for every milestone written before templates existed —
    // `computeMilestoneConfidence` reads that absence as `"low"`, the same number that codebase today
    // reports for every milestone with no template to compare against.
    { version: 8, up: () => {
      if (!has("milestones", "template_id")) ledger.db.exec("ALTER TABLE milestones ADD COLUMN template_id TEXT");
      if (!has("milestones", "confidence")) ledger.db.exec("ALTER TABLE milestones ADD COLUMN confidence TEXT");
    } },

    // Another plain nullable column, same reasoning as migration 8. `checklistAnswers` (work block E's
    // completion-time questions) deliberately does NOT get a column of its own on `evidence_claims` —
    // it belongs to the submission as a whole, not to any one evidence item, so it lives in the
    // execution row's own `payload_json` next to `interruptions`/`durationObserved`, which already
    // holds per-completion data with no schema of its own.
    { version: 9, up: () => {
      if (!has("milestones", "evidence_question_bank_json")) {
        ledger.db.exec("ALTER TABLE milestones ADD COLUMN evidence_question_bank_json TEXT");
      }
    } },

    // What the calibration learns from is the model's own error, so each observation keeps the estimate the
    // analysis wrote (not only the identity pack's prior), where the minutes came from, and under which
    // analysis context version it was estimated. Old rows are backfilled from their work order, which still
    // holds the original estimate — they are not thrown away.
    { version: 10, up: () => {
      if (!has("duration_observations", "llm_p50_minutes")) ledger.db.exec("ALTER TABLE duration_observations ADD COLUMN llm_p50_minutes INTEGER");
      if (!has("duration_observations", "llm_p85_minutes")) ledger.db.exec("ALTER TABLE duration_observations ADD COLUMN llm_p85_minutes INTEGER");
      if (!has("duration_observations", "actual_source")) ledger.db.exec("ALTER TABLE duration_observations ADD COLUMN actual_source TEXT NOT NULL DEFAULT 'timer'");
      if (!has("duration_observations", "context_version")) ledger.db.exec("ALTER TABLE duration_observations ADD COLUMN context_version TEXT NOT NULL DEFAULT ''");
      if (!has("duration_observations", "censored")) ledger.db.exec("ALTER TABLE duration_observations ADD COLUMN censored INTEGER NOT NULL DEFAULT 0");
      ledger.db.exec(`
        UPDATE duration_observations SET
          llm_p50_minutes = (SELECT CAST(json_extract(w.estimate_json, '$.p50Minutes') AS INTEGER) FROM work_orders w
            WHERE w.id = duration_observations.work_order_id AND w.workspace_id = duration_observations.workspace_id
              AND json_extract(w.estimate_json, '$.source') = 'llm_prior'),
          llm_p85_minutes = (SELECT CAST(json_extract(w.estimate_json, '$.p85Minutes') AS INTEGER) FROM work_orders w
            WHERE w.id = duration_observations.work_order_id AND w.workspace_id = duration_observations.workspace_id
              AND json_extract(w.estimate_json, '$.source') = 'llm_prior'),
          context_version = COALESCE((SELECT json_extract(w.payload_json, '$.contextVersion') FROM work_orders w
            WHERE w.id = duration_observations.work_order_id AND w.workspace_id = duration_observations.workspace_id), '')
        WHERE llm_p50_minutes IS NULL`);
    } },
    // A step plan now carries what it rests on (decided 2026-10-09): the content units read from the person's files, the questions
    // only the person can answer, and per step what it covers and why. Kept as JSON beside the columns the scheduler reads.
    { version: 11, up: () => {
      if (!has("task_step_plans", "detail_json")) ledger.db.exec("ALTER TABLE task_step_plans ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}'");
      if (!has("task_steps", "detail_json")) ledger.db.exec("ALTER TABLE task_steps ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}'");
    } },
    // The one input box (docs/one-input.md): a conversation per day, kept in the ledger so another device resumes it and a backup
    // carries it. A message's card (the actions it proposed and what became of each) lives in its payload.
    { version: 12, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, day TEXT NOT NULL, codex_thread_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workspace_id, day));
        CREATE TABLE IF NOT EXISTS conversation_messages (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
          text TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS conversation_messages_by_conversation ON conversation_messages(workspace_id, conversation_id, created_at);`);
    } },
    // Artifact-first joint planning (docs/flywheel-and-views.md §5): a milestone names the artifacts it produces for and uses from other
    // lines, and a relation derived from those references keeps the artifact, the promised transfer, the check day and the
    // counterfactual. Plain columns: old anchors read as producing and using nothing, old relations as carrying no artifact.
    { version: 13, up: () => {
      if (!has("milestone_anchors", "outputs_json")) ledger.db.exec("ALTER TABLE milestone_anchors ADD COLUMN outputs_json TEXT NOT NULL DEFAULT '[]'");
      if (!has("milestone_anchors", "inputs_json")) ledger.db.exec("ALTER TABLE milestone_anchors ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]'");
      if (!has("milestone_relations", "artifact_id")) ledger.db.exec("ALTER TABLE milestone_relations ADD COLUMN artifact_id TEXT");
      if (!has("milestone_relations", "transfer_json")) ledger.db.exec("ALTER TABLE milestone_relations ADD COLUMN transfer_json TEXT");
      if (!has("milestone_relations", "check_on")) ledger.db.exec("ALTER TABLE milestone_relations ADD COLUMN check_on TEXT");
      if (!has("milestone_relations", "counterfactual")) ledger.db.exec("ALTER TABLE milestone_relations ADD COLUMN counterfactual TEXT");
    } },
    // The plan takes effect by default (docs/loop-and-scout.md §1): one current row that calendar sync updates in place, no plan
    // versions to approve and no differences to settle. Nothing is thrown away: each difference becomes a `plan.change_archived`
    // event and each older version a `plan.version_archived` event before the table and the rows go.
    { version: 14, up: () => {
      if (ledger.hasTable("plan_changes")) {
        ledger.archivePlanChangeRows("SELECT * FROM plan_changes");
        ledger.db.exec("DROP TABLE plan_changes");
      }
      ledger.collapsePlanVersions();
    } },
    // Invite codes for the hosted beta (2026-10-18): who applied, the owner's decision, the code's hash (never the code), and which
    // account redeemed it. `workspace_id` is the applicant's, so deleting an account deletes its application with it.
    { version: 15, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS beta_invites (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL, code_hash TEXT, created_at TEXT NOT NULL, decided_at TEXT, redeemed_at TEXT, redeemed_workspace_id TEXT);
        CREATE INDEX IF NOT EXISTS beta_invites_by_workspace ON beta_invites(workspace_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS beta_invites_by_code ON beta_invites(code_hash) WHERE code_hash IS NOT NULL;`);
    } },
    // Numbered evidence (2026-10-19): the person's replies and files cut into sentences with ids the model cites instead of copying
    // words (`evidence_sentences`), the sentences each fact rests on (`profile_facts.source_sentences`), and a document number fixed at
    // upload (`source_documents.ref_no`): `src-N` used to be a position, so removing one file renumbered every later one and the facts
    // and dates citing them pointed at the wrong file. Existing documents keep the number their position gives them today.
    { version: 16, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS evidence_sentences (
          workspace_id TEXT NOT NULL, id INTEGER NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('reply','document')),
          source_id TEXT NOT NULL, source_hash TEXT NOT NULL, ord INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
          text TEXT NOT NULL, segmenter TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id));
        CREATE INDEX IF NOT EXISTS evidence_by_source ON evidence_sentences(workspace_id, source_kind, source_id, retired, ord);
        CREATE TABLE IF NOT EXISTS workspace_counters (workspace_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, name));`);
      if (!has("profile_facts", "source_sentences")) ledger.db.exec("ALTER TABLE profile_facts ADD COLUMN source_sentences TEXT NOT NULL DEFAULT '[]'");
      if (!has("source_documents", "ref_no")) {
        ledger.db.exec("ALTER TABLE source_documents ADD COLUMN ref_no INTEGER");
        ledger.numberDocuments();
      }
    } },
    // The question ledger (2026-10-19): every question put to the person — the interview's, the app's own, 待决, a step plan's — once,
    // numbered per workspace, with its answer and the sentences it was given in, so a model is shown what was already asked.
    { version: 17, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS question_ledger (
          workspace_id TEXT NOT NULL, id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('interview','ask')), key TEXT NOT NULL,
          text TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]', identity_id TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('pending','open','answered','assumed','dropped')), answer TEXT NOT NULL DEFAULT '',
          answer_sentences TEXT NOT NULL DEFAULT '[]', repeats INTEGER, asked_at TEXT NOT NULL, answered_at TEXT, updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, key));
        CREATE INDEX IF NOT EXISTS question_ledger_by_status ON question_ledger(workspace_id, status, updated_at);`);
    } },
    // Records (2026-10-19, docs/domain-lines.md): a wealth line's bookkeeping and a wellness line's measurements, one row per real event
    // (`dedupe_key`: the same mail, shortcut or confirmation never writes twice). `deleted_at` keeps a removed record out of every sum
    // while the deletion stays undoable.
    { version: 18, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS domain_records (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, domain TEXT NOT NULL CHECK(domain IN ('wellness','wealth')), kind TEXT NOT NULL,
          at TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL,
          created_at TEXT NOT NULL, deleted_at TEXT,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, dedupe_key));
        CREATE INDEX IF NOT EXISTS domain_records_by_day ON domain_records(workspace_id, domain, at);`);
    } },
    // The files' text as passages in a full-text index (2026-10-20, docs/context-selection.md): each about 800 characters with a heading
    // 「文件名 · 项目 · 线」, in an FTS5 trigram table kept by triggers, so a task's context holds the passages that match it instead of
    // every file cut blind. Derived from `source_documents` and rebuilt from it here, on restore, and whenever a file is read, re-read,
    // filed or removed; never exported. `id` is an INTEGER PRIMARY KEY so the external-content index survives a VACUUM.
    { version: 19, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS doc_chunks (
          id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, ord INTEGER NOT NULL, start_at INTEGER NOT NULL,
          heading TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(workspace_id, document_id, ord));
        CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(heading, body, content='doc_chunks', content_rowid='id', tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body); END;
        CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body); END;
        CREATE TRIGGER IF NOT EXISTS doc_chunks_au AFTER UPDATE ON doc_chunks BEGIN
          INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, heading, body) VALUES ('delete', old.id, old.heading, old.body);
          INSERT INTO doc_chunks_fts(rowid, heading, body) VALUES (new.id, new.heading, new.body); END;`);
      ledger.indexDocuments();
    } },
    // What the ledger learned from past runs, in place of Codex's own memories (docs/token-economy.md §2, 2026-10-21): lessons drawn by
    // rule from what already happened (a rejected result's note, the gate's 「部分」, a step far over its cautious estimate, an error
    // repeated in a week, the Codex memories once imported), keyed by line and archetype; and how often each fact, preference and lesson
    // was actually used by an answer that took effect, so context is chosen by use and what is never used lapses. Not derived: exported.
    { version: 20, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS run_lessons (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, line_id TEXT, archetype_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('failure','preference','knowledge')), text TEXT NOT NULL, source TEXT NOT NULL,
          source_ref TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, invalidated_at TEXT,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, source, source_ref));
        CREATE INDEX IF NOT EXISTS run_lessons_by_line ON run_lessons(workspace_id, line_id, archetype_id);`);
      if (!has("profile_facts", "use_count")) ledger.db.exec("ALTER TABLE profile_facts ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
      if (!has("profile_facts", "last_used_at")) ledger.db.exec("ALTER TABLE profile_facts ADD COLUMN last_used_at TEXT");
      if (!has("preference_entries", "use_count")) ledger.db.exec("ALTER TABLE preference_entries ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0");
      if (!has("preference_entries", "last_used_at")) ledger.db.exec("ALTER TABLE preference_entries ADD COLUMN last_used_at TEXT");
      if (!has("preference_entries", "invalidated_at")) ledger.db.exec("ALTER TABLE preference_entries ADD COLUMN invalidated_at TEXT");
      if (!has("preference_entries", "confirmed_at")) ledger.db.exec("ALTER TABLE preference_entries ADD COLUMN confirmed_at TEXT");
    } },
    // What a run was for, beside which Skill ran (2026-10-21, docs/token-economy.md §2.3): `non_core` for the background work nobody
    // waits on that the quota saver holds to a share of the week (public skills' monthly search and reviews, line-skill compiling,
    // research, the nightly flywheel, portrait rewrites, archetype curation, energy advice). One Skill serves both kinds (the reviewer
    // judges public skills and planners' answers), so the Skill's name cannot say it. Older rows read as '' (not non-core).
    { version: 21, up: () => {
      if (!has("model_usage", "purpose")) ledger.db.exec("ALTER TABLE model_usage ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
    } },
    // The ledger (2026-10-28, docs/mail-bookkeeping.md §4.4): a money record is one real transaction, and each mail, notification or entry
    // that shows it is a row of `record_evidence` (unique per source item, so the same mail in two mailboxes or seen twice is one piece).
    // Beside the record: the merchant's key and account, where its category came from, whether it waits on the person (a possible
    // duplicate), the expense a refund belongs to, and why it was voided. Older rows read as booked with nothing beside them.
    { version: 22, up: () => {
      for (const [column, ddl] of [["merchant_key", "TEXT NOT NULL DEFAULT ''"], ["account", "TEXT NOT NULL DEFAULT ''"], ["category_by", "TEXT NOT NULL DEFAULT ''"],
        ["status", "TEXT NOT NULL DEFAULT 'booked'"], ["possible_dup_of", "TEXT NOT NULL DEFAULT ''"], ["refund_of", "TEXT NOT NULL DEFAULT ''"],
        ["void_reason", "TEXT NOT NULL DEFAULT ''"]] as const) {
        if (!has("domain_records", column)) ledger.db.exec(`ALTER TABLE domain_records ADD COLUMN ${column} ${ddl}`);
      }
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS record_evidence (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, record_id TEXT NOT NULL, source TEXT NOT NULL, source_key TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT '', merchant TEXT NOT NULL DEFAULT '',
          merchant_key TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '[]', last4 TEXT NOT NULL DEFAULT '', instrument TEXT NOT NULL DEFAULT '',
          occurred_on TEXT NOT NULL, sender_key TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, source_key));
        CREATE INDEX IF NOT EXISTS record_evidence_by_record ON record_evidence(workspace_id, record_id);`);
    } },
    // Opportunities the agent found (docs/opportunity-agent.md §6, 2026-11-01): one row per opening across every source, keyed by
    // host + normalized title + first deadline so a posting seen on its job board, in a mail and on a search page is one row. The
    // record itself (`Opportunity` plus the read terms) is JSON; beside it the verdict, the person's decision and the mail that
    // confirmed a sign-up. Not derived: exported.
    { version: 23, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS opportunities (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, line_id TEXT NOT NULL, need_id TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL, title TEXT NOT NULL, deadline TEXT NOT NULL DEFAULT '', data_json TEXT NOT NULL, verdict TEXT NOT NULL,
          verdict_json TEXT NOT NULL, decision TEXT NOT NULL DEFAULT '', decided_at TEXT NOT NULL DEFAULT '', later_until TEXT NOT NULL DEFAULT '',
          confirmed_by TEXT NOT NULL DEFAULT '', found_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, key));
        CREATE INDEX IF NOT EXISTS opportunities_by_line ON opportunities(workspace_id, line_id, deadline);`);
    } },
    // Assets and liabilities (docs/ledger-wealth.md, 2026-11-10): the person's accounts, a dated balance per account and day (what they
    // typed, or holdings valued by the worker), and brokerage or crypto positions. `market_prices` is a cache of public prices — FX rates
    // per EUR, quotes, crypto — shared by every workspace and never in a backup (refetched), so it has no workspace column.
    { version: 24, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS wealth_accounts (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, account_class TEXT NOT NULL, currency TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '', archived_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id));
        CREATE TABLE IF NOT EXISTS wealth_snapshots (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, on_day TEXT NOT NULL, value REAL NOT NULL,
          source TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, account_id, on_day));
        CREATE TABLE IF NOT EXISTS wealth_holdings (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL,
          price REAL NOT NULL DEFAULT 0, price_currency TEXT NOT NULL DEFAULT '', price_on TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, account_id, symbol));
        CREATE TABLE IF NOT EXISTS market_prices (
          kind TEXT NOT NULL, symbol TEXT NOT NULL, day TEXT NOT NULL, price REAL NOT NULL, currency TEXT NOT NULL, source TEXT NOT NULL,
          fetched_at TEXT NOT NULL, PRIMARY KEY(kind, symbol, day));`);
    } },
    // Opportunities serve several lines (docs/opportunity-agent.md §18, 2026-11-10): each record carries `lines` (line, the model's
    // confidence, code's relevance, a reason) and a `type` in its JSON; `line_id` stays the first line. Rows read before get their one
    // line as a migrated tag at the push threshold — they were shown under the old rules — and a type read from their title.
    { version: 25, up: () => {
      const rows = ledger.db.prepare("SELECT workspace_id, id, line_id, data_json FROM opportunities").all() as Array<{ workspace_id: string; id: string; line_id: string; data_json: string }>;
      const update = ledger.db.prepare("UPDATE opportunities SET data_json = ? WHERE workspace_id = ? AND id = ?");
      for (const row of rows) {
        let data: Record<string, unknown>;
        try { data = JSON.parse(row.data_json) as Record<string, unknown>; } catch { continue; }
        if (Array.isArray(data.lines)) continue;
        const tags = migratedTags({ lineId: row.line_id, kind: data.kind === "event" ? "event" : "application", title: String(data.title ?? "") });
        update.run(JSON.stringify({ ...data, lines: tags.lines, type: data.type ?? tags.type }), row.workspace_id, row.id);
      }
    } },
    // 小帮手's threads (2026-11-10): a conversation is either the day's (`kind` 'day', one per day, the default thread every box opens)
    // or one the person started (`kind` 'thread', named, archivable). The day's uniqueness becomes a partial index, so the table is
    // rebuilt without its UNIQUE(workspace_id, day). `instructions_seen` is the version of 「给 Crossline 的话」 the Codex thread was told.
    { version: 26, up: () => {
      ledger.db.exec(`
        CREATE TABLE conversations_v24 (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, day TEXT NOT NULL, codex_thread_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'day', title TEXT NOT NULL DEFAULT '',
          archived_at TEXT NOT NULL DEFAULT '', instructions_seen INTEGER NOT NULL DEFAULT 0);
        INSERT INTO conversations_v24 (id, workspace_id, day, codex_thread_id, created_at, updated_at)
          SELECT id, workspace_id, day, codex_thread_id, created_at, updated_at FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_v24 RENAME TO conversations;
        CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_per_day ON conversations(workspace_id, day) WHERE kind = 'day';
        CREATE INDEX IF NOT EXISTS conversations_by_update ON conversations(workspace_id, updated_at);`);
    } },
    // Workflows (2026-11-10, the 自动化 page): automations and grown workflows in tables of their own, each change of one a version, and
    // each with its own conversation. The settings keys they lived in (`automations`, `skills.grown`, `skills.grown.files.<id>`,
    // `skills.grown.versions.<id>`) are moved here whole and read and written through these tables from now on (`getSetting`), so
    // every reader of the old keys goes on working. Not derived: exported.
    { version: 27, up: () => {
      ledger.db.exec(`
        CREATE TABLE IF NOT EXISTS workflows (
          workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('automation','grown')), id TEXT NOT NULL, ord INTEGER NOT NULL,
          data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, kind, id));
        CREATE TABLE IF NOT EXISTS workflow_files (
          workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id, workflow_id));
        CREATE TABLE IF NOT EXISTS workflow_versions (
          workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('automation','grown')), workflow_id TEXT NOT NULL, version INTEGER NOT NULL,
          data_json TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', turn_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, kind, workflow_id, version));
        CREATE TABLE IF NOT EXISTS workflow_threads (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, workflow_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('automation','grown')),
          codex_thread_id TEXT NOT NULL DEFAULT '', line_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id));
        CREATE INDEX IF NOT EXISTS workflow_threads_by_workflow ON workflow_threads(workspace_id, workflow_id);
        CREATE TABLE IF NOT EXISTS workflow_turns (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL, ord INTEGER NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('person','assistant','system')), text TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]',
          state TEXT NOT NULL CHECK(state IN ('running','done','failed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id, id));
        CREATE INDEX IF NOT EXISTS workflow_turns_by_thread ON workflow_turns(workspace_id, thread_id, ord);`);
      ledger.adoptLegacyWorkflowSettings();
    } },
    // 2026-11-27 (docs/plans/condense-1127.md §C): about 340 event names condensed into 47 families, history included; the two progress
    // ticks left the ledger. The mapping lives only in event-condense.ts, which `importSnapshot` also runs on what it reads.
    { version: 28, up: () => { condenseEventTypes(ledger.db); } }
  ];

  const current = Number(ledger.db.pragma("user_version", { simple: true }));
  const pending = migrations.filter((migration) => migration.version > current);
  if (!pending.length) return;
  // A copy before the first change, not only on the legacy-tasks path where the old code took one.
  // Every rebuild until now ran against the live file with no way back.
  if (path !== ":memory:" && existsSync(path)) {
    ledger.db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(path, `${path}.v${current}.bak`);
  }
  for (const migration of pending) {
    ledger.db.transaction(() => {
      migration.up();
      ledger.db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
