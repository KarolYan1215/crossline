import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { CrosslineStore } from "./index";

/**
 * Migration 14 (docs/loop-and-scout.md §1): the plan is one current row that calendar sync updates in place, and plan approval is gone.
 * The old differences are not thrown away: each becomes a `plan.change_archived` event, each older plan version a
 * `plan.version_archived` event, then the table is dropped.
 */
test("migration 14 archives plan changes and older plan versions as events and keeps one current plan row", () => {
  const path = `crossline-test-${randomUUID()}.db`;
  try {
    new CrosslineStore(path).close();
    // Back to the shape before migration 14, written with a raw connection: the store no longer creates `plan_changes`.
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE plan_changes (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      plan_version_id TEXT NOT NULL, kind TEXT NOT NULL, trigger_event_id TEXT NOT NULL,
      explanation TEXT NOT NULL, before_json TEXT, after_json TEXT, status TEXT NOT NULL);`);
    const version = legacy.prepare("INSERT INTO plan_versions (id, owner_id, workspace_id, version, status, payload_json, created_at) VALUES (?, 'o1', 'w1', ?, ?, ?, ?)");
    version.run("plan-v1", 1, "approved", JSON.stringify({ blocks: [{ id: "a" }] }), "2026-10-01T00:00:00.000Z");
    version.run("plan-v2", 2, "draft", JSON.stringify({ blocks: [{ id: "b" }] }), "2026-10-02T00:00:00.000Z");
    const change = legacy.prepare("INSERT INTO plan_changes VALUES (?, 'o1', 'w1', 'plan-v2', ?, 'evt-1', ?, ?, ?, 'pending')");
    change.run("chg-1", "conflict", "日历中已不存在", JSON.stringify({ id: "a" }), null);
    change.run("chg-2", "add", "新会议", null, JSON.stringify({ id: "b" }));
    legacy.pragma("user_version = 13");
    legacy.close();

    const store = new CrosslineStore(path);
    try {
      const raw = new Database(path, { readonly: true });
      expect((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_changes'").get())).toBeUndefined();
      raw.close();
      const archived = store.listEvents("w1", { type: "plan.change_archived" });
      expect(archived).toHaveLength(2);
      expect(archived.map((event) => (event.payload as { explanation: string }).explanation).sort()).toEqual(["新会议", "日历中已不存在"]);
      expect((archived.find((event) => (event.payload as { id: string }).id === "chg-1")!.payload as { before: unknown }).before).toEqual({ id: "a" });
      expect(store.listEvents("w1", { type: "plan.version_archived" })).toHaveLength(1);
      const plans = store.listPlanVersions("w1");
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ id: "plan-v2", status: "current" });
    } finally { store.close(); }
  } finally {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}.v13.bak`]) if (existsSync(file)) rmSync(file);
  }
});

test("a new database never creates plan_changes", () => {
  const store = new CrosslineStore(":memory:");
  try {
    expect(store.tableNames()).not.toContain("plan_changes");
  } finally { store.close(); }
});
