import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { CrosslineStore } from "./index";
import { condenseEventTypes } from "./event-condense";

type Row = { event_id: string; workspace_id: string; type: string; entity_id: string; payload_json: string };

/** Migration 28 (docs/plans/condense-1127.md §C): old event names become their family plus a discriminator; ticks leave the ledger. */
test("migration 28 condenses each family, deletes ticks, leaves kept types alone and is idempotent", () => {
  const path = `crossline-test-${randomUUID()}.db`;
  try {
    new CrosslineStore(path).close();
    const legacy = new Database(path);
    const insert = legacy.prepare("INSERT INTO events (event_id, owner_id, workspace_id, idempotency_key, type, entity_id, payload_json, created_at) VALUES (?, 'o', ?, ?, ?, ?, ?, '2026-11-01T00:00:00.000Z')");
    const rows: Array<[string, string, string, string, unknown]> = [
      ["e1", "w", "agent.task.requested", "t1", { taskId: "t1", title: "x" }],
      ["e2", "w", "estimate.adjusted", "wo-1", { before: 60, after: 120 }],
      ["e3", "w", "diligence.decided", "d1", { decision: "pass", note: "ok" }],
      ["e4", "w", "archetypes.curated", "w", { state: "partial", added: 2 }],
      ["e5", "w", "automation.changed", "a1", { field: "schedule" }],
      ["e6", "w", "automation.changed", "a2", { change: "deleted" }],
      ["e7", "w", "gate.attempted", "wo-1", { gate: "completion" }],
      ["e8", "w", "manualbook.progress", "wo-1", { step: 2 }],
      ["e9", "w", "capture.created", "c1", { text: "买书" }],
      ["e10", "w", "work_order.transitioned", "wo-1", { from: "draft", to: "approved" }],
      ["e11", "w", "milestone.revised", "m1", "scalar"],
      ["e12", "other", "agent.task.requested", "t2", { taskId: "t2" }]
    ];
    for (const [id, ws, type, entity, payload] of rows) insert.run(id, ws, id, type, entity, JSON.stringify(payload));
    legacy.pragma("user_version = 27");
    legacy.close();

    new CrosslineStore(path).close();
    expect(existsSync(`${path}.v27.bak`)).toBe(true);
    const db = new Database(path);
    const read = () => Object.fromEntries((db.prepare("SELECT event_id, workspace_id, type, entity_id, payload_json FROM events").all() as Row[])
      .map((row) => [row.event_id, { type: row.type, entityId: row.entity_id, payload: JSON.parse(row.payload_json) as unknown }]));
    const after = read();
    expect(after.e1).toEqual({ type: "agent.changed", entityId: "t1", payload: { taskId: "t1", title: "x", change: "task_requested" } });
    expect(after.e2).toEqual({ type: "person.decided", entityId: "wo-1", payload: { before: 60, after: 120, subject: "estimate", decision: "adjusted" } });
    // A payload's own `decision` is the person's answer and stays.
    expect(after.e3).toMatchObject({ type: "person.decided", payload: { decision: "pass", note: "ok", subject: "diligence" } });
    // A run's own `state` moves to `result`, so `state` can say how the job ended.
    expect(after.e4).toEqual({ type: "job.ran", entityId: "w", payload: { added: 2, result: "partial", job: "archetypes.curate", state: "done" } });
    // `automation.changed` kept its name: an old row gets `change`, a new one is left as it is.
    expect(after.e5).toMatchObject({ type: "automation.changed", payload: { field: "schedule", change: "edited" } });
    expect(after.e6).toMatchObject({ type: "automation.changed", payload: { change: "deleted" } });
    expect(after.e7).toBeUndefined();
    expect(after.e8).toBeUndefined();
    expect(after.e9).toEqual({ type: "capture.created", entityId: "c1", payload: { text: "买书" } });
    expect(after.e10).toEqual({ type: "work_order.transitioned", entityId: "wo-1", payload: { from: "draft", to: "approved" } });
    expect(after.e11).toEqual({ type: "milestone.changed", entityId: "m1", payload: { payload: "scalar", change: "revised" } });
    expect(after.e12).toMatchObject({ type: "agent.changed", payload: { change: "task_requested" } });

    expect(condenseEventTypes(db)).toEqual({ renamed: 0, deleted: 0 });
    expect(read()).toEqual(after);
    db.close();
  } finally {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}.v0.bak`, `${path}.v27.bak`]) if (existsSync(file)) rmSync(file);
  }
});

test("condensing one workspace (a snapshot being imported) leaves the others alone", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events (event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)");
  insert.run("a", "w1", "insight.rejected", "{}");
  insert.run("b", "w2", "insight.rejected", "{}");
  insert.run("c", "w1", "gate.attempted", "{}");
  insert.run("d", "w2", "gate.attempted", "{}");
  expect(condenseEventTypes(db, "w1")).toEqual({ renamed: 1, deleted: 1 });
  expect(db.prepare("SELECT event_id, type, payload_json FROM events ORDER BY event_id").all()).toEqual([
    { event_id: "a", type: "insight.changed", payload_json: '{"change":"rejected"}' },
    { event_id: "b", type: "insight.rejected", payload_json: "{}" },
    { event_id: "d", type: "gate.attempted", payload_json: "{}" }]);
  db.close();
});

test("a payload's own `change` is kept as `priorChange`, not overwritten", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events (event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL)");
  db.prepare("INSERT INTO events VALUES (?, ?, ?, ?)").run("a", "w1", "insight.rejected", '{"change":"x"}');
  condenseEventTypes(db, "w1");
  expect(JSON.parse((db.prepare("SELECT payload_json FROM events").get() as { payload_json: string }).payload_json)).toEqual({ change: "rejected", priorChange: "x" });
  db.close();
});
