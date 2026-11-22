import { expect, test } from "vitest";
import { MCP_ANSWERABLE_KINDS, MCP_TOOLS, mcpAnswerable, mcpText, mcpToolAllowed } from "./mcp";

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
