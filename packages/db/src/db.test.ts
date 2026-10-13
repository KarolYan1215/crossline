import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CrosslineStore } from "./index";

let path = "";

beforeEach(() => {
  path = `crossline-test-${randomUUID()}.db`;
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm", ".v1.bak", ".pre-r2.bak", ".v0.bak", ".v2.bak", ".v3.bak"]) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) rmSync(file);
  }
});

describe("event ledger", () => {
  test("records an idempotent state transition once", () => {
    const store = new CrosslineStore(path);
    const first = store.appendEvent({
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      idempotencyKey: "command-1",
      type: "task.created",
      entityId: "task-1",
      payload: { title: "Write paper" }
    });
    const duplicate = store.appendEvent({
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      idempotencyKey: "command-1",
      type: "task.created",
      entityId: "task-1",
      payload: { title: "Write paper" }
    });
    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ inserted: false, eventId: first.eventId });
    expect(store.listEvents("workspace-1")).toHaveLength(1);
    store.close();
  });

  test("stores versioned milestones", () => {
    const store = new CrosslineStore(path);
    store.saveMilestone({
      id: "media-q3",
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      identityId: "media",
      title: "建立可复用内容生产节奏",
      version: 1,
      status: "approved"
    });
    expect(store.listMilestones("workspace-1")).toEqual([expect.objectContaining({
      id: "media-q3",
      version: 1,
      status: "approved"
    })]);
    store.close();
  });

  test("exports a scoped, round-trip-safe snapshot", () => {
    const store = new CrosslineStore(path);
    store.appendEvent({
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      idempotencyKey: "export-1",
      type: "work_order.created",
      entityId: "work-order-4",
      payload: { title: "Export me" }
    });
    store.saveWorkOrder({
      id: "work-order-4", ownerId: "owner-1", workspaceId: "workspace-1", identityId: "research",
      projectId: "project-1", milestoneId: "milestone-1", intent: "Export me", state: "ready_for_human",
      riskTier: "milestone", estimate: {
        p25Minutes: 30, p50Minutes: 45, p85Minutes: 60,
        source: "identity_prior", observationCount: 0, confidence: "low"
      }, payload: { humanCore: [{ energy: "high", interruptible: false }] }
    });
    const snapshot = store.exportSnapshot("workspace-1");
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.workspaceId).toBe("workspace-1");
    expect("tasks" in snapshot).toBe(false);
    expect(snapshot.events).toEqual([expect.objectContaining({ idempotencyKey: "export-1" })]);
    expect(snapshot.tables.tasks).toBeUndefined();
    expect(snapshot.tables.work_orders).toEqual([expect.objectContaining({ id: "work-order-4", intent: "Export me" })]);
    expect(() => JSON.parse(JSON.stringify(snapshot))).not.toThrow();
    store.close();
  });

  test.each([[1, ".v1.bak"], [2, ".pre-r2.bak"]] as const)("consumes a private v%s task table into work orders and capacity commitments", (version, backupSuffix) => {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        identity_id TEXT NOT NULL, title TEXT NOT NULL, milestone_id TEXT,
        contribution REAL NOT NULL, expected_minutes INTEGER NOT NULL,
        energy TEXT NOT NULL, interruptible INTEGER NOT NULL, switching_cost REAL NOT NULL,
        status TEXT NOT NULL, source_kind TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO tasks VALUES (
        'health-1', 'owner-1', 'workspace-1', 'health', '准备晚饭', NULL,
        1, 25, 'low', 1, 0, 'ready', 'local', '2026-09-14T00:00:00.000Z'
      );
      INSERT INTO tasks VALUES (
        'research-1', 'owner-1', 'workspace-1', 'research', '整理论文', 'm-1',
        8, 60, 'high', 0, 3, 'ready', 'local', '2026-09-14T00:00:00.000Z'
      );
    `);
    legacy.pragma(`user_version = ${version}`);
    legacy.close();

    const store = new CrosslineStore(path);
    // The migration runner advances it; the old code wrote 2 unconditionally and gated nothing on it.
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(3);
    expect(store.listCapacityCommitments("workspace-1")).toEqual([
      expect.objectContaining({
        id: "health-1",
        title: "准备晚饭",
        minimumMinutes: 25,
        sourceTaskId: "health-1"
      })
    ]);
    expect(store.listWorkOrders("workspace-1")).toEqual([
      expect.objectContaining({
        id: "research-1",
        identityId: "research",
        estimate: { p25Minutes: 60, p50Minutes: 60, p85Minutes: 60, source: "legacy_task", observationCount: 0, confidence: "low" }
      })
    ]);
    expect(existsSync(`${path}${backupSuffix}`)).toBe(true);
    store.close();
    const migrated = new Database(path, { readonly: true });
    expect(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()).toBeUndefined();
    migrated.close();
  });

  test("persists v2 work orders with interval estimates", () => {
    const store = new CrosslineStore(path);
    store.saveWorkOrder({
      id: "wo-1", ownerId: "owner-1", workspaceId: "workspace-1", identityId: "research",
      projectId: "project-1", milestoneId: "milestone-1", intent: "准备组会材料", state: "captured",
      riskTier: "milestone",
      estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 50, source: "identity_prior", observationCount: 0, confidence: "low" },
      payload: { automationParts: [], humanCore: [] }
    });
    expect(store.listWorkOrders("workspace-1")).toEqual([
      expect.objectContaining({ id: "wo-1", state: "captured", estimate: expect.objectContaining({ p85Minutes: 50 }) })
    ]);
    store.close();
  });

  test("stores one current plan row and updates it in place", () => {
    const store = new CrosslineStore(path);
    store.savePlanVersion({ id: "plan-1", ownerId: "owner-1", workspaceId: "workspace-1", version: 1, status: "current", payload: { blocks: [] } });
    store.savePlanVersion({ id: "plan-1", ownerId: "owner-1", workspaceId: "workspace-1", version: 1, status: "current", payload: { blocks: [{ id: "a" }] } });
    expect(store.listPlanVersions("workspace-1")).toEqual([expect.objectContaining({ id: "plan-1", status: "current", payload: { blocks: [{ id: "a" }] } })]);
    store.close();
  });

  test("stores cyclic milestone relations without treating them as a workflow DAG", () => {
    const store = new CrosslineStore(path);
    // Claiming approval without evidence is silently demoted: a relation that decides things has to
    // point at something observed.
    store.saveMilestoneRelation({
      id: "relation-a", ownerId: "owner-1", workspaceId: "workspace-1",
      fromMilestoneId: "research-m", toMilestoneId: "media-m", kind: "reuses", status: "approved"
    });
    store.saveMilestoneRelation({
      id: "relation-b", ownerId: "owner-1", workspaceId: "workspace-1",
      fromMilestoneId: "media-m", toMilestoneId: "research-m", kind: "recurring_feedback", status: "approved",
      evidence: [{ uri: "file:///notes/reuse.md", source: "execution", observedAt: "2026-09-14T00:00:00.000Z" }],
      costMinutes: 45, lastValidatedAt: "2026-09-14T00:00:00.000Z"
    });
    expect(store.listMilestoneRelations("workspace-1")).toEqual([
      expect.objectContaining({ fromMilestoneId: "research-m", status: "candidate", evidence: [] }),
      expect.objectContaining({ fromMilestoneId: "media-m", status: "approved", costMinutes: 45 })
    ]);
    // A refuted relation stays visible — the flywheel needs its negative results.
    store.saveMilestoneRelation({
      id: "relation-b", ownerId: "owner-1", workspaceId: "workspace-1",
      fromMilestoneId: "media-m", toMilestoneId: "research-m", kind: "recurring_feedback", status: "refuted",
      evidence: [{ uri: "file:///notes/reuse.md", source: "execution", observedAt: "2026-09-14T00:00:00.000Z" }],
      counterexample: [{ note: "复用后反而增加了返工", observedAt: "2026-09-15T00:00:00.000Z" }]
    });
    expect(store.listMilestoneRelations("workspace-1").find((r) => r.id === "relation-b"))
      .toMatchObject({ status: "refuted", counterexample: [{ note: "复用后反而增加了返工" }] });
    store.close();
  });

  test("persists only aggregate self-reported energy observations", () => {
    const store = new CrosslineStore(path);
    store.saveEnergyObservation({
      id: "energy-1", ownerId: "owner-1", workspaceId: "workspace-1",
      source: "self_report", level: "medium", confidence: "high",
      aggregate: { responseSeconds: 4 }, observedAt: "2026-09-14T12:00:00.000Z"
    });
    // The camera path is gone, so no observation can carry an expiry and nothing needs purging.
    expect(store.listEnergyObservations("workspace-1")).toEqual([
      expect.objectContaining({ id: "energy-1", source: "self_report", level: "medium", aggregate: { responseSeconds: 4 } })
    ]);
    expect(JSON.stringify(store.listEnergyObservations("workspace-1"))).not.toContain("expiresAt");
    store.close();
  });
});

test("a pending migration backs the file up first and advances the version once", () => {
  const path = join(tmpdir(), `crossline-migrate-${process.pid}-${Date.now()}.db`);
  try {
    // A database left at the level the probe-based code used to write unconditionally.
    const stale = new Database(path);
    stale.pragma("user_version = 2");
    stale.exec("CREATE TABLE events (event_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(workspace_id, idempotency_key))");
    stale.prepare("INSERT INTO events VALUES ('e1','o','w','k','capture.created','c','{}','2026-01-01T00:00:00.000Z')").run();
    stale.close();

    const store = new CrosslineStore(path);
    // Every rebuild before this ran against the live file with no way back: the only backup the old
    // code took was on the legacy-tasks path, which a v2 database has already been through.
    expect(existsSync(`${path}.v2.bak`)).toBe(true);
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(3);
    expect(store.listEvents("w")).toHaveLength(1);
    store.close();

    // Re-opening is a no-op: nothing pending, so no second backup and no second run.
    rmSync(`${path}.v2.bak`, { force: true });
    const reopened = new CrosslineStore(path);
    expect(existsSync(`${path}.v2.bak`)).toBe(false);
    reopened.close();
  } finally {
    // Windows releases the file handle a moment after `close()`, so a failed unlink here is the
    // operating system being slow, not the migration being wrong.
    for (const suffix of ["", "-wal", "-shm", ".v2.bak"]) {
      try { rmSync(`${path}${suffix}`, { force: true }); } catch { /* temp dir, next run overwrites */ }
    }
  }
});

test("a retired table stays gone after the database is closed and opened again", () => {
  // The bug this pins: migration 4 dropped six tables and the base DDL, which runs on every open,
  // created them all back. The live ledger sat at user_version 4 with every one of them present for
  // a whole phase. Nothing caught it because every round-trip assertion compares against
  // `tableNames()`, which agreed with itself whichever way the schema went — only a check against
  // the names themselves can fail here.
  const retired = ["outbox", "identities", "projects", "milestone_versions", "insight_proposals", "skill_versions"];
  const path = `crossline-test-${randomUUID()}.db`;
  try {
    new CrosslineStore(path).close();
    // Shaped like a database that recorded version 4 while the base DDL was still recreating the
    // tables. Written with a raw connection on purpose: the store has no escape hatch for this, and
    // adding one to production code so a test can reach in would be the wrong trade.
    const raw = new Database(path);
    for (const table of retired) raw.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY)`);
    raw.pragma("user_version = 4");
    raw.close();

    const reopened = new CrosslineStore(path);
    expect(reopened.tableNames().filter((name) => retired.includes(name))).toEqual([]);
    reopened.close();

    const third = new CrosslineStore(path);
    expect(third.tableNames().filter((name) => retired.includes(name))).toEqual([]);
    third.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm", ".v0.bak", ".v4.bak"]) {
      if (existsSync(`${path}${suffix}`)) { try { rmSync(`${path}${suffix}`); } catch { /* Windows handle */ } }
    }
  }
});
