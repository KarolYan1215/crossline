import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_CALLS_PER_MINUTE, MCP_SCOPES, MCP_TOKEN_LABEL_MAX, MCP_TOKEN_PATTERN, MCP_TOKEN_PREFIX, MCP_TOKENS_MAX, MCP_WRITES_PER_HOUR,
  type AccessContext, type McpScope } from "@crossline/core";
import { getStore } from "../crossline";

/**
 * The tokens an outside agent uses to reach the MCP server (docs/mcp-server.md §4). One per agent the person names (「Claude Code」,
 * 「Codex」), each read-only or read-write, shown once and kept only as a SHA-256 hash, so it can be revoked but never read back.
 * Revoking one cuts that agent off at its next call; the others keep working. They live in the ledger beside the phone's tokens
 * (`issueDeviceToken`), so deleting the account deletes them and a backup restores them.
 */
export const MCP_TOKENS_SETTING = "mcp.tokens";

type StoredToken = { id: string; label: string; hash: string; scopes: McpScope[]; createdAt: string; lastUsedAt?: string };
/** What the settings card shows: never the hash. */
export type McpTokenView = { id: string; label: string; scopes: McpScope[]; createdAt: string; lastUsedAt?: string };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function read(workspaceId: string): StoredToken[] {
  try {
    const parsed = JSON.parse(getStore().getSetting(workspaceId, MCP_TOKENS_SETTING) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is StoredToken => typeof item?.id === "string" && typeof item.hash === "string" && item.hash.length === 64
      && Array.isArray(item.scopes)) : [];
  } catch { return []; }
}
const write = (workspaceId: string, tokens: StoredToken[]) => getStore().setSetting(workspaceId, MCP_TOKENS_SETTING, JSON.stringify(tokens));

export const listMcpTokens = (workspaceId: string): McpTokenView[] =>
  read(workspaceId).map(({ id, label, scopes, createdAt, lastUsedAt }) => ({ id, label, scopes, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}) }));

export type IssueResult = { ok: true; token: string; view: McpTokenView } | { ok: false; code: "MCP_TOKEN_LABEL_INVALID" | "MCP_TOKEN_SCOPE_INVALID" | "MCP_TOKENS_FULL" };

/** A new token named `label`; the plain token is returned only here. */
export function issueMcpToken(ctx: AccessContext, input: { label?: unknown; scope?: unknown }, now = new Date()): IssueResult {
  const label = typeof input.label === "string" ? input.label.replace(/\s+/g, " ").trim() : "";
  if (!label || label.length > MCP_TOKEN_LABEL_MAX) return { ok: false, code: "MCP_TOKEN_LABEL_INVALID" };
  if (!MCP_SCOPES.includes(input.scope as McpScope)) return { ok: false, code: "MCP_TOKEN_SCOPE_INVALID" };
  const tokens = read(ctx.workspaceId);
  if (tokens.length >= MCP_TOKENS_MAX) return { ok: false, code: "MCP_TOKENS_FULL" };
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  // `write` includes reading: an agent that may record work also needs to see it.
  const scopes: McpScope[] = input.scope === "write" ? ["read", "write"] : ["read"];
  const stored: StoredToken = { id: randomBytes(6).toString("hex"), label, hash: sha256(token), scopes, createdAt: now.toISOString() };
  write(ctx.workspaceId, [...tokens, stored]);
  const { hash: _hash, ...view } = stored;
  return { ok: true, token, view };
}

export function revokeMcpToken(workspaceId: string, id: string): boolean {
  const tokens = read(workspaceId);
  const kept = tokens.filter((token) => token.id !== id);
  if (kept.length === tokens.length) return false;
  write(workspaceId, kept);
  return true;
}

export type McpCaller = { ctx: AccessContext; tokenId: string; scopes: McpScope[] };

/**
 * The caller a bearer token stands for, or undefined. Compared in constant time against every account's hashes (the phone's tokens are
 * found the same way); the account's owner is the principal, as for a phone shortcut. `lastUsedAt` is written at most once a minute.
 */
export function mcpCallerFor(token: string, now = new Date()): McpCaller | undefined {
  if (!MCP_TOKEN_PATTERN.test(token)) return undefined;
  const hash = Buffer.from(sha256(token), "hex");
  const store = getStore();
  for (const workspace of store.listWorkspaces()) {
    const tokens = read(workspace.id);
    const found = tokens.find((item) => timingSafeEqual(Buffer.from(item.hash, "hex"), hash));
    if (!found) continue;
    const ownerId = store.getWorkspaceOwnerId(workspace.id);
    if (!ownerId) return undefined;
    if (!found.lastUsedAt || now.getTime() - Date.parse(found.lastUsedAt) > 60_000)
      write(workspace.id, tokens.map((item) => item.id === found.id ? { ...item, lastUsedAt: now.toISOString() } : item));
    const ctx: AccessContext = { principalId: ownerId, workspaceId: workspace.id, role: "owner",
      identity: { provider: "credential", issuer: "crossline-mcp", subject: ownerId }, authMethod: "mcp", via: found.label,
      requestId: `mcp:${found.id}:${now.getTime()}` };
    return { ctx, tokenId: found.id, scopes: found.scopes };
  }
  return undefined;
}

/** Calls and writes per token, in memory: the limits guard against a looping agent, not against a restart. */
const calls = new Map<string, number[]>();
export function mcpRateLimited(tokenId: string, kind: "call" | "write", now = Date.now()): boolean {
  const key = `${kind}:${tokenId}`;
  const window = kind === "call" ? 60_000 : 3_600_000;
  const limit = kind === "call" ? MCP_CALLS_PER_MINUTE : MCP_WRITES_PER_HOUR;
  const recent = (calls.get(key) ?? []).filter((at) => now - at < window);
  if (recent.length >= limit) { calls.set(key, recent); return true; }
  calls.set(key, [...recent, now]);
  return false;
}
export const resetMcpRateLimits = () => calls.clear();
