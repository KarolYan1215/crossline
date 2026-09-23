/**
 * The shape every authenticated request carries once identity is real. Kept here rather than in
 * `packages/auth` so a package that only needs the *shape* (a route handler, a Skill wire contract)
 * never has to depend on the auth library that produces it — the same reason Skill contracts live here.
 */
export type AccessRole = "viewer" | "member" | "owner";

export type AccessContext = {
  principalId: string;
  workspaceId: string;
  role: AccessRole;
  identity: {
    provider: "credential" | "google" | "tailscale" | "entra";
    issuer: string;
    subject: string;
    tenantId?: string;
    objectId?: string;
  };
  authMethod: "session" | "tailscale-binding" | "system-job";
  requestId: string;
};

const ROLE_RANK: Record<AccessRole, number> = { viewer: 0, member: 1, owner: 2 };

/**
 * Fail closed: an unrecognised role is not known to be sufficient, the same principle
 * `requiredApproval` already applies to unknown actions.
 */
export function requireRole(ctx: AccessContext, minimum: AccessRole): boolean {
  const actual = ROLE_RANK[ctx.role];
  const required = ROLE_RANK[minimum];
  if (actual === undefined || required === undefined) return false;
  return actual >= required;
}
