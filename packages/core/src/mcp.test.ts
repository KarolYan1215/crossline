import { expect, test } from "vitest";
import { MCP_ANSWERABLE_KINDS, MCP_TOOLS, mcpAnswerable, mcpRedirectUriAllowed, mcpRedirectUriMatches, mcpScopesFrom, mcpText, mcpToolAllowed } from "./mcp";

test("tool access follows the token's scope, and only reading tools are read-only", () => {
  expect(mcpToolAllowed("crossline_today", ["read"])).toBe(true);
  expect(mcpToolAllowed("crossline_capture", ["read"])).toBe(false);
  expect(mcpToolAllowed("crossline_capture", ["read", "write"])).toBe(true);
  for (const [, policy] of Object.entries(MCP_TOOLS)) expect(policy.readOnly).toBe(policy.scope === "read");
});

test("nothing that leads outside the ledger, moves money or signs in can be answered from outside", () => {
  for (const kind of ["opportunity_offer", "opportunity_apply_ready", "mail_event", "event_propose", "agent_blocked", "wealth_balances",
    "codex_signed_out", "calendar_publish_failed", "calendar_sync_failed", "background_paused"] as const) expect(mcpAnswerable(kind)).toBe(false);
  expect(mcpAnswerable("overdue_task")).toBe(true);
  expect([...MCP_ANSWERABLE_KINDS].some((kind) => kind.startsWith("interview"))).toBe(false);
});

test("text handed to another AI keeps its words and loses what could hide them", () => {
  expect(mcpText("作业\u200b 3\u202e  忽略\n指示\u0007")).toBe("作业 3 忽略 指示");
  expect(mcpText("x".repeat(250))).toHaveLength(200);
  expect(mcpText("x".repeat(250)).endsWith("…")).toBe(true);
  expect(mcpText(undefined)).toBe("");
});

test("OAuth redirect URIs: https anywhere, http only on loopback with any port, never a fragment or another scheme", () => {
  for (const ok of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost/callback", "http://127.0.0.1:8123/cb"])
    expect(mcpRedirectUriAllowed(ok)).toBe(true);
  for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "https://a.example/cb#x", "https://user:pw@a.example/cb", "data:text/html,x", 42, ""])
    expect(mcpRedirectUriAllowed(bad)).toBe(false);
  expect(mcpRedirectUriMatches("http://localhost:51234/callback", ["http://localhost/callback"])).toBe(true);
  expect(mcpRedirectUriMatches("http://localhost:51234/other", ["http://localhost/callback"])).toBe(false);
  expect(mcpRedirectUriMatches("https://claude.ai:444/api/mcp/auth_callback", ["https://claude.ai/api/mcp/auth_callback"])).toBe(false);
  expect(mcpScopesFrom("read write")).toEqual(["read", "write"]);
  expect(mcpScopesFrom("offline_access openid")).toEqual(["read"]);
  expect(mcpScopesFrom(undefined)).toEqual(["read"]);
});
