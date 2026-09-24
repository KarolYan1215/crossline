import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AccessContext } from "@crossline/core";

/**
 * The one real gap stage four closes: the supervisor's HTTP port (3211) is loopback-only, but anything
 * else running on this machine could already curl it directly and trigger a real Codex run, material
 * preparation or milestone judgement — `isCrossSiteWrite`'s browser-Origin check protects the web app's
 * own routes, not this one. A capability is minted per web request from that request's own already-
 * verified `AccessContext` and travels only web→worker, never to a browser; nothing outside this process
 * pair can construct a valid one without the shared secret.
 */
export type SupervisorCapability = {
  version: 1;
  principalId: string;
  workspaceId: string;
  role: AccessContext["role"];
  /** `${method} ${pathname}` of the one request this token is good for — binding it to the exact route
   * stops a token captured for a cheap read being replayed against an expensive write. */
  operation: string;
  requestId: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
  /** Generated once per `startCodexSupervisor` call. A worker restart invalidates every outstanding
   * token instead of a stale one from a crashed process still being honoured after recovery. */
  supervisorBootId: string;
};

const TTL_MS = 30_000;

export function signCapability(
  claims: Pick<SupervisorCapability, "principalId" | "workspaceId" | "role" | "operation" | "requestId" | "supervisorBootId">,
  secret: string
): string {
  const issuedAt = Date.now();
  const capability: SupervisorCapability = {
    version: 1, ...claims, jti: randomUUID(), issuedAt, expiresAt: issuedAt + TTL_MS
  };
  const payload = Buffer.from(JSON.stringify(capability)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export type VerifyCapabilityResult =
  | { ok: true; capability: SupervisorCapability }
  | { ok: false; code: string };

/**
 * Replayed `jti`s are tracked in a module-level, process-lifetime `Set` — "进程内 Set" in the plan this
 * implements. Pruned lazily on each call rather than on an interval: a 30-second TTL means the set never
 * grows large between requests, and an interval would be one more handle `startCodexSupervisor`'s
 * caller would have to remember to clear on shutdown for no measurable benefit.
 */
const seenJti = new Map<string, number>();
function pruneExpiredJti(now: number): void {
  for (const [jti, expiresAt] of seenJti) if (expiresAt <= now) seenJti.delete(jti);
}

export function verifyCapability(
  token: string | undefined,
  secret: string,
  expected: { operation: string; supervisorBootId: string }
): VerifyCapabilityResult {
  if (!token) return { ok: false, code: "CAPABILITY_MISSING" };
  const separator = token.lastIndexOf(".");
  if (separator < 0) return { ok: false, code: "CAPABILITY_MALFORMED" };
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expectedSignature = createHmac("sha256", secret).update(payload).digest("base64url");
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expectedSignature);
  // Constant-time even on a length mismatch: comparing against a same-length buffer first, rather than
  // short-circuiting on `given.length !== wanted.length`, keeps the whole check off a length oracle.
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, code: "CAPABILITY_SIGNATURE_INVALID" };
  }
  let capability: SupervisorCapability;
  try { capability = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SupervisorCapability; }
  catch { return { ok: false, code: "CAPABILITY_MALFORMED" }; }
  if (capability.version !== 1) return { ok: false, code: "CAPABILITY_VERSION_UNSUPPORTED" };
  const now = Date.now();
  pruneExpiredJti(now);
  if (now >= capability.expiresAt) return { ok: false, code: "CAPABILITY_EXPIRED" };
  if (capability.operation !== expected.operation) return { ok: false, code: "CAPABILITY_OPERATION_MISMATCH" };
  if (capability.supervisorBootId !== expected.supervisorBootId) return { ok: false, code: "CAPABILITY_BOOT_MISMATCH" };
  if (seenJti.has(capability.jti)) return { ok: false, code: "CAPABILITY_REPLAYED" };
  seenJti.set(capability.jti, capability.expiresAt);
  return { ok: true, capability };
}
