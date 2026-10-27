import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CrosslineStore, StoredInvite } from "./index";

/**
 * Beta invite codes (2026-10-18, the owner's decision). An account without a usable ChatGPT quota applies; the owner approves from the
 * email the application sends; the approval mints a code that is mailed to the applicant; redeeming it puts that account on the
 * developer's model (`SPONSOR_SETTING`), capped per month by the worker. Only the code's hash is stored, so the ledger cannot leak a code.
 */
export const SPONSOR_SETTING = "model.sponsor";
export type Sponsorship = { inviteId: string; since: string };

/** Letters and digits that cannot be misread for each other (no 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function mintInviteCode(bytes: Buffer = randomBytes(8)): string {
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]!).join("");
  return `CL-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/** What a person types, made comparable: case, spaces and dashes ignored, the `CL` prefix optional. */
export function normalizeInviteCode(text: string): string {
  const bare = text.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^CL/, "");
  return bare.length === 8 ? `CL-${bare.slice(0, 4)}-${bare.slice(4)}` : "";
}

export const inviteCodeHash = (code: string) => createHash("sha256").update(`crossline-invite:${code}`).digest("hex");

/** One open application per account: applying again returns the one already there. */
export function applyForInvite(store: CrosslineStore, input: { workspaceId: string; email: string; reason: string; now?: Date }): { invite: StoredInvite; created: boolean } {
  const existing = store.listInvites({ workspaceId: input.workspaceId }).find((invite) => invite.status !== "rejected");
  if (existing) return { invite: existing, created: false };
  const invite: StoredInvite = { id: randomUUID(), workspaceId: input.workspaceId, email: input.email.trim().slice(0, 200),
    reason: input.reason.trim().slice(0, 300), status: "pending", createdAt: (input.now ?? new Date()).toISOString() };
  store.saveInvite(invite);
  return { invite, created: true };
}

/** The owner's decision. Approving mints the code, returned once here to be mailed; a decided application is not decided again. */
export function decideInvite(store: CrosslineStore, id: string, decision: "approve" | "reject", now = new Date()):
  { ok: true; invite: StoredInvite; code?: string } | { ok: false; code: "INVITE_NOT_FOUND" | "INVITE_ALREADY_DECIDED" } {
  const invite = store.listInvites({ id })[0];
  if (!invite) return { ok: false, code: "INVITE_NOT_FOUND" };
  if (invite.status !== "pending") return { ok: false, code: "INVITE_ALREADY_DECIDED" };
  if (decision === "reject") {
    const rejected: StoredInvite = { ...invite, status: "rejected", decidedAt: now.toISOString() };
    store.saveInvite(rejected);
    return { ok: true, invite: rejected };
  }
  const code = mintInviteCode();
  const approved: StoredInvite = { ...invite, status: "approved", codeHash: inviteCodeHash(code), decidedAt: now.toISOString() };
  store.saveInvite(approved);
  return { ok: true, invite: approved, code };
}

/** Redeems a code for one account, once. The same account redeeming again is fine; another account is refused. */
export function redeemInvite(store: CrosslineStore, workspaceId: string, ownerId: string, text: string, now = new Date()):
  { ok: true; sponsorship: Sponsorship } | { ok: false; code: "INVITE_CODE_INVALID" | "INVITE_CODE_USED" } {
  const code = normalizeInviteCode(text);
  const invite = code ? store.listInvites({ codeHash: inviteCodeHash(code) })[0] : undefined;
  if (!invite || (invite.status !== "approved" && invite.status !== "redeemed")) return { ok: false, code: "INVITE_CODE_INVALID" };
  if (invite.status === "redeemed" && invite.redeemedWorkspaceId !== workspaceId) return { ok: false, code: "INVITE_CODE_USED" };
  const sponsorship: Sponsorship = { inviteId: invite.id, since: invite.redeemedAt ?? now.toISOString() };
  if (invite.status === "approved") {
    store.saveInvite({ ...invite, status: "redeemed", redeemedAt: sponsorship.since, redeemedWorkspaceId: workspaceId });
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `invite.redeemed:${invite.id}`, type: "invite.redeemed", entityId: invite.id, payload: {} });
  }
  store.setSetting(workspaceId, SPONSOR_SETTING, JSON.stringify(sponsorship));
  return { ok: true, sponsorship };
}

/** The account's sponsorship, when it redeemed a code. */
export function sponsorshipOf(store: CrosslineStore, workspaceId: string): Sponsorship | undefined {
  try {
    const value = JSON.parse(store.getSetting(workspaceId, SPONSOR_SETTING) || "null") as Sponsorship | null;
    return value?.inviteId ? value : undefined;
  } catch { return undefined; }
}
