import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { requireAccessContext, type CrosslineAuth } from "./index";

/**
 * `requireAccessContext`'s own logic — not Better Auth's session/cookie mechanics, which are Better
 * Auth's tested concern, not this repo's. A minimal fake stands in for the `auth.api` surface this
 * function actually calls; the real HTTP/cookie round trip is exercised manually (see the stage-two
 * verification steps in the plan) against a running dev server with a real browser session.
 */
function fakeAuth(session: { userId: string } | null, accounts: Array<{ providerId: string }> = [],
  onListUserAccounts?: () => void): CrosslineAuth {
  return {
    api: {
      getSession: async () => session ? { session: { userId: session.userId }, user: { id: session.userId, email: "x@example.com" } } : null,
      listUserAccounts: async () => { onListUserAccounts?.(); return accounts; }
    }
  } as unknown as CrosslineAuth;
}

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

describe("requireAccessContext", () => {
  test("no session is refused", async () => {
    const result = await requireAccessContext(fakeAuth(null), store, new Request("http://x/"));
    expect(result).toEqual({ error: "UNAUTHENTICATED" });
  });

  test("a first-time session creates the owner principal+workspace and returns a full AccessContext", async () => {
    const auth = fakeAuth({ userId: "auth-user-1" });
    const result = await requireAccessContext(auth, store, new Request("http://x/"));
    if ("error" in result) throw new Error(`expected ctx, got ${result.error}`);
    expect(result.ctx.role).toBe("owner");
    expect(result.ctx.authMethod).toBe("session");
    expect(result.ctx.identity.subject).toBe("auth-user-1");
    expect(result.ctx.identity.provider).toBe("credential");
    // The principal/workspace this created is now real in the store, reachable the same way stage
    // three's business routes will reach it.
    const principal = store.getPrincipalByBetterAuthId("auth-user-1");
    expect(principal?.id).toBe(result.ctx.principalId);
  });

  test("a repeated session for the same user resolves to the same workspace every time", async () => {
    const auth = fakeAuth({ userId: "auth-user-2" });
    const first = await requireAccessContext(auth, store, new Request("http://x/"));
    const second = await requireAccessContext(auth, store, new Request("http://x/"));
    if ("error" in first || "error" in second) throw new Error("expected two contexts");
    expect(second.ctx.workspaceId).toBe(first.ctx.workspaceId);
    expect(second.ctx.principalId).toBe(first.ctx.principalId);
  });

  test("identity.provider defaults to credential and never calls listUserAccounts — nothing in this codebase reads the field, so the per-request round trip it used to cost is gone", async () => {
    let calls = 0;
    const auth = fakeAuth({ userId: "auth-user-3" }, [{ providerId: "credential" }, { providerId: "google" }], () => { calls++; });
    const result = await requireAccessContext(auth, store, new Request("http://x/"));
    if ("error" in result) throw new Error(`expected ctx, got ${result.error}`);
    expect(result.ctx.identity.provider).toBe("credential");
    expect(calls).toBe(0);
  });

  test("every request gets its own requestId for audit correlation", async () => {
    const auth = fakeAuth({ userId: "auth-user-4" });
    const a = await requireAccessContext(auth, store, new Request("http://x/"));
    const b = await requireAccessContext(auth, store, new Request("http://x/"));
    if ("error" in a || "error" in b) throw new Error("expected two contexts");
    expect(a.ctx.requestId).not.toBe(b.ctx.requestId);
  });
});
