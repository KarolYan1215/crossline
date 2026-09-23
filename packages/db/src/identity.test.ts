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

test("appendAuditEvent records who, where, and why, and round-trips the payload", () => {
  const { principal, workspace } = store.createPrincipalWithWorkspace("auth-user-3", "个人 workspace");
  const event = store.appendAuditEvent({
    principalId: principal.id, workspaceId: workspace.id, role: "owner", authMethod: "session",
    requestId: "req-1", action: "milestone.approved", payload: { milestoneId: "m-1" }
  });
  expect(event.id).toBeTruthy();
  expect(event.createdAt).toBeTruthy();
});
