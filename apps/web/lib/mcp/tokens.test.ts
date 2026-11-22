import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MCP_TOKENS_MAX, MCP_WRITES_PER_HOUR } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { issueMcpToken, listMcpTokens, mcpCallerFor, mcpRateLimited, MCP_TOKENS_SETTING, resetMcpRateLimits, revokeMcpToken } from "./tokens";
import { TEST_CTX } from "../test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; resetMcpRateLimits(); });

function account(name = "owner") {
  const store = globalThis.crosslineStore ??= new CrosslineStore(":memory:");
  const { workspace } = store.createPrincipalWithWorkspace(name, "个人");
  return { store, ctx: { ...TEST_CTX, workspaceId: workspace.id } };
}

test("a token is shown once, kept only as a hash, and stands for the account's owner with the name the person gave it", () => {
  const { store, ctx } = account();
  const made = issueMcpToken(ctx, { label: "  Claude   Code ", scope: "write" });
  if (!made.ok) throw new Error(made.code);
  expect(made.token).toMatch(/^cl_mcp_[A-Za-z0-9_-]{43}$/);
  expect(store.getSetting(ctx.workspaceId, MCP_TOKENS_SETTING)).not.toContain(made.token);
  expect(listMcpTokens(ctx.workspaceId)).toEqual([expect.objectContaining({ label: "Claude Code", scopes: ["read", "write"] })]);
  expect(JSON.stringify(listMcpTokens(ctx.workspaceId))).not.toContain("hash");
  const caller = mcpCallerFor(made.token)!;
  expect(caller.ctx).toMatchObject({ workspaceId: ctx.workspaceId, authMethod: "mcp", via: "Claude Code", role: "owner" });
  expect(caller.ctx.principalId).toBe(store.getWorkspaceOwnerId(ctx.workspaceId));
  expect(listMcpTokens(ctx.workspaceId)[0]!.lastUsedAt).toBeDefined();
});

test("read-only by default choice, one revoked leaves the others working, and nothing else is a token", () => {
  const { ctx } = account();
  const read = issueMcpToken(ctx, { label: "ChatGPT", scope: "read" });
  const write = issueMcpToken(ctx, { label: "Codex", scope: "write" });
  if (!read.ok || !write.ok) throw new Error("not issued");
  expect(mcpCallerFor(read.token)!.scopes).toEqual(["read"]);
  expect(revokeMcpToken(ctx.workspaceId, read.view.id)).toBe(true);
  expect(mcpCallerFor(read.token)).toBeUndefined();
  expect(mcpCallerFor(write.token)?.ctx.via).toBe("Codex");
  expect(revokeMcpToken(ctx.workspaceId, read.view.id)).toBe(false);
  expect(mcpCallerFor("cl_mcp_" + "x".repeat(43))).toBeUndefined();
  expect(mcpCallerFor(write.token.slice(0, -1) + (write.token.endsWith("A") ? "B" : "A"))).toBeUndefined();
});

test("two accounts' tokens never reach each other's ledger", () => {
  const { ctx: first } = account("a");
  const { ctx: second } = account("b");
  const a = issueMcpToken(first, { label: "A", scope: "write" });
  const b = issueMcpToken(second, { label: "B", scope: "write" });
  if (!a.ok || !b.ok) throw new Error("not issued");
  expect(mcpCallerFor(a.token)!.ctx.workspaceId).toBe(first.workspaceId);
  expect(mcpCallerFor(b.token)!.ctx.workspaceId).toBe(second.workspaceId);
  expect(revokeMcpToken(first.workspaceId, b.view.id)).toBe(false);
});

test("a name, a known scope and room are required", () => {
  const { ctx } = account();
  expect(issueMcpToken(ctx, { label: "", scope: "read" })).toEqual({ ok: false, code: "MCP_TOKEN_LABEL_INVALID" });
  expect(issueMcpToken(ctx, { label: "x".repeat(41), scope: "read" })).toEqual({ ok: false, code: "MCP_TOKEN_LABEL_INVALID" });
  expect(issueMcpToken(ctx, { label: "A", scope: "admin" })).toEqual({ ok: false, code: "MCP_TOKEN_SCOPE_INVALID" });
  for (let index = 0; index < MCP_TOKENS_MAX; index += 1) expect(issueMcpToken(ctx, { label: `T${index}`, scope: "read" }).ok).toBe(true);
  expect(issueMcpToken(ctx, { label: "one more", scope: "read" })).toEqual({ ok: false, code: "MCP_TOKENS_FULL" });
});

test("writes are limited per token per hour", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  for (let index = 0; index < MCP_WRITES_PER_HOUR; index += 1) expect(mcpRateLimited("t1", "write", now)).toBe(false);
  expect(mcpRateLimited("t1", "write", now)).toBe(true);
  expect(mcpRateLimited("t2", "write", now)).toBe(false);
  expect(mcpRateLimited("t1", "write", now + 3_600_001)).toBe(false);
});
