import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { CrosslineStore } from "./index";

const opened: Array<{ path: string; store: CrosslineStore }> = [];
const freshStore = (): CrosslineStore => {
  const path = `crossline-test-${randomUUID()}.db`;
  const store = new CrosslineStore(path);
  opened.push({ path, store });
  return store;
};

beforeEach(() => { opened.length = 0; });
afterEach(() => {
  // Closing here rather than at the end of each test: a failing assertion would otherwise leave the
  // handle open, and Windows refuses to delete an open file, turning one failure into a cascade.
  for (const { path, store } of opened) {
    try { store.close(); } catch { /* a test may have closed it already */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
    }
  }
});

const WORKSPACE = "workspace-1";
const OWNER = "owner-1";

/** A spread wide enough that the round trip has to carry JSON columns, NULL columns and FK targets. */
function populate(store: CrosslineStore): void {
  const event = store.appendEvent({
    ownerId: OWNER, workspaceId: WORKSPACE, idempotencyKey: "restore-1",
    type: "task.created", entityId: "work-order-1", payload: { title: "写论文", nested: { depth: 2 } }
  });
  store.capture({ id: "capture-1", ownerId: OWNER, workspaceId: WORKSPACE, title: "一个想法", context: "" }, "capture:1");
  for (const id of ["milestone-1", "milestone-2"]) {
    store.saveMilestone({
      id, ownerId: OWNER, workspaceId: WORKSPACE, identityId: "research",
      projectId: "project-1", title: `里程碑 ${id}`, version: 1, status: "approved"
    });
  }
  store.saveMilestoneRelation({
    id: "relation-1", ownerId: OWNER, workspaceId: WORKSPACE,
    fromMilestoneId: "milestone-1", toMilestoneId: "milestone-2",
    kind: "recurring_feedback", status: "candidate"
  });
  store.saveWorkOrder({
    id: "work-order-1", ownerId: OWNER, workspaceId: WORKSPACE, identityId: "research",
    projectId: "project-1", milestoneId: "milestone-1", intent: "Export me", state: "ready_for_human",
    riskTier: "milestone",
    estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 60, source: "identity_prior", observationCount: 0, confidence: "low" },
    payload: { humanCore: [{ energy: "high", interruptible: false }] }
  });
  store.savePlanVersion({ id: "plan-1", ownerId: OWNER, workspaceId: WORKSPACE, version: 1, status: "draft", payload: { blocks: [] } });
  // `before`/`after` are omitted on purpose: they become NULL columns, which a naive importer drops.
  store.savePlanChange({
    id: "change-1", ownerId: OWNER, workspaceId: WORKSPACE, planVersionId: "plan-1",
    kind: "add", triggerEventId: event.eventId, explanation: "种子", status: "pending"
  });
  store.saveEnergyObservation({
    id: "energy-1", ownerId: OWNER, workspaceId: WORKSPACE, source: "self_report",
    level: "high", confidence: "high", aggregate: { responseSeconds: 3 }, observedAt: "2026-09-15T10:00:00.000Z"
  });
  store.upsertDailyActivity({
    ownerId: OWNER, workspaceId: WORKSPACE, day: "2026-09-15",
    aggregate: { activeMinutes: 412 }, observedAt: "2026-09-15T23:00:00.000Z"
  });
  store.setSetting(WORKSPACE, "localActivity.consent", "granted");
}

test("the export carries every table in the schema, so a new table cannot escape the backup", () => {
  const store = freshStore();
  const snapshot = store.exportSnapshot(WORKSPACE);
  // Comparing against sqlite_master rather than a hand-kept list is the point: adding a table without
  // adding it to exportSnapshot fails here, instead of being discovered during a restore.
  expect(Object.keys(snapshot.tables).sort()).toEqual(store.tableNames().sort());
});

test("a snapshot rebuilds an identical workspace in an empty database", () => {
  const source = freshStore();
  populate(source);
  const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot(WORKSPACE)));

  const restored = freshStore();
  const counts = restored.importSnapshot(snapshot);
  expect(counts.work_orders).toBe(1);
  expect(counts.events).toBe(source.listEvents().length);

  // Re-exporting is the real check: it proves the rebuilt rows drive the same reads, not merely that
  // some INSERT succeeded. `exportedAt` is the only field allowed to differ.
  const { exportedAt: _before, ...beforeRestore } = source.exportSnapshot(WORKSPACE);
  const { exportedAt: _after, ...afterRestore } = restored.exportSnapshot(WORKSPACE);
  expect(afterRestore).toEqual(beforeRestore);
  expect(restored.listWorkOrders(WORKSPACE)).toEqual(source.listWorkOrders(WORKSPACE));
  expect(restored.listEvents()).toEqual(source.listEvents());
  expect(restored.getSetting(WORKSPACE, "localActivity.consent")).toBe("granted");
});

test("restoring over a workspace that already has rows is refused, not merged", () => {
  const source = freshStore();
  populate(source);
  const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot(WORKSPACE)));

  const occupied = freshStore();
  occupied.capture({ id: "existing", ownerId: OWNER, workspaceId: WORKSPACE, title: "别覆盖我", context: "" }, "capture:existing");
  expect(() => occupied.importSnapshot(snapshot)).toThrow("RESTORE_TARGET_NOT_EMPTY");
  // The refusal must leave the target exactly as it was, or it is just a slower kind of clobbering.
  expect(occupied.listCaptures(WORKSPACE).map((capture) => capture.id)).toEqual(["existing"]);
  expect(occupied.listWorkOrders(WORKSPACE)).toEqual([]);
});

test("a snapshot from a different schema version is refused rather than half-applied", () => {
  const store = freshStore();
  const snapshot = { ...store.exportSnapshot(WORKSPACE), schemaVersion: 3 as unknown as 2 };
  expect(() => store.importSnapshot(snapshot)).toThrow("RESTORE_SCHEMA_UNSUPPORTED");
});

test("table names in the snapshot are validated instead of reaching SQL", () => {
  const store = freshStore();
  const snapshot = store.exportSnapshot(WORKSPACE);
  snapshot.tables["work_orders; DROP TABLE events"] = [];
  expect(() => store.importSnapshot(snapshot)).toThrow("RESTORE_UNKNOWN_TABLE");
  expect(store.tableNames()).toContain("events");
});
