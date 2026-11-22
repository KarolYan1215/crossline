import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_CALLS_PER_MINUTE, MCP_OAUTH_ACCESS_SECONDS, MCP_OAUTH_REFRESH_DAYS, MCP_REFRESH_PATTERN, MCP_REFRESH_PREFIX, MCP_SCOPES,
  MCP_TOKEN_LABEL_MAX, MCP_TOKEN_PATTERN, MCP_TOKEN_PREFIX, MCP_TOKENS_MAX, MCP_WRITES_PER_HOUR, type AccessContext, type McpScope } from "@crossline/core";
import { getStore } from "../crossline";

/**
 * The tokens an outside agent uses to reach the MCP server (docs/mcp-server.md §4). One per agent the person names (「Claude Code」,
 * 「Codex」), each read-only or read-write, shown once and kept only as a SHA-256 hash, so it can be revoked but never read back.
 * Revoking one cuts that agent off at its next call; the others keep working. They live in the ledger beside the phone's tokens
 * (`issueDeviceToken`), so deleting the account deletes them and a backup restores them.
 */
export const MCP_TOKENS_SETTING = "mcp.tokens";

/**
 * A connection made by OAuth (docs/mcp-server.md §4.3) is the same entry with an expiring access token and a refresh token: `client` is
 * the host the sign-in went back to (what the person saw on the consent page), `clientKey` the hash of the client id that may renew it.
 */
type OAuthPart = { client: string; clientKey: string; expiresAt: string; refreshHash: string; refreshExpiresAt: string;
  /** Access tokens issued before the last refresh, each kept until its own expiry: a request already on its way still gets through. */
  earlier?: Array<{ hash: string; expiresAt: string }> };
/** One read by the agent (writes are in 最近操作 already): which reading tool, when. The last `MCP_READS_KEPT` are kept. */
export type McpRead = { tool: string; at: string };
type StoredToken = { id: string; label: string; hash: string; scopes: McpScope[]; createdAt: string; lastUsedAt?: string; oauth?: OAuthPart; reads?: McpRead[] };
/** What the settings card shows: never a hash. `client` is set for a connection made by signing in from the other AI. */
export type McpTokenView = { id: string; label: string; scopes: McpScope[]; createdAt: string; lastUsedAt?: string; client?: string; reads?: McpRead[] };
export const MCP_READS_KEPT = 20;
/** How long a refresh token just replaced still answers with the same new pair (a lost answer, or two refreshes at once). */
export const MCP_REFRESH_GRACE_MS = 60_000;

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
  read(workspaceId).map(({ id, label, scopes, createdAt, lastUsedAt, oauth, reads }) =>
    ({ id, label, scopes, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}), ...(oauth ? { client: oauth.client } : {}), ...(reads?.length ? { reads } : {}) }));

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

export type GrantTokens = { accessToken: string; refreshToken: string; expiresIn: number; scopes: McpScope[] };
const newAccess = () => `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
const newRefresh = () => `${MCP_REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
const oauthTimes = (now: Date) => ({ expiresAt: new Date(now.getTime() + MCP_OAUTH_ACCESS_SECONDS * 1000).toISOString(),
  refreshExpiresAt: new Date(now.getTime() + MCP_OAUTH_REFRESH_DAYS * 86_400_000).toISOString() });
const refreshDead = (token: StoredToken, now: Date) => Boolean(token.oauth && Date.parse(token.oauth.refreshExpiresAt) <= now.getTime());

/**
 * A sign-in from the same host under the same name is that AI connecting again (claude.ai registers a new client for every fresh
 * connection), so it replaces the earlier connection instead of taking another place; the consent page says so before 允许. Two
 * connections from one host are kept apart by naming them differently there.
 */
type Connection = { client: string; label: string };
const replacedBy = (token: StoredToken, connection: Connection) => Boolean(token.oauth && token.oauth.client === connection.client && token.label === connection.label);
/** The connection a sign-in from `client` named `label` would replace, if any. */
export const mcpConnectionReplaced = (workspaceId: string, connection: Connection): McpTokenView | undefined => {
  const id = read(workspaceId).find((token) => replacedBy(token, connection))?.id;
  return id ? listMcpTokens(workspaceId).find((view) => view.id === id) : undefined;
};
const kept = (tokens: StoredToken[], now: Date, connection?: Connection) =>
  tokens.filter((token) => !refreshDead(token, now) && !(connection && replacedBy(token, connection)));

/** Whether a new OAuth connection would be refused: the list is full even after dropping dead connections and the one it replaces. */
export const mcpTokensFull = (workspaceId: string, now = new Date(), connection?: Connection) => kept(read(workspaceId), now, connection).length >= MCP_TOKENS_MAX;

/**
 * The connection an OAuth sign-in makes, after the person allowed it on the consent page: an entry in the same list as the tokens made by
 * hand, revoked the same way. Connections whose refresh token has run out, and the earlier connection of the same host and name, are
 * dropped here, so a host that signs in afresh each time does not fill the list.
 */
export function issueMcpGrant(ctx: AccessContext, input: { label: string; scopes: McpScope[]; client: string; clientId: string }, now = new Date()):
  { ok: true; tokens: GrantTokens } | { ok: false; code: "MCP_TOKENS_FULL" } {
  const tokens = kept(read(ctx.workspaceId), now, { client: input.client, label: input.label });
  if (tokens.length >= MCP_TOKENS_MAX) return { ok: false, code: "MCP_TOKENS_FULL" };
  const accessToken = newAccess(), refreshToken = newRefresh();
  const stored: StoredToken = { id: randomBytes(6).toString("hex"), label: input.label, hash: sha256(accessToken), scopes: input.scopes, createdAt: now.toISOString(),
    oauth: { client: input.client, clientKey: sha256(input.clientId), refreshHash: sha256(refreshToken), ...oauthTimes(now) } };
  write(ctx.workspaceId, [...tokens, stored]);
  return { ok: true, tokens: { accessToken, refreshToken, expiresIn: MCP_OAUTH_ACCESS_SECONDS, scopes: input.scopes } };
}

type Replayable = { workspaceId: string; grantId: string; clientKey: string; tokens: GrantTokens; until: number };
declare global {
  // eslint-disable-next-line no-var
  var crosslineMcpRefreshGrace: Map<string, Replayable> | undefined;
}
// In memory, on globalThis like the codes: the plain new pair must never reach the ledger, and a restart only ends a minute's grace.
const grace = () => globalThis.crosslineMcpRefreshGrace ??= new Map<string, Replayable>();

/**
 * A new access token and a new refresh token for a refresh token still on the list, presented by the client it was issued to
 * (refresh rotation, OAuth 2.1 §4.3.1 for public clients). The replaced refresh token still answers, for a minute, with the same new
 * pair: a host that refreshes twice at once, or whose answer was lost on the way, is not cut off. The replaced access token works until
 * its own expiry. `narrowTo` may narrow, never widen.
 */
export function refreshMcpGrant(refreshToken: string, clientId: string, narrowTo: McpScope[] | undefined, now = new Date()): GrantTokens | undefined {
  if (!MCP_REFRESH_PATTERN.test(refreshToken)) return undefined;
  const key = sha256(refreshToken);
  const hash = Buffer.from(key, "hex");
  const replays = grace();
  for (const [stale, entry] of replays) if (entry.until <= now.getTime()) replays.delete(stale);
  const replay = replays.get(key);
  if (replay) {
    // Only while the connection is still there: revoking it on the settings card ends the grace too.
    const alive = read(replay.workspaceId).some((token) => token.id === replay.grantId);
    return alive && replay.clientKey === sha256(clientId) ? replay.tokens : undefined;
  }
  for (const workspace of getStore().listWorkspaces()) {
    const tokens = read(workspace.id);
    const found = tokens.find((item) => item.oauth && timingSafeEqual(Buffer.from(item.oauth.refreshHash, "hex"), hash));
    const oauth = found?.oauth;
    if (!found || !oauth) continue;
    if (refreshDead(found, now) || oauth.clientKey !== sha256(clientId)) return undefined;
    const scopes = narrowTo ? found.scopes.filter((scope) => narrowTo.includes(scope)) : found.scopes;
    if (!scopes.length) return undefined;
    const accessToken = newAccess(), next = newRefresh();
    const earlier = [...(oauth.earlier ?? []), { hash: found.hash, expiresAt: oauth.expiresAt }]
      .filter((entry) => Date.parse(entry.expiresAt) > now.getTime()).slice(-5);
    write(workspace.id, tokens.map((item) => item.id === found.id
      ? { ...item, hash: sha256(accessToken), scopes, oauth: { ...oauth, refreshHash: sha256(next), earlier, ...oauthTimes(now) } } : item));
    const issued = { accessToken, refreshToken: next, expiresIn: MCP_OAUTH_ACCESS_SECONDS, scopes };
    replays.set(key, { workspaceId: workspace.id, grantId: found.id, clientKey: oauth.clientKey, tokens: issued, until: now.getTime() + MCP_REFRESH_GRACE_MS });
    return issued;
  }
  return undefined;
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
    const same = (stored: string) => timingSafeEqual(Buffer.from(stored, "hex"), hash);
    const found = tokens.find((item) => same(item.hash) || item.oauth?.earlier?.some((entry) => same(entry.hash)));
    if (!found) continue;
    // An OAuth access token lasts an hour, an earlier one until its own hour is up; the host renews them with its refresh token.
    const expiresAt = same(found.hash) ? found.oauth?.expiresAt : found.oauth?.earlier?.find((entry) => same(entry.hash))?.expiresAt;
    if (found.oauth && (!expiresAt || Date.parse(expiresAt) <= now.getTime())) return undefined;
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

/** A read by the agent, kept on its token for the settings card: which tool and when, never what it returned. */
export function recordMcpRead(workspaceId: string, tokenId: string, tool: string, now = new Date()): void {
  const tokens = read(workspaceId);
  if (!tokens.some((token) => token.id === tokenId)) return;
  write(workspaceId, tokens.map((token) => token.id === tokenId
    ? { ...token, reads: [...(token.reads ?? []), { tool, at: now.toISOString() }].slice(-MCP_READS_KEPT) } : token));
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
