import type { AskKind } from "./asks";

/**
 * Crossline as an MCP server for outside agents (Claude, ChatGPT, Codex; docs/mcp-server.md, decided 2026-11-21). The policy lives here,
 * beside `requiredApproval`, so the route, the settings card and the tests read one table.
 *
 * Only four kinds of thing are open, and only through the functions the pages use: read today, capture a line, answer an ask, record
 * work done. Nothing here sends mail, publishes, trades, submits a form or writes a calendar beyond what the app already does by itself.
 */

/** `read`: today, the open asks, the open tasks. `write`: also capture, answer and record completion. */
export type McpScope = "read" | "write";
export const MCP_SCOPES: readonly McpScope[] = ["read", "write"];

/** A token starts with this, so a secret scanner can name it and a pasted one is recognisably Crossline's. */
export const MCP_TOKEN_PREFIX = "cl_mcp_";
export const MCP_TOKEN_PATTERN = /^cl_mcp_[A-Za-z0-9_-]{32,64}$/;
/** Tokens kept per account: one per agent the person uses is the expected case. */
export const MCP_TOKENS_MAX = 10;
export const MCP_TOKEN_LABEL_MAX = 40;
/** Writes per token per hour (capture, answer, completion together): a looping agent cannot flood the ledger. */
export const MCP_WRITES_PER_HOUR = 60;
/** Calls per token per minute, reads included. */
export const MCP_CALLS_PER_MINUTE = 60;

export type McpToolName = "crossline_today" | "crossline_list_asks" | "crossline_list_tasks" | "crossline_capture" | "crossline_answer_ask" | "crossline_complete";

/**
 * Each tool's scope and MCP annotations (hints a host may use to decide whether to ask the person first; they are untrusted by the spec,
 * so nothing here relies on them). Every tool is closed-world: it touches only this person's own ledger. A capture or a completion
 * changes nothing that cannot be undone from the bell list for a day, so it is not destructive; an answer may archive a task or drop a
 * proposal (「不做了」), so it is marked destructive and a host will ask before sending one.
 */
export const MCP_TOOLS: Record<McpToolName, { scope: McpScope; readOnly: boolean; destructive: boolean; idempotent: boolean }> = {
  crossline_today: { scope: "read", readOnly: true, destructive: false, idempotent: true },
  crossline_list_asks: { scope: "read", readOnly: true, destructive: false, idempotent: true },
  crossline_list_tasks: { scope: "read", readOnly: true, destructive: false, idempotent: true },
  crossline_capture: { scope: "write", readOnly: false, destructive: false, idempotent: false },
  crossline_answer_ask: { scope: "write", readOnly: false, destructive: true, idempotent: false },
  // Recording the same block or task done twice records it once (the wrap-up and the state machine both refuse a second time).
  crossline_complete: { scope: "write", readOnly: false, destructive: false, idempotent: true }
};

export const mcpToolAllowed = (tool: McpToolName, scopes: readonly McpScope[]): boolean =>
  MCP_TOOLS[tool].scope === "read" ? scopes.includes("read") || scopes.includes("write") : scopes.includes("write");

/**
 * The asks an outside agent may answer: those whose answer only changes this ledger. Left out, and answered only in Crossline:
 * - anything that leads outward — a sign-up or application (`opportunity_offer`, `opportunity_apply_ready`), an event from mail whose
 *   「去」 sends a calendar invitation (`mail_event`), a proposed calendar event (`event_propose`);
 * - the shell assistant's retry (`agent_blocked`), whose words steer a run with a shell;
 * - money (`ledger_duplicate`, `wealth_balances`): balances and payments are not read out to another service;
 * - sign-ins and runtime states only the person can fix in place (`codex_signed_out`, `calendar_publish_failed`, `calendar_sync_failed`,
 *   `background_paused`), the interview's own questions and settings (`interview_*`), which have their context only there.
 * An allowlist, so a kind added later is closed until someone decides it is safe.
 */
export const MCP_ANSWERABLE_KINDS: ReadonlySet<AskKind> = new Set<AskKind>([
  "backplan_input", "waiting_due", "capture_blocked", "materials_blocked", "gate_insufficient", "gate_failed", "acceptance_gap", "milestone_risk",
  "missed_block", "source_project", "calendar_line_unclear", "step_question", "exam_time", "relation_check", "locked_conflict", "milestone_risk_review",
  "milestone_overdue", "opportunity_result", "overdue_task", "prep_question", "travel_minutes", "risk_digest", "weekly_commit", "event_merge"
]);
export const mcpAnswerable = (kind: AskKind): boolean => MCP_ANSWERABLE_KINDS.has(kind);

/**
 * OAuth for the hosts that sign in only that way (claude.ai, ChatGPT; docs/mcp-server.md §4.3). An access token is an ordinary MCP token
 * that expires; the refresh token renews it (and is replaced each time) until the person revokes the connection or it lies unused.
 */
export const MCP_OAUTH_ACCESS_SECONDS = 3600;
export const MCP_OAUTH_REFRESH_DAYS = 30;
export const MCP_OAUTH_CODE_SECONDS = 60;
export const MCP_REFRESH_PREFIX = "cl_mcr_";
export const MCP_REFRESH_PATTERN = /^cl_mcr_[A-Za-z0-9_-]{32,64}$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const urlOf = (value: string): URL | undefined => { try { return new URL(value); } catch { return undefined; } };
const isLoopback = (url: URL) => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

/**
 * A redirect URI a client may register: https anywhere (claude.ai, chatgpt.com), or http only on this machine's loopback (Claude Code,
 * Codex, RFC 8252). Never a fragment, credentials, or another scheme a page could be made to run.
 */
export function mcpRedirectUriAllowed(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  const url = urlOf(value);
  if (!url || url.hash || url.username || url.password || value.includes("#")) return false;
  return url.protocol === "https:" || isLoopback(url);
}

/** Whether `requested` is one of `registered`: exactly, or for loopback with any port (RFC 8252 §7.3; the port is picked at sign-in). */
export function mcpRedirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  const asked = urlOf(requested);
  if (!asked || !isLoopback(asked)) return false;
  return registered.some((entry) => {
    const known = urlOf(entry);
    return Boolean(known && isLoopback(known) && known.hostname === asked.hostname && known.pathname === asked.pathname && known.search === asked.search);
  });
}

/** An OAuth `scope` string to Crossline's scopes: `write` includes reading; anything else asked for is not granted. */
export function mcpScopesFrom(scope: string | null | undefined): McpScope[] {
  const asked = (scope ?? "").split(/\s+/);
  return asked.includes("write") ? ["read", "write"] : ["read"];
}

/** How an outside agent may record work: the whole task or a block done, a step done, or how far a task got. */
export type McpCompletion = "done" | "partial";

/**
 * Outside text going back to an agent is the person's data, never instructions: cut to a length and stripped of characters that hide
 * text (zero-width, bidi controls) or break a line-oriented prompt. Titles come from mail and files too, which a stranger can write.
 */
export function mcpText(value: string | undefined, max = 200): string {
  const clean = (value ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
