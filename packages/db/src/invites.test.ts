import { expect, test } from "vitest";
import { CrosslineStore } from "./index";
import { applyForInvite, decideInvite, mintInviteCode, normalizeInviteCode, redeemInvite, sponsorshipOf } from "./invites";

test("an application is decided once, the code is stored only as a hash, and it redeems for one account", () => {
  const store = new CrosslineStore(":memory:");
  const { invite, created } = applyForInvite(store, { workspaceId: "ws-a", email: "a@example.com", reason: "免费账号额度不够" });
  expect(created).toBe(true);
  // Applying again returns the open application.
  expect(applyForInvite(store, { workspaceId: "ws-a", email: "a@example.com", reason: "再申请" })).toMatchObject({ created: false, invite: { id: invite.id } });
  const decided = decideInvite(store, invite.id, "approve");
  if (!decided.ok) throw new Error(decided.code);
  expect(decided.code).toMatch(/^CL-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(JSON.stringify(store.listInvites())).not.toContain(decided.code!);
  expect(decideInvite(store, invite.id, "reject")).toEqual({ ok: false, code: "INVITE_ALREADY_DECIDED" });
  // Typed loosely: lower case, spaces, no prefix.
  const typed = decided.code!.replace("CL-", "").toLowerCase().replace("-", " ");
  expect(redeemInvite(store, "ws-b", "owner-b", typed)).toMatchObject({ ok: true });
  expect(sponsorshipOf(store, "ws-b")).toMatchObject({ inviteId: invite.id });
  expect(redeemInvite(store, "ws-b", "owner-b", decided.code!)).toMatchObject({ ok: true });
  expect(redeemInvite(store, "ws-c", "owner-c", decided.code!)).toEqual({ ok: false, code: "INVITE_CODE_USED" });
  expect(redeemInvite(store, "ws-c", "owner-c", "CL-AAAA-BBBB")).toEqual({ ok: false, code: "INVITE_CODE_INVALID" });
  // A rejected application can be followed by a new one.
  const second = applyForInvite(store, { workspaceId: "ws-d", email: "d@example.com", reason: "" });
  decideInvite(store, second.invite.id, "reject");
  expect(applyForInvite(store, { workspaceId: "ws-d", email: "d@example.com", reason: "" }).created).toBe(true);
  // Deleting the applicant's account deletes the application.
  store.purgeWorkspace("ws-d");
  expect(store.listInvites({ workspaceId: "ws-d" })).toEqual([]);
  store.close();
});

test("codes avoid misreadable characters and normalize", () => {
  expect(mintInviteCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBe("CL-ABCD-EFGH");
  expect(normalizeInviteCode(" cl abcd-efgh ")).toBe("CL-ABCD-EFGH");
  expect(normalizeInviteCode("abc")).toBe("");
});
