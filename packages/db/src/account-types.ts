export type StoredPrincipal = { id: string; betterAuthUserId: string; createdAt: string };
export type StoredInvite = {
  id: string; workspaceId: string; email: string; reason: string; status: "pending" | "approved" | "rejected" | "redeemed";
  createdAt: string; codeHash?: string; decidedAt?: string; redeemedAt?: string; redeemedWorkspaceId?: string;
};
export type StoredWorkspace = { id: string; name: string; createdAt: string };
export type StoredWorkspaceMember = {
  principalId: string; workspaceId: string; role: "viewer" | "member" | "owner"; createdAt: string;
};
export type StoredDeviceLease = {
  id: string; principalId: string; workspaceId: string; deviceId: string;
  issuedAt: string; expiresAt: string; revokedAt?: string;
};

/** Reads the lease's own timestamps to judge whether it is currently usable — no I/O, so a caller (a
 * future command-authorization check, an admin "devices" list) can apply it without a fresh store read. */
export function isDeviceLeaseValid(lease: StoredDeviceLease, now: Date): boolean {
  if (lease.revokedAt) return false;
  return now.getTime() < Date.parse(lease.expiresAt);
}

/**
 * Records that the owner, while already signed in through a normal session, confirmed a specific
 * Tailscale login as really them. `nodeKey` is optional — `tailscale serve` forwards only
 * `Tailscale-User-Login`/`-Name`/`-Profile-Pic` to a proxied backend, no node identifier, so there is
 * nothing honest to put there from an HTTP header alone. This binding is a recorded fact, not an
 * authentication mechanism: nothing here bypasses or shortcuts Better Auth's own session check, by design.
 */
export type StoredTailscaleBinding = {
  id: string; principalId: string; workspaceId: string; tailscaleLogin: string;
  nodeKey?: string; createdAt: string;
};
export type StoredAuditEvent = {
  id: string; principalId: string; workspaceId: string; role: string; authMethod: string;
  requestId: string; idempotencyKey?: string;
  codexThreadId?: string; codexTurnId?: string; codexCallId?: string;
  action: string; payload: unknown; createdAt: string;
};
