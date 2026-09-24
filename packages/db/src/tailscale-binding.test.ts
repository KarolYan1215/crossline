import { afterEach, beforeEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

test("saving a binding without a node key stores it as absent, not a fake value", () => {
  const binding = store.saveTailscaleBinding({
    id: "bind-1", principalId: "p1", workspaceId: "w1", tailscaleLogin: "karolyan1215@gmail.com",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  expect(binding.nodeKey).toBeUndefined();
  const [stored] = store.listTailscaleBindings("w1");
  expect(stored).toMatchObject({ tailscaleLogin: "karolyan1215@gmail.com", principalId: "p1" });
  expect(stored?.nodeKey).toBeUndefined();
});

test("saving again for the same login in the same workspace updates in place", () => {
  store.saveTailscaleBinding({ id: "bind-1", principalId: "p1", workspaceId: "w1",
    tailscaleLogin: "karolyan1215@gmail.com", createdAt: "2026-01-01T00:00:00.000Z" });
  store.saveTailscaleBinding({ id: "bind-2", principalId: "p1", workspaceId: "w1",
    tailscaleLogin: "karolyan1215@gmail.com", nodeKey: "n-123", createdAt: "2026-01-02T00:00:00.000Z" });
  const bindings = store.listTailscaleBindings("w1");
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toMatchObject({ id: "bind-2", nodeKey: "n-123" });
});

test("the same login in a different workspace is a distinct binding", () => {
  store.saveTailscaleBinding({ id: "bind-1", principalId: "p1", workspaceId: "w1",
    tailscaleLogin: "karolyan1215@gmail.com", createdAt: "2026-01-01T00:00:00.000Z" });
  store.saveTailscaleBinding({ id: "bind-2", principalId: "p2", workspaceId: "w2",
    tailscaleLogin: "karolyan1215@gmail.com", createdAt: "2026-01-01T00:00:00.000Z" });
  expect(store.listTailscaleBindings("w1")).toHaveLength(1);
  expect(store.listTailscaleBindings("w2")).toHaveLength(1);
});

test("revoking removes the binding; a second revoke is a no-op rather than an error", () => {
  store.saveTailscaleBinding({ id: "bind-1", principalId: "p1", workspaceId: "w1",
    tailscaleLogin: "karolyan1215@gmail.com", createdAt: "2026-01-01T00:00:00.000Z" });
  expect(store.revokeTailscaleBinding("w1", "karolyan1215@gmail.com")).toEqual({ changed: true });
  expect(store.listTailscaleBindings("w1")).toEqual([]);
  expect(store.revokeTailscaleBinding("w1", "karolyan1215@gmail.com")).toEqual({ changed: false });
});

test("migration 6 rebuilds an old node_key-NOT-NULL table (empty, as this table has always been) rather than leaving it stuck", () => {
  const path = `crossline-test-${randomUUID()}.db`;
  try {
    // Shaped exactly like the schema before this stage — written with a raw connection, since the
    // current store code has no way to create the old NOT NULL column any more.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tailscale_bindings (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        tailscale_login TEXT NOT NULL, node_key TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(workspace_id, tailscale_login, node_key)
      );
    `);
    legacy.pragma("user_version = 5");
    legacy.close();

    const migrated = new CrosslineStore(path);
    expect(migrated.schemaVersion()).toBeGreaterThanOrEqual(6);
    // The real point of the migration: a binding with no node key can now actually be saved.
    expect(migrated.saveTailscaleBinding({ id: "bind-1", principalId: "p1", workspaceId: "w1",
      tailscaleLogin: "karolyan1215@gmail.com", createdAt: "2026-01-01T00:00:00.000Z" }).nodeKey).toBeUndefined();
    migrated.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm", ".v5.bak"]) {
      if (existsSync(`${path}${suffix}`)) { try { rmSync(`${path}${suffix}`); } catch { /* Windows handle */ } }
    }
  }
});
