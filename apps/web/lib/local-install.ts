import "server-only";
import { randomUUID } from "node:crypto";
import type { AccessContext } from "@crossline/core";
import { chatgptAccountOf, type LocalCodexAccount } from "@crossline/auth";
import { requestCodexSupervisor } from "./codex-runtime";
import { isLocalInstall } from "./install-mode";

// One machine, one person, whose Codex is the machine's own — so the session is that Codex's ChatGPT login and nothing else signs in.
export { isLocalInstall };

/**
 * Before anyone is signed in there is no AccessContext to sign a supervisor capability with. These three operations on the
 * machine's own Codex — read which account it holds, start its ChatGPT sign-in, cancel that — are signed for the empty workspace,
 * which the supervisor serves from the owner runtime. A capability names its one operation, so this can reach nothing else.
 */
const BOOTSTRAP_OPERATIONS = new Set(["GET /v1/codex/account", "POST /v1/codex/login", "POST /v1/codex/login/cancel"]);

export async function bootstrapSupervisor<T>(method: "GET" | "POST", pathname: string, body?: unknown): Promise<T> {
  if (!isLocalInstall() || !BOOTSTRAP_OPERATIONS.has(`${method} ${pathname}`)) throw new Error("BOOTSTRAP_OPERATION_REFUSED");
  const ctx: AccessContext = { principalId: "installer-bootstrap", workspaceId: "", role: "owner",
    identity: { provider: "credential", issuer: "crossline", subject: "installer-bootstrap" }, authMethod: "session", requestId: randomUUID() };
  return requestCodexSupervisor<T>(ctx, pathname, { method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
}

/** The account the machine's Codex holds: null when it holds no ChatGPT login; throws when Codex cannot be asked. */
export async function readLocalCodexAccount(): Promise<LocalCodexAccount | null> {
  return chatgptAccountOf(await bootstrapSupervisor("GET", "/v1/codex/account"));
}

/**
 * The per-request check (`requireAccessContext`): cached for a few seconds, because every page and API call passes through it and
 * asking Codex costs a round trip. `undefined` — Codex starting or restarting — never signs anyone out.
 */
let cached: { at: number; value: LocalCodexAccount | null | undefined } | undefined;
const TTL_MS = 10_000;
export async function currentLocalAccount(): Promise<LocalCodexAccount | null | undefined> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await readLocalCodexAccount().catch(() => undefined);
  cached = { at: Date.now(), value };
  return value;
}
