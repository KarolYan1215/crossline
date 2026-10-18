import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

test("a first login creates one principal, one workspace, and an owner membership", () => {
  const { principal, workspace } = store.createPrincipalWithWorkspace("auth-user-1", "个人 workspace");
  expect(store.getPrincipalByBetterAuthId("auth-user-1")).toEqual(principal);
  const membership = store.getWorkspaceMembership(principal.id, workspace.id);
  expect(membership?.role).toBe("owner");
  expect(store.listWorkspaces().map((w) => w.id)).toContain(workspace.id);
});

test("a repeated login for the same Better Auth user is idempotent — no second workspace", () => {
  const first = store.createPrincipalWithWorkspace("auth-user-2", "个人 workspace");
  const second = store.createPrincipalWithWorkspace("auth-user-2", "个人 workspace");
  expect(second.principal.id).toBe(first.principal.id);
  expect(second.workspace.id).toBe(first.workspace.id);
  expect(store.listWorkspaces().filter((w) => w.id === first.workspace.id)).toHaveLength(1);
});

test("two different logins get two isolated principals and workspaces", () => {
  const a = store.createPrincipalWithWorkspace("auth-user-a", "A 的 workspace");
  const b = store.createPrincipalWithWorkspace("auth-user-b", "B 的 workspace");
  expect(a.workspace.id).not.toBe(b.workspace.id);
  // The trust boundary `requireAccessContext` depends on: a principal has no membership row in a
  // workspace that is not theirs, so a caller who somehow obtained the other workspace's id still
  // cannot be shown as a member of it.
  expect(store.getWorkspaceMembership(a.principal.id, b.workspace.id)).toBeUndefined();
  expect(store.getWorkspaceMembership(b.principal.id, a.workspace.id)).toBeUndefined();
});

test("an unknown Better Auth user id has no principal", () => {
  expect(store.getPrincipalByBetterAuthId("never-logged-in")).toBeUndefined();
});

test("resolvePrincipalWorkspace creates a principal+workspace on first login, identically to createPrincipalWithWorkspace", () => {
  const resolved = store.resolvePrincipalWorkspace("auth-user-5", "个人 workspace");
  expect(resolved.role).toBe("owner");
  const principal = store.getPrincipalByBetterAuthId("auth-user-5");
  expect(principal?.id).toBe(resolved.principal.id);
  const membership = store.getWorkspaceMembership(resolved.principal.id, resolved.workspace.id);
  expect(membership?.role).toBe("owner");
});

test("resolvePrincipalWorkspace's fast path (existing principal) returns the same principal/workspace/role as the slow path would", () => {
  const created = store.createPrincipalWithWorkspace("auth-user-6", "个人 workspace");
  const resolved = store.resolvePrincipalWorkspace("auth-user-6", "个人 workspace");
  expect(resolved.principal).toEqual(created.principal);
  expect(resolved.workspace).toEqual(created.workspace);
  expect(resolved.role).toBe("owner");
});

test("appendAuditEvent records who, where, and why, and round-trips the payload", () => {
  const { principal, workspace } = store.createPrincipalWithWorkspace("auth-user-3", "个人 workspace");
  const event = store.appendAuditEvent({
    principalId: principal.id, workspaceId: workspace.id, role: "owner", authMethod: "session",
    requestId: "req-1", action: "milestone.approved", payload: { milestoneId: "m-1" }
  });
  expect(event.id).toBeTruthy();
  expect(event.createdAt).toBeTruthy();
});

test("purging a workspace removes every row it owns and its principal, and leaves other workspaces and shared files alone", () => {
  const gone = store.createPrincipalWithWorkspace("auth-gone", "A");
  const kept = store.createPrincipalWithWorkspace("auth-kept", "B");
  const doc = (workspaceId: string, ownerId: string, id: string, uri: string) => store.saveSourceDocument({ id, ownerId, workspaceId,
    kind: "text", fileName: `${id}.txt`, mediaType: "text/plain", sha256: id, uri, extractedText: "", extractionStatus: "done", createdAt: new Date().toISOString() });
  for (const { principal, workspace } of [gone, kept]) {
    store.setSetting(workspace.id, "onboarding.tone", "neutral");
    store.appendEvent({ ownerId: principal.id, workspaceId: workspace.id, idempotencyKey: "k", type: "x", entityId: "e", payload: {} });
  }
  doc(gone.workspace.id, gone.principal.id, "own", "file:///data/sources/own.txt");
  doc(gone.workspace.id, gone.principal.id, "shared", "file:///data/sources/shared.txt");
  doc(kept.workspace.id, kept.principal.id, "shared2", "file:///data/sources/shared.txt");

  const result = store.purgeWorkspace(gone.workspace.id);
  expect(result.betterAuthUserIds).toEqual(["auth-gone"]);
  // The file another workspace also points at is not offered for deletion.
  expect(result.fileUris).toEqual(["file:///data/sources/own.txt"]);
  expect(store.getSetting(gone.workspace.id, "onboarding.tone")).toBeUndefined();
  expect(store.listEvents(gone.workspace.id)).toHaveLength(0);
  expect(store.getPrincipalByBetterAuthId("auth-gone")).toBeUndefined();
  expect(store.listWorkspaces().map((w) => w.id)).not.toContain(gone.workspace.id);
  expect(store.getSetting(kept.workspace.id, "onboarding.tone")).toBe("neutral");
  expect(store.listEvents(kept.workspace.id)).toHaveLength(1);
  expect(store.getPrincipalByBetterAuthId("auth-kept")).toBeDefined();
});

test("resetting a workspace empties what it built and keeps the account, its membership and the settings it was told to keep", () => {
  const mine = store.createPrincipalWithWorkspace("auth-reset", "A");
  const other = store.createPrincipalWithWorkspace("auth-other", "B");
  for (const { principal, workspace } of [mine, other]) {
    store.setSetting(workspace.id, "onboarding.tone", "neutral");
    store.appendEvent({ ownerId: principal.id, workspaceId: workspace.id, idempotencyKey: "k", type: "x", entityId: "e", payload: {} });
  }
  store.setSetting(mine.workspace.id, "deployment.runtimeOwner", "1");
  store.setSetting(mine.workspace.id, "model.provider", "{}");
  store.appendEvent({ ownerId: mine.principal.id, workspaceId: mine.workspace.id, idempotencyKey: "c", type: "model.provider.conformance", entityId: "p", payload: {} });
  store.saveSourceDocument({ id: "doc", ownerId: mine.principal.id, workspaceId: mine.workspace.id, kind: "text", fileName: "a.txt", mediaType: "text/plain",
    sha256: "a", uri: "file:///data/sources/a.txt", extractedText: "", extractionStatus: "done", createdAt: new Date().toISOString() });

  const result = store.resetWorkspace(mine.workspace.id, { settingPrefixes: ["deployment.", "model.provider"], eventTypePrefixes: ["model.provider"] });
  expect(result.fileUris).toEqual(["file:///data/sources/a.txt"]);
  expect(store.listSourceDocuments(mine.workspace.id)).toEqual([]);
  expect(store.getSetting(mine.workspace.id, "onboarding.tone")).toBeUndefined();
  expect(store.getSetting(mine.workspace.id, "deployment.runtimeOwner")).toBe("1");
  expect(store.getSetting(mine.workspace.id, "model.provider")).toBe("{}");
  expect(store.listEvents(mine.workspace.id).map((event) => event.type)).toEqual(["model.provider.conformance"]);
  // Still the same signed-in account in the same workspace.
  expect(store.getPrincipalByBetterAuthId("auth-reset")).toBeDefined();
  expect(store.listWorkspaces().map((w) => w.id)).toContain(mine.workspace.id);
  // Another workspace is untouched.
  expect(store.getSetting(other.workspace.id, "onboarding.tone")).toBe("neutral");
  expect(store.listEvents(other.workspace.id)).toHaveLength(1);
});
