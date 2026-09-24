import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { advanceWorkOrder, validateAnalysisProposal, validateAnalysisContext, validateMilestoneGateResult, validateSuccessCriteria,
  type MilestoneGateResult, type SuccessCriterion, type WorkOrderEvent, type WorkOrderState } from "@crossline/core";

type LedgerEventInput = {
  ownerId: string;
  workspaceId: string;
  idempotencyKey: string;
  type: string;
  entityId: string;
  payload: unknown;
};

type LedgerEvent = LedgerEventInput & { eventId: string; createdAt: string };

export type StoredCapture = {
  id: string; ownerId: string; workspaceId: string; title: string; context: string;
  state: "captured" | "analyzing" | "awaiting_plan_approval" | "blocked" | "promoted" | "discarded";
  attempt: number;
  audit: { threadId?: string; turnId?: string; contextVersion?: string;
    /** How many times the validator sent the answer back to be fixed. A schema that needs this every
     * run is a schema problem, and it only reads as one if the count is on the record. */
    repairs?: number;
    blocker?: { code: string; message: string } };
};

export type StoredMilestone = {
  id: string;
  ownerId: string;
  workspaceId: string;
  identityId: string;
  projectId?: string;
  title: string;
  version: number;
  status: "draft" | "approved" | "archived";
  // What would count as reaching it. Without this the gate can only say "looks good".
  successCriteria: SuccessCriterion[];
  verifiability: "measurable" | "judgement_only" | "unstated";
};

export type CrosslineSnapshot = {
  schemaVersion: 2;
  exportedAt: string;
  workspaceId: string;
  events: LedgerEvent[];
  milestones: StoredMilestone[];
  capacityCommitments: CapacityCommitment[];
  workOrders: StoredWorkOrder[];
  milestoneRelations: StoredMilestoneRelation[];
  planVersions: StoredPlanVersion[];
  planChanges: StoredPlanChange[];
  energyObservations: StoredEnergyObservation[];
  tables: Record<string, Array<Record<string, string | number | null>>>;
};

export type CapacityCommitment = {
  id: string;
  ownerId: string;
  workspaceId: string;
  title: string;
  minimumMinutes: number;
  sourceTaskId?: string;
};

export type StoredWorkOrder = {
  id: string;
  ownerId: string;
  workspaceId: string;
  identityId: string;
  projectId: string;
  milestoneId: string;
  intent: string;
  state: string;
  riskTier: "routine" | "milestone" | "high_risk";
  recurrence?: { fullMinutes: number; minimumMinutes: number };
  tombstone?: { reason: string; createdAt: string };
  estimate: {
    p25Minutes: number; p50Minutes: number; p85Minutes: number;
    // `legacy_task` marks a number carried over from a v1 row: real, but never a prior anyone authored.
  source: "identity_prior" | "llm_prior" | "personal_history" | "legacy_task";
    observationCount: number; confidence: "low" | "medium" | "high";
  };
  payload: unknown;
};

export type EvidenceClaimInput = { kind: "file" | "link" | "record" | "telemetry"; uri: string; description: string };

export type StoredEvidenceClaim = EvidenceClaimInput & {
  id: string; ownerId: string; workspaceId: string; workOrderId: string;
  reviewStatus: "submitted" | "accepted" | "rejected"; createdAt: string;
};

export type StoredMaterial = {
  id: string; ownerId: string; workspaceId: string; workOrderId: string;
  uri: string; mediaType: string; sourceRefs: string[]; createdAt: string;
};

export type StoredExecution = {
  id: string; ownerId: string; workspaceId: string; workOrderId: string;
  startedAt: string; endedAt?: string;
  // Interrupted minutes are held apart from wall-clock so duration learning never counts them as work.
  pauseMinutes: number;
  durationObserved: boolean;
  outcome?: "completed" | "completed_without_evidence" | "blocked";
  interruptions: Array<{ pausedAt: string; resumedAt?: string; reason: string }>;
};

export type StoredPlanVersion = {
  id: string; ownerId: string; workspaceId: string; version: number;
  status: "draft" | "approved" | "superseded"; payload: unknown;
};

export type StoredPlanChange = {
  id: string; ownerId: string; workspaceId: string; planVersionId: string;
  kind: "add" | "move" | "remove" | "conflict"; triggerEventId: string;
  explanation: string; before?: unknown; after?: unknown;
  status: "pending" | "approved" | "excluded";
};

export type StoredMilestoneRelation = {
  id: string; ownerId: string; workspaceId: string;
  fromMilestoneId: string; toMilestoneId: string;
  kind: "enables" | "reuses" | "informs" | "constrains" | "recurring_feedback";
  // `refuted` is the flywheel's only negative feedback: a relation that turned out not to hold
  // stops producing candidates instead of quietly staying on the graph.
  status: "candidate" | "approved" | "archived" | "refuted";
  // A relation with no evidence may only ever be a candidate, and a candidate decides nothing.
  evidence: Array<{ uri: string; source: string; observedAt: string }>;
  counterexample: Array<{ note: string; observedAt: string }>;
  costMinutes: number | null;
  lastValidatedAt: string | null;
  /** What this relation claims. An arrow with no stated claim cannot be reviewed or refuted. */
  explanation: string | null;
  /** What would show the claim is wrong — the relation's own falsifier, like `staleWhen` on a finding. */
  refutedWhen: string | null;
};

export type StoredEnergyObservation = {
  id: string; ownerId: string; workspaceId: string;
  source: "self_report" | "execution_history" | "time_pattern" | "local_activity";
  level: "low" | "medium" | "high" | "uncalibrated";
  confidence: "low" | "medium" | "high";
  aggregate: Record<string, number>;
  observedAt: string;
};

export type StoredPrincipal = { id: string; betterAuthUserId: string; createdAt: string };
export type StoredWorkspace = { id: string; name: string; createdAt: string };
export type StoredWorkspaceMember = {
  principalId: string; workspaceId: string; role: "viewer" | "member" | "owner"; createdAt: string;
};
export type StoredDeviceLease = {
  id: string; principalId: string; workspaceId: string; deviceId: string;
  issuedAt: string; expiresAt: string; revokedAt?: string;
};

/** Reads the lease's own timestamps to judge whether it is currently usable — no I/O, so a caller (a
 * future command-authorization check, an admin "devices" list) can apply it without a fresh store read. */
export function isDeviceLeaseValid(lease: StoredDeviceLease, now: Date): boolean {
  if (lease.revokedAt) return false;
  return now.getTime() < Date.parse(lease.expiresAt);
}

/**
 * Records that the owner, while already signed in through a normal session, confirmed a specific
 * Tailscale login as really them. `nodeKey` is optional — `tailscale serve` forwards only
 * `Tailscale-User-Login`/`-Name`/`-Profile-Pic` to a proxied backend, no node identifier, so there is
 * nothing honest to put there from an HTTP header alone. This binding is a recorded fact, not an
 * authentication mechanism: nothing here bypasses or shortcuts Better Auth's own session check, by design.
 */
export type StoredTailscaleBinding = {
  id: string; principalId: string; workspaceId: string; tailscaleLogin: string;
  nodeKey?: string; createdAt: string;
};
export type StoredAuditEvent = {
  id: string; principalId: string; workspaceId: string; role: string; authMethod: string;
  requestId: string; idempotencyKey?: string;
  codexThreadId?: string; codexTurnId?: string; codexCallId?: string;
  action: string; payload: unknown; createdAt: string;
};

/**
 * Tables that once existed and never carried a row.
 *
 * Dropped at migration 4. Named here because a snapshot taken before that still lists them, and a
 * restore has to step over an empty one rather than refuse the whole backup — while still refusing
 * if one somehow has rows, because skipping those would be losing data quietly.
 */
const RETIRED_TABLES = ["outbox", "identities", "projects", "milestone_versions", "insight_proposals", "skill_versions"] as const;

/** Columns a migration dropped, by table. Same reason as `RETIRED_TABLES`: old snapshots still list them. */
const RETIRED_COLUMNS: Record<string, readonly string[]> = { energy_observations: ["expires_at"] };

export class CrosslineStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    // Deliberately no `busy_timeout` and no `journal_size_limit` here. Both looked necessary and
    // measured out as non-problems: better-sqlite3 already defaults the busy timeout to 5000ms, and
    // the 4 MB WAL beside this 352 KB database is not a missing checkpoint — it is the automatic
    // checkpoint threshold doing its job, with the file reused rather than truncated. Four megabytes
    // costs nothing, and a `journal_size_limit` equal to the threshold would not have shrunk it.
    const previousVersion = Number(this.#db.pragma("user_version", { simple: true }));
    const hasLegacyTasks = this.#hasTable("tasks");
    if (hasLegacyTasks && path !== ":memory:" && existsSync(path)) {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(path, previousVersion === 1 ? `${path}.v1.bak` : `${path}.pre-r2.bak`);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, key)
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, context TEXT NOT NULL, state TEXT NOT NULL, audit_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        title TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'archived')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(id, version)
      );
      CREATE TABLE IF NOT EXISTS milestone_relations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        from_milestone_id TEXT NOT NULL, to_milestone_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('enables','reuses','informs','constrains','recurring_feedback')),
        status TEXT NOT NULL CHECK(status IN ('candidate','approved','archived')), updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL, project_id TEXT NOT NULL, milestone_id TEXT NOT NULL,
        intent TEXT NOT NULL, state TEXT NOT NULL, risk_tier TEXT NOT NULL,
        estimate_json TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        pause_minutes INTEGER NOT NULL DEFAULT 0, outcome TEXT, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence_claims (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, kind TEXT NOT NULL, uri TEXT NOT NULL,
        review_status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, uri TEXT NOT NULL, media_type TEXT NOT NULL,
        source_refs_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, work_order_id, uri)
      );
      CREATE TABLE IF NOT EXISTS plan_versions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        version INTEGER NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_changes (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        plan_version_id TEXT NOT NULL, kind TEXT NOT NULL, trigger_event_id TEXT NOT NULL,
        explanation TEXT NOT NULL, before_json TEXT, after_json TEXT, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS energy_observations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        source TEXT NOT NULL, level TEXT NOT NULL, confidence TEXT NOT NULL,
        aggregate_json TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS external_bindings (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL, external_id TEXT NOT NULL, etag TEXT, sync_cursor TEXT,
        mode TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, provider, external_id)
      );
      CREATE TABLE IF NOT EXISTS capacity_commitments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        title TEXT NOT NULL, minimum_minutes INTEGER NOT NULL,
        source_task_id TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS principals (
        id TEXT PRIMARY KEY, better_auth_user_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('viewer','member','owner')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(principal_id, workspace_id)
      );
      CREATE INDEX IF NOT EXISTS workspace_members_workspace ON workspace_members(workspace_id);
      CREATE TABLE IF NOT EXISTS tailscale_bindings (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        tailscale_login TEXT NOT NULL, node_key TEXT, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, tailscale_login)
      );
      CREATE TABLE IF NOT EXISTS device_leases (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        device_id TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
        UNIQUE(workspace_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS device_leases_workspace ON device_leases(workspace_id, device_id);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        role TEXT NOT NULL, auth_method TEXT NOT NULL, request_id TEXT NOT NULL,
        idempotency_key TEXT, codex_thread_id TEXT, codex_turn_id TEXT, codex_call_id TEXT,
        action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_workspace ON audit_events(workspace_id, created_at);
    `);
    if (hasLegacyTasks) this.#migrateLegacyTasks();
    this.#runMigrations(path);
    this.#markPromotedCaptures();
  }

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
  #runMigrations(path: string): void {
    const has = (table: string, column: string) =>
      (this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);

    const migrations: Array<{ version: number; up: () => void }> = [
      // Everything through v2 is what the probe-based code used to do, restated as ordered steps. A
      // database that already ran the probes lands here at user_version 2 and skips all of it.
      { version: 3, up: () => {
        if (!has("milestones", "project_id")) this.#db.exec("ALTER TABLE milestones ADD COLUMN project_id TEXT");
        if (!has("captures", "attempt")) this.#db.exec("ALTER TABLE captures ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
        // Existing milestones predate success criteria. They are marked `unstated` rather than given
        // invented criteria — the gate refuses them until a human writes what would count.
        if (!has("milestones", "success_criteria_json")) this.#db.exec("ALTER TABLE milestones ADD COLUMN success_criteria_json TEXT NOT NULL DEFAULT '[]'");
        if (!has("milestones", "verifiability")) this.#db.exec("ALTER TABLE milestones ADD COLUMN verifiability TEXT NOT NULL DEFAULT 'unstated'");
        if (!has("work_orders", "recurrence_json")) this.#db.exec("ALTER TABLE work_orders ADD COLUMN recurrence_json TEXT");
        if (!has("work_orders", "tombstone_json")) this.#db.exec("ALTER TABLE work_orders ADD COLUMN tombstone_json TEXT");
        // SQLite cannot widen a CHECK in place, so the relation table is rebuilt once to admit
        // `refuted` and to carry the evidence a relation needs before it may influence anything.
        if (!has("milestone_relations", "evidence_json")) {
          this.#db.exec(`
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
        if (!has("milestone_relations", "explanation")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN explanation TEXT");
        if (!has("milestone_relations", "refuted_when")) this.#db.exec("ALTER TABLE milestone_relations ADD COLUMN refuted_when TEXT");
      } },

      // Six tables nothing has ever written, and one column nothing has ever read. They were carried
      // into every backup, every snapshot and every restore drill, and reading the schema suggested
      // capabilities that do not exist. `expires_at` is left over from the energy expiry model that
      // was deliberately removed.
      { version: 4, up: () => {
        for (const table of RETIRED_TABLES) {
          const rows = this.#hasTable(table)
            ? (this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
            : 0;
          // Never drop data. These are empty everywhere they have been looked at, but a row here would
          // mean the assumption was wrong, and finding that out by deleting it is not acceptable.
          if (rows > 0) throw new Error("MIGRATION_RETIRED_TABLE_NOT_EMPTY");
          this.#db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
        if (has("energy_observations", "expires_at")) this.#db.exec("ALTER TABLE energy_observations DROP COLUMN expires_at");

        // Every table's only index was the implicit one on its PRIMARY KEY, so each `WHERE
        // workspace_id = ?` was a full scan — fine at 146 events, not fine after a year of daily use,
        // and nothing here ever deletes a row.
        this.#db.exec(`
          CREATE INDEX IF NOT EXISTS events_workspace_type ON events(workspace_id, type);
          CREATE INDEX IF NOT EXISTS events_workspace_entity ON events(workspace_id, entity_id);
          CREATE INDEX IF NOT EXISTS work_orders_workspace_state ON work_orders(workspace_id, state);
          CREATE INDEX IF NOT EXISTS captures_workspace_state ON captures(workspace_id, state);
          CREATE INDEX IF NOT EXISTS executions_workspace_order ON executions(workspace_id, work_order_id);
          CREATE INDEX IF NOT EXISTS evidence_workspace_order ON evidence_claims(workspace_id, work_order_id);
          CREATE INDEX IF NOT EXISTS materials_workspace_order ON materials(workspace_id, work_order_id);
          CREATE INDEX IF NOT EXISTS plan_changes_version ON plan_changes(plan_version_id);
          CREATE INDEX IF NOT EXISTS milestones_workspace ON milestones(workspace_id, id);
        `);
      } },

      // Migration 4 dropped the six tables and the base DDL created them straight back on the next
      // open, so the live ledger sat at version 4 with every one of them present. Found by
      // `pnpm doctor:ledger` on the real database, not by a test — the round-trip tests all compare
      // against `tableNames()`, which agreed with itself either way. The DDL no longer creates them;
      // this drops them once more for a database that already recorded version 4.
      { version: 5, up: () => {
        for (const table of RETIRED_TABLES) {
          if (!this.#hasTable(table)) continue;
          const rows = (this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
          if (rows > 0) throw new Error("MIGRATION_RETIRED_TABLE_NOT_EMPTY");
          this.#db.exec(`DROP TABLE ${table}`);
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
        if (!has("tailscale_bindings", "node_key") || this.#columnIsNotNull("tailscale_bindings", "node_key")) {
          const rows = (this.#db.prepare("SELECT COUNT(*) AS count FROM tailscale_bindings").get() as { count: number }).count;
          if (rows > 0) throw new Error("MIGRATION_TAILSCALE_BINDINGS_NOT_EMPTY");
          this.#db.exec(`
            DROP TABLE tailscale_bindings;
            CREATE TABLE tailscale_bindings (
              id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
              tailscale_login TEXT NOT NULL, node_key TEXT, created_at TEXT NOT NULL,
              UNIQUE(workspace_id, tailscale_login)
            );
          `);
        }
      } }
    ];

    const current = Number(this.#db.pragma("user_version", { simple: true }));
    const pending = migrations.filter((migration) => migration.version > current);
    if (!pending.length) return;
    // A copy before the first change, not only on the legacy-tasks path where the old code took one.
    // Every rebuild until now ran against the live file with no way back.
    if (path !== ":memory:" && existsSync(path)) {
      this.#db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(path, `${path}.v${current}.bak`);
    }
    for (const migration of pending) {
      this.#db.transaction(() => {
        migration.up();
        this.#db.pragma(`user_version = ${migration.version}`);
      })();
    }
  }

  #hasTable(name: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  #columnIsNotNull(table: string, column: string): boolean {
    const info = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    return info.some((item) => item.name === column && item.notnull === 1);
  }

  #migrateLegacyTasks(): void {
    const legacyTasks = this.#db.prepare(
      "SELECT * FROM tasks WHERE identity_id <> 'health'"
    ).all() as Array<Record<string, string | number | null>>;
    const insert = this.#db.prepare(`
      INSERT OR IGNORE INTO work_orders (
        id, owner_id, workspace_id, identity_id, project_id, milestone_id,
        intent, state, risk_tier, estimate_json, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT OR IGNORE INTO capacity_commitments (
          id, owner_id, workspace_id, title, minimum_minutes, source_task_id, updated_at
        )
        SELECT id, owner_id, workspace_id, title, expected_minutes, id, updated_at
        FROM tasks WHERE identity_id = 'health'
      `).run();
      for (const row of legacyTasks) {
        const p50 = Number(row.expected_minutes);
        insert.run(
          String(row.id), String(row.owner_id), String(row.workspace_id), String(row.identity_id),
          `${String(row.identity_id)}-legacy`, String(row.milestone_id ?? "legacy-unassigned"),
          String(row.title), row.status === "completed" ? "accepted" : "captured",
          row.milestone_id ? "milestone" : "routine",
          // The legacy row held one number. Spreading it into a p25/p85 band and calling that an
          // identity prior invented both the interval and its provenance.
          JSON.stringify({
            p25Minutes: p50, p50Minutes: p50, p85Minutes: p50,
            source: "legacy_task", observationCount: 0, confidence: "low"
          }),
          JSON.stringify({ legacyTaskId: String(row.id), migratedFromSchema: 1 }), String(row.updated_at)
        );
      }
      this.#db.exec("DROP INDEX IF EXISTS tasks_workspace_status; DROP TABLE tasks");
    })();
  }

  // Databases written before the promoted marker left the capture row frozen at the WorkOrder's state,
  // so the same id existed twice and could resurface as analysable. Every promoted id has a WorkOrder.
  #markPromotedCaptures(): void {
    this.#db.prepare(`
      UPDATE captures SET state = 'promoted'
      WHERE state <> 'promoted' AND EXISTS (
        SELECT 1 FROM work_orders w WHERE w.id = captures.id AND w.workspace_id = captures.workspace_id
      )
    `).run();
  }

  /**
   * The database's migration level (`PRAGMA user_version`), advanced by the migration runner.
   *
   * Not the same number as `CrosslineSnapshot.schemaVersion`, which versions the export format and
   * moves only when the snapshot shape changes. They were both 2 for a while, which was a coincidence.
   */
  schemaVersion(): number {
    return Number(this.#db.pragma("user_version", { simple: true }));
  }

  capture(input: Omit<StoredCapture, "state" | "audit" | "attempt">, idempotencyKey: string): string {
    return this.#db.transaction(() => {
      const event = this.appendEvent({ ...input, idempotencyKey, type: "capture.created", entityId: input.id,
        payload: { title: input.title, context: input.context, mode: "manual" } });
      if (event.inserted) this.#db.prepare(
        "INSERT INTO captures (id, owner_id, workspace_id, title, context, state, audit_json, attempt) VALUES (?, ?, ?, ?, ?, 'captured', '{}', 0)"
      ).run(input.id, input.ownerId, input.workspaceId, input.title, input.context);
      return input.id;
    })();
  }

  /**
   * Throws away a raw capture the person does not want, keeping the text and their reason.
   *
   * A capture had no exit at all: the only thing the board offered was 分析, so a duplicate, a mistake
   * or a note that turned out not to be a task sat there forever. Analysing it to get rid of it costs
   * a real Codex turn and leaves a work order to discard afterwards. A capture already promoted is out
   * of scope — the WorkOrder is the live thing then, and it has its own 丢弃.
   */
  discardCapture(workspaceId: string, id: string, reason: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const capture = this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!capture) throw new Error("CAPTURE_NOT_FOUND");
      if (capture.state === "discarded") return { changed: false };
      if (capture.state === "promoted") throw new Error("CAPTURE_ALREADY_PROMOTED");
      if (capture.state === "analyzing") throw new Error("CAPTURE_IS_ANALYZING");
      if (!reason.trim()) throw new Error("DISCARD_REASON_REQUIRED");
      this.appendEvent({
        ownerId: capture.ownerId, workspaceId, idempotencyKey: `capture-discarded:${id}`,
        type: "capture.discarded", entityId: id, payload: { reason: reason.trim().slice(0, 200) }
      });
      this.#db.prepare("UPDATE captures SET state = 'discarded' WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
      return { changed: true };
    })();
  }

  listCaptures(workspaceId: string): StoredCapture[] {
    const rows = this.#db.prepare("SELECT * FROM captures WHERE workspace_id = ? ORDER BY rowid").all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      title: row.title!, context: row.context!, state: row.state as StoredCapture["state"],
      attempt: Number(row.attempt ?? 0), audit: JSON.parse(row.audit_json!) }));
  }

  transitionWorkOrder(workspaceId: string, id: string, event: WorkOrderEvent, idempotencyKey: string,
    update: { proposal?: unknown; context?: unknown; audit?: StoredCapture["audit"]; attempt?: number;
      evidence?: EvidenceClaimInput[]; durationObserved?: boolean;
      expectedWorkOrder?: StoredWorkOrder } = {}): { changed: boolean; state: WorkOrderState } {
    return this.#db.transaction(() => {
      const current = this.listWorkOrders(workspaceId).find((item) => item.id === id)
        ?? this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!current) throw new Error("WORK_ORDER_NOT_FOUND");
      const state = current.state as WorkOrderState;
      const isCapture = !("intent" in current);
      if (update.expectedWorkOrder && (isCapture
        || JSON.stringify(current) !== JSON.stringify(update.expectedWorkOrder)))
        throw new Error("PROPOSAL_VERSION_CHANGED");
      if (isCapture && !["analysis.proposed", "analysis.accepted", "blocked"].includes(event.type)) throw new Error("INVALID_WORK_ORDER_TRANSITION");
      if (this.#db.prepare("SELECT 1 FROM events WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, idempotencyKey)) {
        return { changed: false, state };
      }
      // A blocked capture is still raw user text, so a new attempt may re-analyse it. A blocked
      // WorkOrder has already been analysed and stays on the formal table's transitions.
      const retrying = isCapture && state === "blocked" && event.type === "analysis.proposed";
      const next = advanceWorkOrder({ ...current, state: retrying ? "captured" : state }, event);
      if (!next.ok) throw new Error(next.blocker.code);
      if (event.type === "analysis.accepted") {
        const context = validateAnalysisContext(update.context);
        const proposal = validateAnalysisProposal(update.proposal, context);
        const approved = context.approvedMilestones.find((m) => m.id === proposal.milestoneId)!;
        if (!this.listMilestones(workspaceId).some((m) => m.ownerId === current.ownerId && m.id === approved.id && m.version === approved.version && m.projectId === approved.projectId && m.identityId === approved.identityId && m.status === "approved")) throw new Error("ANALYSIS_MILESTONE_CHANGED");
        if (!update.audit?.threadId || !update.audit?.turnId) throw new Error("ANALYSIS_AUDIT_REQUIRED");
        this.saveWorkOrder({ id, ownerId: current.ownerId, workspaceId, ...proposal, state: next.to,
          payload: { ...proposal, audit: update.audit, contextVersion: context.version } });
      }
      const table = isCapture ? "captures" : "work_orders";
      // A promoted capture keeps its raw text and audit but stops being a capture: without this marker
      // the same id would sit in both tables at the same state and could resurface as analysable.
      this.#db.prepare(`UPDATE ${table} SET state = ? WHERE workspace_id = ? AND id = ?`)
        .run(isCapture && event.type === "analysis.accepted" ? "promoted" : next.to, workspaceId, id);
      if (!isCapture) this.#recordExecutionEffects(workspaceId, id, current.ownerId, event, update);
      if (isCapture && update.attempt !== undefined) {
        this.#db.prepare("UPDATE captures SET attempt = ? WHERE workspace_id = ? AND id = ?").run(update.attempt, workspaceId, id);
      }
      // Only captures carry an audit row; a promoted WorkOrder keeps its audit inside its own payload.
      if (update.audit && isCapture) this.updateAnalysisAudit(workspaceId, id, update.audit);
      this.appendEvent({ ownerId: current.ownerId, workspaceId, idempotencyKey,
        type: "work_order.transitioned", entityId: id, payload: { from: state, to: next.to, event, ...(update.audit ? { audit: update.audit } : {}) } });
      return { changed: true, state: next.to };
    }).immediate();
  }

  // Runs inside transitionWorkOrder's transaction, so an execution or evidence row can never outlive a
  // rolled-back state change. WorkOrders only — a capture has neither executions nor evidence.
  #recordExecutionEffects(workspaceId: string, id: string, ownerId: string, event: WorkOrderEvent,
    update: { evidence?: EvidenceClaimInput[]; durationObserved?: boolean }): void {
    const now = new Date().toISOString();
    const open = this.#openExecution(workspaceId, id);
    if (event.type === "human.started") {
      this.#db.prepare(`
        INSERT INTO executions (id, owner_id, workspace_id, work_order_id, started_at, ended_at, pause_minutes, outcome, payload_json)
        VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?)
      `).run(randomUUID(), ownerId, workspaceId, id, now,
        JSON.stringify({ durationObserved: update.durationObserved === true, interruptions: [] }));
      return;
    }
    // Ending while paused would otherwise leave the last interruption open and uncounted, so the
    // recorded wall clock would silently read as work. Both endings close it the same way.
    if (event.type === "human.completed" || event.type === "blocked") {
      const last = open?.interruptions.at(-1);
      if (open && last && !last.resumedAt) {
        this.#writeInterruptions(open.id, [...open.interruptions.slice(0, -1), { ...last, resumedAt: now }], open.durationObserved);
      }
    }
    if (event.type === "human.completed") {
      const evidence = update.evidence ?? [];
      for (const claim of evidence) {
        this.#db.prepare(`
          INSERT INTO evidence_claims (id, owner_id, workspace_id, work_order_id, kind, uri, review_status, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)
        `).run(randomUUID(), ownerId, workspaceId, id, claim.kind, claim.uri, JSON.stringify({ description: claim.description }), now);
      }
      // No evidence is recorded as an explicit outcome rather than as an invented claim.
      if (open) this.#db.prepare("UPDATE executions SET ended_at = ?, outcome = ? WHERE id = ?")
        .run(now, evidence.length ? "completed" : "completed_without_evidence", open.id);
      return;
    }
    if (event.type === "evidence.accepted") {
      const order = this.listWorkOrders(workspaceId).find((item) => item.id === id);
      const submitted = this.listEvidenceClaims(workspaceId).filter((claim) => claim.workOrderId === id && claim.reviewStatus === "submitted");
      // A milestone-bound item cannot be accepted on an empty evidence set.
      if (order?.milestoneId && !submitted.length) throw new Error("EVIDENCE_REQUIRED");
      this.#db.prepare("UPDATE evidence_claims SET review_status = 'accepted' WHERE workspace_id = ? AND work_order_id = ? AND review_status = 'submitted'")
        .run(workspaceId, id);
      return;
    }
    if (event.type === "acceptance.revoked") {
      this.#db.prepare("UPDATE evidence_claims SET review_status = 'submitted' WHERE workspace_id = ? AND work_order_id = ? AND review_status = 'accepted'")
        .run(workspaceId, id);
      return;
    }
    if (event.type === "blocked") {
      if (open) this.#db.prepare("UPDATE executions SET ended_at = ?, outcome = 'blocked' WHERE id = ?").run(now, open.id);
      this.#db.prepare("UPDATE evidence_claims SET review_status = 'rejected' WHERE workspace_id = ? AND work_order_id = ? AND review_status = 'submitted'")
        .run(workspaceId, id);
      // A reason that lives only in the ledger is a reason nobody reads; keep it on the row the UI renders.
      this.#mergeWorkOrderPayload(workspaceId, id, { blocker: { reason: event.reason, at: now } });
    }
    if (event.type === "plan.approved") this.#mergeWorkOrderPayload(workspaceId, id, { blocker: undefined });
  }

  #mergeWorkOrderPayload(workspaceId: string, id: string, patch: Record<string, unknown>): void {
    const row = this.#db.prepare("SELECT payload_json FROM work_orders WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as { payload_json: string } | undefined;
    if (!row) return;
    this.#db.prepare("UPDATE work_orders SET payload_json = ? WHERE workspace_id = ? AND id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.payload_json), ...patch }), workspaceId, id);
  }

  #openExecution(workspaceId: string, workOrderId: string):
    { id: string; ownerId: string; durationObserved: boolean; interruptions: StoredExecution["interruptions"] } | undefined {
    const row = this.#db.prepare(
      "SELECT id, owner_id, payload_json FROM executions WHERE workspace_id = ? AND work_order_id = ? AND ended_at IS NULL ORDER BY started_at DESC"
    ).get(workspaceId, workOrderId) as { id: string; owner_id: string; payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as { durationObserved: boolean; interruptions: StoredExecution["interruptions"] };
    return { id: row.id, ownerId: row.owner_id, durationObserved: payload.durationObserved, interruptions: payload.interruptions };
  }

  #writeInterruptions(executionId: string, interruptions: StoredExecution["interruptions"], durationObserved: boolean): void {
    const pausedMs = interruptions.reduce((total, item) =>
      total + (item.resumedAt ? Date.parse(item.resumedAt) - Date.parse(item.pausedAt) : 0), 0);
    this.#db.prepare("UPDATE executions SET pause_minutes = ?, payload_json = ? WHERE id = ?")
      .run(Math.round(pausedMs / 60_000), JSON.stringify({ durationObserved, interruptions }), executionId);
  }

  // Pause and resume are execution facts, not formal WorkOrder states: the order stays `active`
  // throughout and only the interruption record changes.
  pauseExecution(workspaceId: string, workOrderId: string, reason: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const open = this.#openExecution(workspaceId, workOrderId);
      if (!open) throw new Error("NO_ACTIVE_EXECUTION");
      if (open.interruptions.at(-1) && !open.interruptions.at(-1)!.resumedAt) return { changed: false };
      this.#writeInterruptions(open.id, [...open.interruptions, { pausedAt: new Date().toISOString(), reason }], open.durationObserved);
      this.appendEvent({ ownerId: open.ownerId, workspaceId, idempotencyKey: `execution:${open.id}:pause:${open.interruptions.length}`,
        type: "execution.paused", entityId: workOrderId, payload: { executionId: open.id, reason } });
      return { changed: true };
    }).immediate();
  }

  resumeExecution(workspaceId: string, workOrderId: string): { changed: boolean } {
    return this.#db.transaction(() => {
      const open = this.#openExecution(workspaceId, workOrderId);
      if (!open) throw new Error("NO_ACTIVE_EXECUTION");
      const last = open.interruptions.at(-1);
      if (!last || last.resumedAt) return { changed: false };
      this.#writeInterruptions(open.id, [...open.interruptions.slice(0, -1), { ...last, resumedAt: new Date().toISOString() }], open.durationObserved);
      this.appendEvent({ ownerId: open.ownerId, workspaceId, idempotencyKey: `execution:${open.id}:resume:${open.interruptions.length - 1}`,
        type: "execution.resumed", entityId: workOrderId, payload: { executionId: open.id, reason: last.reason } });
      return { changed: true };
    }).immediate();
  }

  listExecutions(workspaceId: string): StoredExecution[] {
    const rows = this.#db.prepare(
      "SELECT * FROM executions WHERE workspace_id = ? ORDER BY started_at, id"
    ).all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as { durationObserved?: boolean; interruptions?: StoredExecution["interruptions"] };
      return {
        id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
        workOrderId: String(row.work_order_id), startedAt: String(row.started_at),
        ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
        pauseMinutes: Number(row.pause_minutes), durationObserved: payload.durationObserved === true,
        ...(row.outcome ? { outcome: String(row.outcome) as NonNullable<StoredExecution["outcome"]> } : {}),
        interruptions: payload.interruptions ?? []
      };
    });
  }

  listEvidenceClaims(workspaceId: string): StoredEvidenceClaim[] {
    const rows = this.#db.prepare(
      "SELECT * FROM evidence_claims WHERE workspace_id = ? ORDER BY created_at, id"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, workOrderId: row.work_order_id!,
      kind: row.kind as StoredEvidenceClaim["kind"], uri: row.uri!,
      description: String((JSON.parse(row.payload_json!) as { description?: string }).description ?? ""),
      reviewStatus: row.review_status as StoredEvidenceClaim["reviewStatus"], createdAt: row.created_at!
    }));
  }

  saveMaterial(material: StoredMaterial): void {
    this.#db.prepare(`
      INSERT INTO materials (id, owner_id, workspace_id, work_order_id, uri, media_type, source_refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, work_order_id, uri) DO NOTHING
    `).run(material.id, material.ownerId, material.workspaceId, material.workOrderId, material.uri,
      material.mediaType, JSON.stringify(material.sourceRefs), material.createdAt);
  }

  listMaterials(workspaceId: string, workOrderId?: string): StoredMaterial[] {
    const rows = (workOrderId
      ? this.#db.prepare("SELECT * FROM materials WHERE workspace_id = ? AND work_order_id = ? ORDER BY created_at, id").all(workspaceId, workOrderId)
      : this.#db.prepare("SELECT * FROM materials WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId)) as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      workOrderId: row.work_order_id!, uri: row.uri!, mediaType: row.media_type!,
      sourceRefs: JSON.parse(row.source_refs_json!) as string[], createdAt: row.created_at! }));
  }

  updateAnalysisAudit(workspaceId: string, id: string, audit: StoredCapture["audit"]): void {
    this.#db.transaction(() => {
      const capture = this.listCaptures(workspaceId).find((item) => item.id === id);
      if (!capture) throw new Error("CAPTURE_NOT_FOUND");
      this.#db.prepare("UPDATE captures SET audit_json = ? WHERE workspace_id = ? AND id = ?")
        .run(JSON.stringify({ ...capture.audit, ...audit }), workspaceId, id);
    })();
  }

  appendEvent(event: LedgerEventInput): { inserted: boolean; eventId: string } {
    const existing = this.#db.prepare(
      "SELECT event_id FROM events WHERE workspace_id = ? AND idempotency_key = ?"
    ).get(event.workspaceId, event.idempotencyKey) as { event_id: string } | undefined;
    if (existing) return { inserted: false, eventId: existing.event_id };

    const eventId = randomUUID();
    this.#db.prepare(`
      INSERT INTO events (
        event_id, owner_id, workspace_id, idempotency_key, type, entity_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event.ownerId,
      event.workspaceId,
      event.idempotencyKey,
      event.type,
      event.entityId,
      JSON.stringify(event.payload),
      new Date().toISOString()
    );
    return { inserted: true, eventId };
  }

  /**
   * Events in the order they happened, scoped to one workspace.
   *
   * The workspace used to be the caller's problem: this took no arguments, read the whole table and
   * `JSON.parse`d every row, and forty-odd call sites filtered afterwards — several of them only by
   * `type`, so they would have read another workspace's rows the moment a second one existed. Making
   * it a parameter fixes the scoping and the full scan together, since `events_workspace_type` can
   * only be used by a query that names the workspace.
   *
   * `type` and `entityId` narrow it further. Passing them matters: the worker's timer paths were
   * walking the entire ledger every tick to build a two-entry map.
   */
  listEvents(workspaceId: string, options: { type?: string | string[]; entityId?: string } = {}): LedgerEvent[] {
    const types = options.type === undefined ? [] : Array.isArray(options.type) ? options.type : [options.type];
    const where = ["workspace_id = ?"];
    const values: string[] = [workspaceId];
    if (types.length) {
      where.push(`type IN (${types.map(() => "?").join(", ")})`);
      values.push(...types);
    }
    if (options.entityId !== undefined) {
      where.push("entity_id = ?");
      values.push(options.entityId);
    }
    // rowid is the order things actually happened. Ordering by (created_at, event_id) let a random
    // UUID decide the sequence of same-millisecond events, which defeats an append-only ledger.
    const rows = this.#db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY rowid`)
      .all(...values) as Array<Record<string, string>>;
    return rows.map((row) => ({
      eventId: row.event_id!,
      ownerId: row.owner_id!,
      workspaceId: row.workspace_id!,
      idempotencyKey: row.idempotency_key!,
      type: row.type!,
      entityId: row.entity_id!,
      payload: JSON.parse(row.payload_json!),
      createdAt: row.created_at!
    }));
  }

  saveMilestone(milestone: Omit<StoredMilestone, "successCriteria" | "verifiability">
    & Partial<Pick<StoredMilestone, "successCriteria" | "verifiability">>): void {
    const criteria = milestone.successCriteria ?? [];
    // An empty set is how a pre-v2 milestone is carried forward: honest, and refused by the gate.
    let verifiability: StoredMilestone["verifiability"] = "unstated";
    if (criteria.length) {
      const checked = validateSuccessCriteria(criteria);
      if (!checked.ok) throw new Error(checked.blocker.code);
      verifiability = checked.verifiability;
    }
    this.#db.prepare(`
      INSERT INTO milestones (
        id, owner_id, workspace_id, identity_id, title, version, status, updated_at, project_id,
        success_criteria_json, verifiability
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, version) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        updated_at = excluded.updated_at,
        project_id = COALESCE(excluded.project_id, milestones.project_id),
        success_criteria_json = excluded.success_criteria_json,
        verifiability = excluded.verifiability
    `).run(
      milestone.id,
      milestone.ownerId,
      milestone.workspaceId,
      milestone.identityId,
      milestone.title,
      milestone.version,
      milestone.status,
      new Date().toISOString(),
      milestone.projectId ?? null,
      JSON.stringify(criteria),
      verifiability
    );
  }

  listMilestones(workspaceId: string): StoredMilestone[] {
    const rows = this.#db.prepare(`
      SELECT m.* FROM milestones m
      JOIN (
        SELECT id, MAX(version) AS version FROM milestones
        WHERE workspace_id = ? GROUP BY id
      ) latest ON latest.id = m.id AND latest.version = m.version
      ORDER BY m.identity_id, m.id
    `).all(workspaceId) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      workspaceId: String(row.workspace_id),
      identityId: String(row.identity_id),
      title: String(row.title),
      version: Number(row.version),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      status: String(row.status) as StoredMilestone["status"],
      successCriteria: JSON.parse(String(row.success_criteria_json ?? "[]")) as SuccessCriterion[],
      verifiability: String(row.verifiability ?? "unstated") as StoredMilestone["verifiability"]
    }));
  }

  saveMilestoneRelation(relation:
    Omit<StoredMilestoneRelation, "evidence" | "counterexample" | "costMinutes" | "lastValidatedAt" | "explanation" | "refutedWhen">
    & Partial<Pick<StoredMilestoneRelation, "evidence" | "counterexample" | "costMinutes" | "lastValidatedAt" | "explanation" | "refutedWhen">>): void {
    // A relation with no evidence decides nothing, so it is not allowed to claim approval.
    const status = relation.status === "approved" && !(relation.evidence ?? []).length ? "candidate" : relation.status;
    this.#db.prepare(`
      INSERT INTO milestone_relations (
        id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status,
        evidence_json, counterexample_json, cost_minutes, last_validated_at, explanation, refuted_when, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_milestone_id = excluded.from_milestone_id,
        to_milestone_id = excluded.to_milestone_id,
        kind = excluded.kind,
        status = excluded.status,
        evidence_json = excluded.evidence_json,
        counterexample_json = excluded.counterexample_json,
        cost_minutes = excluded.cost_minutes,
        last_validated_at = excluded.last_validated_at,
        explanation = excluded.explanation,
        refuted_when = excluded.refuted_when,
        updated_at = excluded.updated_at
    `).run(
      relation.id, relation.ownerId, relation.workspaceId, relation.fromMilestoneId,
      relation.toMilestoneId, relation.kind, status,
      JSON.stringify(relation.evidence ?? []), JSON.stringify(relation.counterexample ?? []),
      relation.costMinutes ?? null, relation.lastValidatedAt ?? null,
      relation.explanation ?? null, relation.refutedWhen ?? null, new Date().toISOString()
    );
  }

  listMilestoneRelations(workspaceId: string): StoredMilestoneRelation[] {
    const rows = this.#db.prepare(
      "SELECT * FROM milestone_relations WHERE workspace_id = ? AND status <> 'archived' ORDER BY id"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      fromMilestoneId: row.from_milestone_id!, toMilestoneId: row.to_milestone_id!,
      kind: row.kind as StoredMilestoneRelation["kind"], status: row.status as StoredMilestoneRelation["status"],
      evidence: JSON.parse(String(row.evidence_json ?? "[]")),
      counterexample: JSON.parse(String(row.counterexample_json ?? "[]")),
      costMinutes: row.cost_minutes === null || row.cost_minutes === undefined ? null : Number(row.cost_minutes),
      lastValidatedAt: row.last_validated_at ?? null,
      explanation: row.explanation ?? null,
      refutedWhen: row.refuted_when ?? null
    }));
  }

  /**
   * Batch decision on candidate relations — the approval mode `requiredApproval("approve_milestone_relations")`
   * asks for.
   *
   * Only candidates are touched. A relation the user already approved, or that evidence has refuted,
   * is left exactly as it is: a batch action that silently re-decided settled relations would make the
   * whole review untrustworthy. Ids that are not candidates come back in `skipped` rather than being
   * reported as successes.
   */
  decideMilestoneRelations(workspaceId: string, ownerId: string, ids: string[], decision: "approved" | "archived",
    idempotencyKey: string): { decided: string[]; skipped: string[] } {
    const decided: string[] = [];
    const skipped: string[] = [];
    this.#db.transaction(() => {
      for (const id of ids) {
        const row = this.#db.prepare(
          "SELECT status, evidence_json FROM milestone_relations WHERE workspace_id = ? AND id = ?"
        ).get(workspaceId, id) as { status?: string; evidence_json?: string } | undefined;
        if (!row || row.status !== "candidate") { skipped.push(id); continue; }
        // The same rule `saveMilestoneRelation` enforces: a relation with no evidence decides nothing,
        // so it cannot be approved into one that does.
        if (decision === "approved" && !(JSON.parse(row.evidence_json ?? "[]") as unknown[]).length) {
          skipped.push(id);
          continue;
        }
        this.#db.prepare("UPDATE milestone_relations SET status = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(decision, new Date().toISOString(), workspaceId, id);
        decided.push(id);
      }
      if (decided.length) {
        this.appendEvent({
          ownerId, workspaceId, idempotencyKey,
          type: "milestone_relations.decided", entityId: decided[0]!,
          payload: { decision, relationIds: decided, skipped }
        });
      }
    })();
    return { decided, skipped };
  }

  applyMilestoneGate(workspaceId: string, workOrderId: string, result: MilestoneGateResult,
    evidenceTexts: string[], idempotencyKey: string): { changed: boolean; state: WorkOrderState } {
    // One transaction, not the dozen this used to be. The audit event, the transition, the payload
    // merge and any relation refutation each committed on their own, so a crash or a concurrent writer
    // between any two left the ledger and the row disagreeing — which is exactly the shape of the
    // "ledger says accepted, order still in evidence_review" state seen on the real database.
    return this.#db.transaction(() => {
    const order = this.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    if (!order || order.state !== "evidence_review") throw new Error("EVIDENCE_REVIEW_NOT_READY");
    const milestone = this.listMilestones(workspaceId).find((item) => item.id === order.milestoneId && item.status === "approved");
    if (!milestone || milestone.verifiability === "unstated") throw new Error("MILESTONE_NEEDS_CRITERIA");
    // The same requirement strings the gate was handed. This is the write, so the bar `pass` claims to
    // have cleared is re-checked here rather than trusted from the caller.
    const contractRequirements = ((order.payload as { evidenceContract?: Array<{ description?: string; kind?: string }> })
      .evidenceContract ?? []).map((item) => item.description ?? item.kind ?? "").filter(Boolean);
    validateMilestoneGateResult(result, milestone.successCriteria, evidenceTexts, contractRequirements);
    // Milestone progress is recorded on every judgement, pass or not. The verdict says whether this one
    // work order delivered; this says how far the milestone itself has moved, which is the question the
    // person actually has and which no single verdict can answer.
    this.appendEvent({
      ownerId: order.ownerId, workspaceId, idempotencyKey: `${idempotencyKey}:progress`,
      type: "milestone_gate.judged", entityId: workOrderId,
      payload: {
        milestoneId: milestone.id, milestoneVersion: milestone.version, verdict: result.verdict,
        criteriaVerdict: result.criteriaVerdict.map((item) => ({ criterionId: item.criterionId, met: item.met }))
      }
    });
    if (result.verdict !== "pass") {
      const transitioned = this.transitionWorkOrder(workspaceId, workOrderId,
        { type: "blocked", reason: `MILESTONE_GATE_${result.verdict.toUpperCase()}` }, idempotencyKey);
      // The judgement is kept on a refusal too. Only the pass path stored it, so a held work order
      // showed the person the single word MILESTONE_GATE_INSUFFICIENT and threw away the per-criterion
      // reasoning that says what is actually missing — which is the one thing they could act on.
      this.#mergeWorkOrderPayload(workspaceId, workOrderId, { gateReview: result });
      for (const assessment of result.flywheelAssessment.filter((item) => item.supports === "contradicts")) {
        this.refuteMilestoneRelation(workspaceId, assessment.relationId, assessment.evidenceQuote,
          `${idempotencyKey}:refute:${assessment.relationId}`);
      }
      return transitioned;
    }
    const relationIds = result.flywheelAssessment.filter((item) => item.supports === "advances").map((item) => item.relationId);
    const transitioned = this.transitionWorkOrder(workspaceId, workOrderId,
      { type: "evidence.accepted", approvalId: "crossline-milestone-gate" }, idempotencyKey);
    // A reused idempotency key makes the transition a no-op, and writing the acceptance audit anyway
    // produced a ledger that said `milestone_gate.auto_accepted` about an order still sitting in
    // `evidence_review`. A key that has already been spent is a caller bug, and it says so.
    if (!transitioned.changed) throw new Error("GATE_ALREADY_APPLIED");
    this.#mergeWorkOrderPayload(workspaceId, workOrderId, {
      gateReview: result,
      autoAcceptance: { acceptedAt: new Date().toISOString(), relationIds }
    });
    this.appendEvent({ ownerId: order.ownerId, workspaceId, idempotencyKey: `${idempotencyKey}:audit`,
      type: "milestone_gate.auto_accepted", entityId: workOrderId, payload: { milestoneId: milestone.id, relationIds } });
    return transitioned;
    })["immediate"]();
  }

  revokeAutoAcceptance(workspaceId: string, workOrderId: string, reason: string, idempotencyKey: string): { changed: boolean; state: WorkOrderState } {
    // Read, check `state !== "accepted"`, transition, merge, append — five separate writes with no
    // outer transaction, so a revoke could half-happen.
    return this.#db.transaction(() => {
    const order = this.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
    const payload = order?.payload as { autoAcceptance?: Record<string, unknown> } | undefined;
    if (!order || order.state !== "accepted" || !payload?.autoAcceptance) throw new Error("AUTO_ACCEPTANCE_NOT_REVOCABLE");
    if (!reason.trim()) throw new Error("REVOCATION_REASON_REQUIRED");
    const transitioned = this.transitionWorkOrder(workspaceId, workOrderId,
      { type: "acceptance.revoked", reason: reason.trim() }, idempotencyKey);
    // `transitionWorkOrder` no-ops silently on a spent idempotency key (`{ changed: false }`), which is
    // right for a genuine retry but wrong here if it happens anyway: the caller is expected to key each
    // attempt uniquely, and a collision reaching this point means the transition did NOT happen, not
    // that it happened before. Proceeding to merge the payload and append the audit event under that
    // assumption is exactly the bug this guard closes — the caller reported success for a revoke that
    // never touched the work order's state.
    if (!transitioned.changed) throw new Error("REVOCATION_ALREADY_APPLIED");
    this.#mergeWorkOrderPayload(workspaceId, workOrderId, {
      autoAcceptance: { ...payload.autoAcceptance, revokedAt: new Date().toISOString(), revocationReason: reason.trim() }
    });
    this.appendEvent({ ownerId: order.ownerId, workspaceId, idempotencyKey: `${idempotencyKey}:audit`,
      type: "milestone_gate.auto_acceptance_revoked", entityId: workOrderId, payload: { reason: reason.trim() } });
    return transitioned;
    })["immediate"]();
  }

  refuteMilestoneRelation(workspaceId: string, relationId: string, note: string, idempotencyKey: string): void {
    // The relation write, one payload merge per affected work order, and the ledger entry were all
    // separate; two concurrent merges on the same order also lost one of the patches.
    this.#db.transaction(() => {
    const relation = this.listMilestoneRelations(workspaceId).find((item) => item.id === relationId);
    if (!relation) throw new Error("MILESTONE_RELATION_NOT_FOUND");
    const observedAt = new Date().toISOString();
    this.saveMilestoneRelation({ ...relation, status: "refuted",
      counterexample: [...relation.counterexample, { note, observedAt }], lastValidatedAt: observedAt });
    for (const order of this.listWorkOrders(workspaceId).filter((item) => item.state === "accepted")) {
      const payload = order.payload as { autoAcceptance?: { relationIds?: string[]; [key: string]: unknown } };
      if (!payload.autoAcceptance?.relationIds?.includes(relationId)) continue;
      this.#mergeWorkOrderPayload(workspaceId, order.id, {
        autoAcceptance: { ...payload.autoAcceptance, questionedAt: observedAt, questionedByRelationId: relationId }
      });
    }
    this.appendEvent({ ownerId: relation.ownerId, workspaceId, idempotencyKey,
      type: "milestone_relation.refuted", entityId: relationId, payload: { note } });
    })["immediate"]();
  }

  /**
   * A day's local activity is a rolling summary, not an observation: it is rewritten as the day goes
   * on. Self-reports stay immutable (`saveEnergyObservation` ignores conflicts) because a thing a
   * person said at a moment must never be silently rewritten.
   */
  upsertDailyActivity(input: { ownerId: string; workspaceId: string; day: string; aggregate: Record<string, number>; observedAt: string }): void {
    this.#db.prepare(`
      INSERT INTO energy_observations (
        id, owner_id, workspace_id, source, level, confidence, aggregate_json, observed_at
      ) VALUES (?, ?, ?, 'local_activity', 'uncalibrated', 'low', ?, ?)
      ON CONFLICT(id) DO UPDATE SET aggregate_json = excluded.aggregate_json, observed_at = excluded.observed_at
    `).run(`local-activity:${input.day}`, input.ownerId, input.workspaceId,
      JSON.stringify(input.aggregate), input.observedAt);
  }

  saveEnergyObservation(observation: StoredEnergyObservation): void {
    this.#db.prepare(`
      INSERT INTO energy_observations (
        id, owner_id, workspace_id, source, level, confidence, aggregate_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      observation.id, observation.ownerId, observation.workspaceId, observation.source,
      observation.level, observation.confidence, JSON.stringify(observation.aggregate),
      observation.observedAt
    );
  }

  /** Absent means never asked — which is different from asked and declined. */
  getSetting(workspaceId: string, key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE workspace_id = ? AND key = ?")
      .get(workspaceId, key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(workspaceId: string, key: string, value: string): void {
    this.#db.prepare(`
      INSERT INTO settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(workspaceId, key, value, new Date().toISOString());
  }

  listEnergyObservations(workspaceId: string): StoredEnergyObservation[] {
    const rows = this.#db.prepare(
      "SELECT * FROM energy_observations WHERE workspace_id = ? ORDER BY observed_at DESC, id"
    ).all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!,
      source: row.source as StoredEnergyObservation["source"],
      level: row.level as StoredEnergyObservation["level"],
      confidence: row.confidence as StoredEnergyObservation["confidence"],
      aggregate: JSON.parse(row.aggregate_json!) as Record<string, number>,
      observedAt: row.observed_at!
    }));
  }


  listCapacityCommitments(workspaceId: string): CapacityCommitment[] {
    const rows = this.#db.prepare(
      "SELECT * FROM capacity_commitments WHERE workspace_id = ? ORDER BY id"
    ).all(workspaceId) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      workspaceId: String(row.workspace_id),
      title: String(row.title),
      minimumMinutes: Number(row.minimum_minutes),
      ...(row.source_task_id ? { sourceTaskId: String(row.source_task_id) } : {})
    }));
  }

  listWorkOrders(workspaceId: string): StoredWorkOrder[] {
    const rows = this.#db.prepare(
      "SELECT * FROM work_orders WHERE workspace_id = ? ORDER BY updated_at, id"
    ).all(workspaceId) as Array<Record<string, string>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, identityId: row.identity_id!,
      projectId: row.project_id!, milestoneId: row.milestone_id!, intent: row.intent!, state: row.state!,
      riskTier: row.risk_tier as StoredWorkOrder["riskTier"],
      estimate: JSON.parse(row.estimate_json!) as StoredWorkOrder["estimate"],
      payload: JSON.parse(row.payload_json!)
    }));
  }

  saveWorkOrder(workOrder: StoredWorkOrder): void {
    this.#db.prepare(`
      INSERT INTO work_orders (
        id, owner_id, workspace_id, identity_id, project_id, milestone_id,
        intent, state, risk_tier, estimate_json, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        identity_id = excluded.identity_id,
        project_id = excluded.project_id,
        milestone_id = excluded.milestone_id,
        intent = excluded.intent,
        state = excluded.state,
        risk_tier = excluded.risk_tier,
        estimate_json = excluded.estimate_json,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      workOrder.id, workOrder.ownerId, workOrder.workspaceId, workOrder.identityId,
      workOrder.projectId, workOrder.milestoneId, workOrder.intent, workOrder.state,
      workOrder.riskTier, JSON.stringify(workOrder.estimate), JSON.stringify(workOrder.payload),
      new Date().toISOString()
    );
  }

  /** Publish one backplan as a unit so a crash cannot leave half a set of draft steps. */
  saveBackplanDrafts(workspaceId: string, drafts: StoredWorkOrder[], event: LedgerEventInput): boolean {
    return this.#db.transaction(() => {
      if (this.#db.prepare("SELECT 1 FROM events WHERE workspace_id = ? AND idempotency_key = ?")
        .get(workspaceId, event.idempotencyKey)) return false;
      const existing = new Set(this.listWorkOrders(workspaceId).map((item) => item.id));
      if (drafts.some((draft) => draft.workspaceId !== workspaceId || draft.state !== "awaiting_plan_approval"
        || existing.has(draft.id)))
        throw new Error("BACKPLAN_DRAFT_COLLISION");
      for (const draft of drafts) this.saveWorkOrder(draft);
      this.appendEvent(event);
      return true;
    })["immediate"]();
  }

  savePlanVersion(plan: StoredPlanVersion): void {
    this.#db.prepare(`
      INSERT INTO plan_versions (id, owner_id, workspace_id, version, status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json
    `).run(plan.id, plan.ownerId, plan.workspaceId, plan.version, plan.status, JSON.stringify(plan.payload), new Date().toISOString());
  }

  listPlanVersions(workspaceId: string): StoredPlanVersion[] {
    const rows = this.#db.prepare(
      "SELECT * FROM plan_versions WHERE workspace_id = ? ORDER BY version DESC, created_at DESC"
    ).all(workspaceId) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: String(row.id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id),
      version: Number(row.version), status: String(row.status) as StoredPlanVersion["status"],
      payload: JSON.parse(String(row.payload_json))
    }));
  }

  savePlanChange(change: StoredPlanChange): void {
    this.#db.prepare(`
      INSERT INTO plan_changes (
        id, owner_id, workspace_id, plan_version_id, kind, trigger_event_id,
        explanation, before_json, after_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      -- explanation is updatable because it describes the change rather than deciding anything, and a
      -- stale seed explanation could otherwise never be corrected. kind and the before/after payload
      -- stay immutable: those are what the person actually approved.
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, explanation = excluded.explanation
    `).run(
      change.id, change.ownerId, change.workspaceId, change.planVersionId, change.kind,
      change.triggerEventId, change.explanation,
      change.before === undefined ? null : JSON.stringify(change.before),
      change.after === undefined ? null : JSON.stringify(change.after), change.status
    );
  }

  listPlanChanges(workspaceId: string, planVersionId: string): StoredPlanChange[] {
    const rows = this.#db.prepare(
      "SELECT * FROM plan_changes WHERE workspace_id = ? AND plan_version_id = ? ORDER BY id"
    ).all(workspaceId, planVersionId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, ownerId: row.owner_id!, workspaceId: row.workspace_id!, planVersionId: row.plan_version_id!,
      kind: row.kind as StoredPlanChange["kind"], triggerEventId: row.trigger_event_id!, explanation: row.explanation!,
      ...(row.before_json ? { before: JSON.parse(row.before_json) } : {}),
      ...(row.after_json ? { after: JSON.parse(row.after_json) } : {}),
      status: row.status as StoredPlanChange["status"]
    }));
  }

  exportSnapshot(workspaceId: string): CrosslineSnapshot {
    const planVersions = this.listPlanVersions(workspaceId);
    // The typed fields below are the readable audit view; this raw dump is what a restore replays.
    // `events` and `milestones` are duplicated between the two on purpose: the typed copy parses
    // payloads for humans, the raw copy is what rebuilds the table without the importer needing to
    // know a single column name. `exportCoversEveryTable` keeps this list honest.
    const tableNames = [
      "events", "milestones",
      "captures",
      "milestone_relations",
      "work_orders", "executions", "evidence_claims", "plan_versions", "plan_changes",
      "materials",
      "energy_observations", "external_bindings",
      "capacity_commitments",
      // Consent state is part of the ledger: a restore that silently re-enables collection is not a restore.
      "settings",
      // `principals`/`workspaces` are not workspace-scoped rows themselves — a principal is scoped by
      // membership, a workspace by its own id — so they get the two exceptions below instead of the
      // uniform `WHERE workspace_id = ?` query the rest of this list uses.
      "principals", "workspaces", "workspace_members", "tailscale_bindings", "device_leases", "audit_events"
    ] as const;
    // `ORDER BY rowid` for the same reason `listEvents` uses it: without it SQLite may return rows in
    // any order, so two exports of an unchanged database would not compare equal.
    const scopedByWorkspaceId = (tableName: string) =>
      this.#db.prepare(`SELECT * FROM ${tableName} WHERE workspace_id = ? ORDER BY rowid`)
        .all(workspaceId) as Array<Record<string, string | number | null>>;
    const tableQueries: Record<string, () => Array<Record<string, string | number | null>>> = {
      workspaces: () => this.#db.prepare("SELECT * FROM workspaces WHERE id = ? ORDER BY rowid")
        .all(workspaceId) as Array<Record<string, string | number | null>>,
      principals: () => this.#db.prepare(
        "SELECT * FROM principals WHERE id IN (SELECT principal_id FROM workspace_members WHERE workspace_id = ?) ORDER BY rowid"
      ).all(workspaceId) as Array<Record<string, string | number | null>>
    };
    const tables: Record<string, Array<Record<string, string | number | null>>> = Object.fromEntries(
      tableNames.map((tableName) => [tableName, (tableQueries[tableName] ?? (() => scopedByWorkspaceId(tableName)))()])
    );
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      workspaceId,
      events: this.listEvents(workspaceId),
      milestones: this.listMilestones(workspaceId),
      capacityCommitments: this.listCapacityCommitments(workspaceId),
      workOrders: this.listWorkOrders(workspaceId),
      milestoneRelations: this.listMilestoneRelations(workspaceId),
      planVersions,
      planChanges: planVersions.flatMap((plan) => this.listPlanChanges(workspaceId, plan.id)),
      energyObservations: this.listEnergyObservations(workspaceId),
      tables
    };
  }

  /**
   * The sync cursor for one external collection.
   *
   * Stored per (provider, collection) rather than per item: a delta cursor describes a whole stream, and
   * losing it means a full re-read rather than a lost row.
   */
  saveSyncCursor(input: { ownerId: string; workspaceId: string; provider: string; collection: string; cursor: string | null }): void {
    this.#db.prepare(`
      INSERT INTO external_bindings (id, owner_id, workspace_id, provider, external_id, etag, sync_cursor, mode, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 'read_only', ?)
      ON CONFLICT(workspace_id, provider, external_id) DO UPDATE SET
        sync_cursor = excluded.sync_cursor, updated_at = excluded.updated_at
    `).run(`${input.workspaceId}:${input.provider}:${input.collection}`, input.ownerId, input.workspaceId,
      input.provider, input.collection, input.cursor, new Date().toISOString());
  }

  readSyncCursor(workspaceId: string, provider: string, collection: string): string | null {
    const row = this.#db.prepare(
      "SELECT sync_cursor FROM external_bindings WHERE workspace_id = ? AND provider = ? AND external_id = ?"
    ).get(workspaceId, provider, collection) as { sync_cursor?: string | null } | undefined;
    return row?.sync_cursor ?? null;
  }

  /**
   * Resolves one plan change so an approval is not blocked forever.
   *
   * `approvePlanVersion` refuses while a `conflict` change is pending, and until now nothing could move
   * one out of `pending` — so a single conflict made the plan permanently unapprovable. Excluding is a
   * decision the person makes and the ledger records; it does not delete the change.
   */
  resolvePlanChange(workspaceId: string, ownerId: string, changeId: string, status: "approved" | "excluded",
    idempotencyKey: string, expected?: { plan: StoredPlanVersion; change: StoredPlanChange }): { changed: boolean } {
    // Check-then-act: two callers could both read `pending` and both append a resolution event.
    return this.#db.transaction(() => {
      const row = this.#db.prepare(
        "SELECT plan_version_id, status FROM plan_changes WHERE workspace_id = ? AND id = ?"
      ).get(workspaceId, changeId) as { plan_version_id?: string; status?: string } | undefined;
      if (!row || row.status !== "pending") return { changed: false };
      if (expected) {
        const currentPlan = this.listPlanVersions(workspaceId)[0];
        const currentChange = this.listPlanChanges(workspaceId, row.plan_version_id!).find((item) => item.id === changeId);
        if (!currentPlan || currentPlan.id !== row.plan_version_id || currentPlan.status !== "draft"
          || JSON.stringify(currentPlan) !== JSON.stringify(expected.plan)
          || JSON.stringify(currentChange) !== JSON.stringify(expected.change))
          throw new Error("PROPOSAL_VERSION_CHANGED");
      }
      this.#db.prepare("UPDATE plan_changes SET status = ? WHERE workspace_id = ? AND id = ?")
        .run(status, workspaceId, changeId);
      this.appendEvent({
        ownerId, workspaceId, idempotencyKey,
        type: "plan_change.resolved", entityId: changeId,
        payload: { status, planVersionId: row.plan_version_id }
      });
      return { changed: true };
    })["immediate"]();
  }

  /** Every real table in this database, so the restore path can validate against reality. */
  tableNames(): string[] {
    return (this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>).map((row) => row.name);
  }

  #columnsOf(tableName: string): string[] {
    return (this.#db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
  }

  /**
   * Rebuilds a workspace from a snapshot. This is the other half of `exportSnapshot`: a backup nobody
   * has ever restored is not a backup, it is a file.
   *
   * Restore is only ever a rebuild into an empty workspace. Merging into live rows would be
   * indistinguishable from silent corruption, and the one thing a restore must not do is damage the
   * ledger it exists to protect — so the refusal lives here, in the only code that can write, rather
   * than in a script that could be bypassed by calling this directly.
   */
  importSnapshot(snapshot: CrosslineSnapshot): Record<string, number> {
    if (snapshot.schemaVersion !== 2) throw new Error("RESTORE_SCHEMA_UNSUPPORTED");
    // A snapshot is a file read off disk, so its table and column names are untrusted input that would
    // otherwise be interpolated straight into SQL.
    const known = new Set(this.tableNames());
    const retired: Set<string> = new Set(RETIRED_TABLES);
    for (const [tableName, rows] of Object.entries(snapshot.tables)) {
      // A backup taken before migration 4 still lists the six tables that never carried a row. An
      // empty one is stepped over; one with rows is not, because the assumption behind dropping them
      // would have been wrong and skipping it would lose data without saying so.
      if (!known.has(tableName) && retired.has(tableName)) {
        if (rows.length) throw new Error("RESTORE_RETIRED_TABLE_NOT_EMPTY");
        continue;
      }
      if (!known.has(tableName)) throw new Error("RESTORE_UNKNOWN_TABLE");
      const columns = this.#columnsOf(tableName);
      const occupied = columns.includes("workspace_id")
        ? this.#db.prepare(`SELECT 1 FROM ${tableName} WHERE workspace_id = ? LIMIT 1`).get(snapshot.workspaceId)
        : this.#db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get();
      if (occupied) throw new Error("RESTORE_TARGET_NOT_EMPTY");
    }

    const counts: Record<string, number> = {};
    this.#db.transaction(() => {
      // Rows are replayed in whatever order the snapshot lists them, so foreign keys are checked once
      // at commit instead of demanding the importer know the dependency order between tables.
      this.#db.pragma("defer_foreign_keys = ON");
      for (const [tableName, rows] of Object.entries(snapshot.tables)) {
        if (!known.has(tableName)) continue;
        counts[tableName] = rows.length;
        const first = rows[0];
        if (!first) continue;
        const allowed = new Set(this.#columnsOf(tableName));
        // A snapshot older than a migration that dropped a column still carries it. Dropping it from
        // the insert is only safe while every row's value is empty — otherwise the migration threw
        // away something real, and refusing the restore is the correct way to find that out.
        const columns = Object.keys(first).filter((column) => {
          if (allowed.has(column)) return true;
          const retiredHere: readonly string[] = RETIRED_COLUMNS[tableName] ?? [];
          if (!retiredHere.includes(column)) throw new Error("RESTORE_UNKNOWN_COLUMN");
          if (rows.some((row) => row[column] !== null && row[column] !== undefined)) {
            throw new Error("RESTORE_RETIRED_COLUMN_NOT_EMPTY");
          }
          return false;
        });
        const statement = this.#db.prepare(
          `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
        );
        for (const row of rows) statement.run(columns.map((column) => row[column] ?? null));
      }
    })();
    return counts;
  }

  getPrincipalByBetterAuthId(betterAuthUserId: string): StoredPrincipal | undefined {
    const row = this.#db.prepare("SELECT * FROM principals WHERE better_auth_user_id = ?")
      .get(betterAuthUserId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return { id: row.id!, betterAuthUserId: row.better_auth_user_id!, createdAt: row.created_at! };
  }

  getWorkspaceMembership(principalId: string, workspaceId: string): StoredWorkspaceMember | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM workspace_members WHERE principal_id = ? AND workspace_id = ?"
    ).get(principalId, workspaceId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      principalId: row.principal_id!, workspaceId: row.workspace_id!,
      role: row.role as StoredWorkspaceMember["role"], createdAt: row.created_at!
    };
  }

  /**
   * One lease per `(workspace, device)` — re-issuing (the offline workbench renews on every successful
   * sync) replaces the existing row rather than accumulating one per login, which is what the table's
   * own `UNIQUE(workspace_id, device_id)` constraint already enforces at the schema level.
   */
  issueDeviceLease(lease: { id: string; principalId: string; workspaceId: string; deviceId: string;
    issuedAt: string; expiresAt: string }): StoredDeviceLease {
    this.#db.prepare(`
      INSERT INTO device_leases (id, principal_id, workspace_id, device_id, issued_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace_id, device_id) DO UPDATE SET
        id = excluded.id, principal_id = excluded.principal_id,
        issued_at = excluded.issued_at, expires_at = excluded.expires_at, revoked_at = NULL
    `).run(lease.id, lease.principalId, lease.workspaceId, lease.deviceId, lease.issuedAt, lease.expiresAt);
    return { ...lease };
  }

  getDeviceLease(workspaceId: string, deviceId: string): StoredDeviceLease | undefined {
    const row = this.#db.prepare(
      "SELECT * FROM device_leases WHERE workspace_id = ? AND device_id = ?"
    ).get(workspaceId, deviceId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    return {
      id: row.id!, principalId: row.principal_id!, workspaceId: row.workspace_id!, deviceId: row.device_id!,
      issuedAt: row.issued_at!, expiresAt: row.expires_at!, ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
    };
  }

  revokeDeviceLease(workspaceId: string, deviceId: string): { changed: boolean } {
    const result = this.#db.prepare(
      "UPDATE device_leases SET revoked_at = ? WHERE workspace_id = ? AND device_id = ? AND revoked_at IS NULL"
    ).run(new Date().toISOString(), workspaceId, deviceId);
    return { changed: result.changes > 0 };
  }

  /** One binding per `(workspace, tailscaleLogin)` — clicking "信任这个 Tailscale 身份" again for the same
   * login updates the existing row (e.g. a later request happened to carry `nodeKey` where an earlier
   * one could not) rather than accumulating duplicates. */
  saveTailscaleBinding(binding: { id: string; principalId: string; workspaceId: string; tailscaleLogin: string;
    nodeKey?: string; createdAt: string }): StoredTailscaleBinding {
    this.#db.prepare(`
      INSERT INTO tailscale_bindings (id, principal_id, workspace_id, tailscale_login, node_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, tailscale_login) DO UPDATE SET
        id = excluded.id, principal_id = excluded.principal_id, node_key = excluded.node_key
    `).run(binding.id, binding.principalId, binding.workspaceId, binding.tailscaleLogin, binding.nodeKey ?? null, binding.createdAt);
    return { ...binding };
  }

  listTailscaleBindings(workspaceId: string): StoredTailscaleBinding[] {
    const rows = this.#db.prepare(
      "SELECT * FROM tailscale_bindings WHERE workspace_id = ? ORDER BY created_at"
    ).all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, principalId: row.principal_id!, workspaceId: row.workspace_id!,
      tailscaleLogin: row.tailscale_login!, createdAt: row.created_at!,
      ...(row.node_key ? { nodeKey: row.node_key } : {})
    }));
  }

  revokeTailscaleBinding(workspaceId: string, tailscaleLogin: string): { changed: boolean } {
    const result = this.#db.prepare(
      "DELETE FROM tailscale_bindings WHERE workspace_id = ? AND tailscale_login = ?"
    ).run(workspaceId, tailscaleLogin);
    return { changed: result.changes > 0 };
  }

  listWorkspaces(): StoredWorkspace[] {
    const rows = this.#db.prepare("SELECT * FROM workspaces ORDER BY created_at, id")
      .all() as Array<Record<string, string>>;
    return rows.map((row) => ({ id: row.id!, name: row.name!, createdAt: row.created_at! }));
  }

  /**
   * The worker runs as a background job with no request/session of its own, so it cannot get an
   * `AccessContext` from `requireAccessContext` — it loops `listWorkspaces()` and needs the owner
   * principal for each one to attribute the events it appends. Every workspace has exactly one owner
   * member (no invite path exists yet), so this is that row's `principal_id`.
   */
  getWorkspaceOwnerId(workspaceId: string): string | undefined {
    const row = this.#db.prepare(
      "SELECT principal_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1"
    ).get(workspaceId) as { principal_id?: string } | undefined;
    return row?.principal_id;
  }

  /**
   * The only place a principal or a workspace is ever created. Keyed on the Better Auth user id so a
   * second call for the same account — a repeated login, a retried request — returns the existing
   * principal and its existing owner workspace rather than minting a second one. Every login stays a
   * single-owner personal workspace by design; there is no invite path that adds a second member.
   */
  createPrincipalWithWorkspace(betterAuthUserId: string, workspaceName: string):
    { principal: StoredPrincipal; workspace: StoredWorkspace } {
    return this.#db.transaction(() => {
      const existing = this.getPrincipalByBetterAuthId(betterAuthUserId);
      if (existing) {
        const membership = this.#db.prepare(
          "SELECT workspace_id FROM workspace_members WHERE principal_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1"
        ).get(existing.id) as { workspace_id: string } | undefined;
        if (!membership) throw new Error("PRINCIPAL_WITHOUT_OWNER_WORKSPACE");
        const workspaceRow = this.#db.prepare("SELECT * FROM workspaces WHERE id = ?")
          .get(membership.workspace_id) as Record<string, string>;
        return {
          principal: existing,
          workspace: { id: workspaceRow.id!, name: workspaceRow.name!, createdAt: workspaceRow.created_at! }
        };
      }
      const now = new Date().toISOString();
      const principal: StoredPrincipal = { id: randomUUID(), betterAuthUserId, createdAt: now };
      const workspace: StoredWorkspace = { id: randomUUID(), name: workspaceName, createdAt: now };
      this.#db.prepare("INSERT INTO principals (id, better_auth_user_id, created_at) VALUES (?, ?, ?)")
        .run(principal.id, principal.betterAuthUserId, principal.createdAt);
      this.#db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
        .run(workspace.id, workspace.name, workspace.createdAt);
      this.#db.prepare(
        "INSERT INTO workspace_members (principal_id, workspace_id, role, created_at) VALUES (?, ?, 'owner', ?)"
      ).run(principal.id, workspace.id, now);
      return { principal, workspace };
    })();
  }

  appendAuditEvent(event: Omit<StoredAuditEvent, "id" | "createdAt">): StoredAuditEvent {
    const record: StoredAuditEvent = { ...event, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#db.prepare(`
      INSERT INTO audit_events
        (id, principal_id, workspace_id, role, auth_method, request_id, idempotency_key,
         codex_thread_id, codex_turn_id, codex_call_id, action, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.principalId, record.workspaceId, record.role, record.authMethod, record.requestId,
      record.idempotencyKey ?? null, record.codexThreadId ?? null, record.codexTurnId ?? null,
      record.codexCallId ?? null, record.action, JSON.stringify(record.payload), record.createdAt
    );
    return record;
  }

  close(): void {
    this.#db.close();
  }
}
