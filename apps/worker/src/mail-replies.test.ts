import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAIL_DRAFT_NOTE, MAIL_LOG_SETTING, MAIL_REPLY_DRAFTS_SETTING, MAIL_REPLY_NUDGE_KIND } from "@crossline/core";
import type { ImapFactory, SecretStore } from "@crossline/connectors";
import { CrosslineStore, closeMailReply, mailReplyClosures, openReplyDrafts, readReplyDrafts } from "@crossline/db";
import { addMailAccount, createMailService, MAIL_TRIAGE_SKILL } from "./mailbox";
import { draftReplies, followUpReplies, mailDraftsDir, MAIL_REPLY_DRAFTER_SKILL, type ReplyCandidate } from "./mail-replies";
import { fakeRuntime } from "./testing/fake-runtime";

type Message = { uid: number; subject: string; body: string; from?: string; to?: string; messageId?: string; inReplyTo?: string };
const BODY_SENTINEL = "数据我会在周五前整理好发给您";

/** A read-only mailbox stand-in with an inbox and a sent folder; it has no way to write, and records how each folder was opened. */
function mailbox() {
  const folders: Record<string, Message[]> = { INBOX: [], Sent: [] };
  const opened: Array<{ path: string; readOnly: boolean | undefined }> = [];
  let current = "INBOX";
  const envelope = (m: Message) => ({ seq: m.uid, uid: m.uid, envelope: { subject: m.subject, from: [{ name: m.from === "me" ? "Me" : "Prof Lin", address: m.from === "me" ? "me@qq.com" : "lin@uni.edu" }],
    to: [{ address: m.to ?? "me@qq.com" }], date: new Date("2026-10-19T08:00:00Z"), messageId: m.messageId ?? "", inReplyTo: m.inReplyTo ?? "" },
    source: Buffer.from(`From: Prof Lin <lin@uni.edu>\r\nSubject: ${m.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}\r\n`) });
  const factory: ImapFactory = (options) => ({
    connect: async () => { if (options.auth?.pass !== "app-pass") throw new Error("AUTHENTICATIONFAILED"); },
    logout: async () => undefined,
    list: async () => [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }],
    mailboxOpen: async (folder: string | string[], open?: { readOnly?: boolean }) => {
      current = String(folder); opened.push({ path: current, readOnly: open?.readOnly });
      return { uidValidity: 1n, uidNext: (folders[current]!.at(-1)?.uid ?? 0) + 1 } as never;
    },
    search: (async (query: { uid?: string }) => folders[current]!.filter((m) => !query.uid || m.uid >= Number(query.uid.split(":")[0])).map((m) => m.uid)) as never,
    fetchAll: (async (uids: number[]) => folders[current]!.filter((m) => uids.includes(m.uid)).map(envelope)) as never,
    fetchOne: (async (uid: string) => { const m = folders[current]!.find((item) => item.uid === Number(uid)); return m ? envelope(m) : false; }) as never
  });
  return { folders, opened, factory };
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  store.setSetting(workspaceId, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago" }));
  const values = new Map<string, string>();
  const secrets: SecretStore = { read: async (w, n) => values.get(`${w}/${n}`), write: async (w, n, v) => { values.set(`${w}/${n}`, v); }, remove: (w, n) => { values.delete(`${w}/${n}`); } };
  const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-mail-drafts-"));
  dirs.push(dataDir);
  return { store, workspaceId, secrets, dataDir, box: mailbox(), resolve: async () => "203.0.113.10" };
}
const draftAnswer = (extra: Record<string, unknown> = {}) => JSON.stringify({ needsReply: true, why: "导师要周五前的测量数据", subject: "Re: 测量数据",
  body: `林老师好，\n\n${BODY_SENTINEL}【请确认：周五前】。\n\n【署名】`, points: ["确认周五前发数据", "发送日期待本人确认"], replyBy: "2026-10-23", ...extra });
const nudges = (store: CrosslineStore, workspaceId: string) => store.listRecentNudges(workspaceId, "2026-01-01T00:00:00Z");

test("a message waiting for the person's answer gets a draft file and one message; the ledger keeps no text of either mail", async () => {
  const { store, workspaceId, secrets, dataDir, box, resolve } = setup();
  const now = new Date("2026-10-19T15:00:00Z"); // 10:00 in Chicago
  await addMailAccount({ store, secrets, resolve, factory: box.factory, now: () => now }, workspaceId, { address: "me@qq.com", password: "app-pass" });
  box.folders.INBOX!.push({ uid: 1, subject: "测量数据", body: "Could you send me the measurement data by Friday? ORIGINAL-MAIL-TEXT", messageId: "<m1@uni.edu>" });
  const triage = JSON.stringify({ items: [{ uid: 1, kind: "reply", title: "", waitingId: "", why: "导师要数据" }] });
  const { rpc, prompts } = fakeRuntime([triage, draftAnswer()], [MAIL_TRIAGE_SKILL, MAIL_REPLY_DRAFTER_SKILL]);
  const service = createMailService({ store, secrets, resolve, factory: box.factory, now: () => now, cwd: "/repo", client: () => rpc, sortAllowed: async () => true, dataDir });
  const result = await service.pass(workspaceId, true);
  expect(result.drafts).toMatchObject({ drafted: 1 });
  expect(result.followUp).toMatchObject({ told: 1 });
  // The drafter read the whole message; nothing was put in the inbox for it.
  expect(prompts().some((prompt) => prompt.includes("ORIGINAL-MAIL-TEXT"))).toBe(true);
  expect(store.listCaptures(workspaceId)).toEqual([]);
  const [draft] = readReplyDrafts(store, workspaceId);
  expect(draft).toMatchObject({ from: "Prof Lin <lin@uni.edu>", subject: "测量数据", replyBy: "2026-10-23", messageId: "<m1@uni.edu>", notifiedAt: now.toISOString() });
  const file = readFileSync(path.join(mailDraftsDir(dataDir, workspaceId), draft!.file), "utf8");
  expect(file.split("\n")[0]).toBe(`> ${MAIL_DRAFT_NOTE}`);
  expect(file).toContain(BODY_SENTINEL);
  const ledger = JSON.stringify(store.exportSnapshot(workspaceId));
  expect(ledger).not.toContain(BODY_SENTINEL);
  expect(ledger).not.toContain("ORIGINAL-MAIL-TEXT");
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!)[0]).toMatchObject({ kind: "needs_reply" });
  // One message: who, what, why, the points; open, copy, answered, no answer needed, ask less.
  const [message] = nudges(store, workspaceId);
  const card = message!.payload.card as { clarify: { question: string; options: Array<{ label: string; kind: string; href?: string; close?: string }> }; mailReplyId: string };
  expect(card.clarify.question).toContain("Prof Lin 来信「测量数据」，需要本人回复");
  expect(card.clarify.question).toContain("确认周五前发数据");
  expect(card.clarify.question).toContain("不会发出");
  expect(card.clarify.options.map((option) => option.label)).toEqual(["看草稿", "复制草稿", "已回复", "不用回", "少问这类"]);
  expect(card.clarify.options[0]!.href).toContain(encodeURIComponent(`/api/mail/drafts/${draft!.id}/file`));
  expect(card.clarify.options[1]).toMatchObject({ kind: "copy", href: `/api/mail/drafts/${draft!.id}/file?part=body` });
  expect(card.mailReplyId).toBe(draft!.id);
  expect((message!.payload.nudge as { kind: string; delivery: string })).toMatchObject({ kind: MAIL_REPLY_NUDGE_KIND, delivery: "pending" });
  // Every folder was opened read-only.
  expect(box.opened.length).toBeGreaterThan(0);
  expect(box.opened.every((open) => open.readOnly === true)).toBe(true);
});

const candidate = (uid: number, accountId = "acc-1"): ReplyCandidate => ({ uid, accountId, uidValidity: "1", from: "Prof Lin <lin@uni.edu>", fromAddress: "lin@uni.edu",
  to: "me@qq.com", subject: `问题 ${uid}`, date: "2026-10-19T08:00:00Z", snippet: "请回复", messageId: `<m${uid}@uni.edu>`, why: "要本人回答" });

test("at most five drafts a day for each mailbox; none while switched off or muted; none twice for one message", async () => {
  const { store, workspaceId, dataDir } = setup();
  const now = new Date("2026-10-19T15:00:00Z");
  const { rpc, turns } = fakeRuntime(Array.from({ length: 6 }, () => draftAnswer()), MAIL_REPLY_DRAFTER_SKILL);
  const deps = { store, dataDir, cwd: "/repo", client: rpc, now: () => now, open: async () => undefined };
  const result = await draftReplies(deps, workspaceId, [1, 2, 3, 4, 5, 6].map((uid) => candidate(uid)));
  expect(result.drafted).toBe(5);
  expect(result.skipped).toEqual([{ uid: 6, reason: "daily_limit" }]);
  expect(readdirSync(mailDraftsDir(dataDir, workspaceId))).toHaveLength(5);
  expect((await draftReplies(deps, workspaceId, [candidate(1)])).skipped).toEqual([{ uid: 1, reason: "already" }]);
  // Another mailbox has its own five.
  expect((await draftReplies(deps, workspaceId, [candidate(7, "acc-2")])).drafted).toBe(1);
  const before = turns();
  store.setSetting(workspaceId, MAIL_REPLY_DRAFTS_SETTING, "off");
  expect((await draftReplies(deps, workspaceId, [candidate(8, "acc-3")])).skipped).toEqual([{ uid: 8, reason: "off" }]);
  store.setSetting(workspaceId, MAIL_REPLY_DRAFTS_SETTING, "on");
  store.setSetting(workspaceId, `nudge.mute.${MAIL_REPLY_NUDGE_KIND}`, "2026-10-26");
  expect((await draftReplies(deps, workspaceId, [candidate(9, "acc-3")])).skipped).toEqual([{ uid: 9, reason: "muted" }]);
  expect(turns()).toBe(before);
});

test("a draft written at night is told in the morning, never while the person is busy", async () => {
  const { store, workspaceId, dataDir } = setup();
  let now = new Date("2026-10-20T05:00:00Z"); // 00:00 in Chicago
  const { rpc } = fakeRuntime([draftAnswer()], MAIL_REPLY_DRAFTER_SKILL);
  const deps = { store, dataDir, cwd: "/repo", client: rpc, now: () => now, open: async () => undefined };
  await draftReplies(deps, workspaceId, [candidate(1)]);
  expect(await followUpReplies(deps, workspaceId)).toMatchObject({ told: 0 });
  now = new Date("2026-10-20T14:00:00Z"); // 09:00
  store.setSetting(workspaceId, "conversation.lastAnsweredAt", "2026-10-20T13:50:00Z");
  expect(await followUpReplies(deps, workspaceId)).toMatchObject({ told: 0 });
  now = new Date("2026-10-20T14:30:00Z");
  expect(await followUpReplies(deps, workspaceId)).toMatchObject({ told: 1 });
  expect(await followUpReplies(deps, workspaceId)).toMatchObject({ told: 0 });
  expect(nudges(store, workspaceId)).toHaveLength(1);
});

test("the person's answer in the sent folder closes the draft and its message; 不用回 stops the reminder; a day asked for brings one reminder after 48 hours", async () => {
  const { store, workspaceId, secrets, dataDir, box, resolve } = setup();
  let now = new Date("2026-10-19T15:00:00Z");
  const added = await addMailAccount({ store, secrets, resolve, factory: box.factory, now: () => now }, workspaceId, { address: "me@qq.com", password: "app-pass" });
  const accountId = added.ok ? added.account.id : "";
  const { rpc } = fakeRuntime([draftAnswer(), draftAnswer(), draftAnswer()], MAIL_REPLY_DRAFTER_SKILL);
  const service = createMailService({ store, secrets, resolve, factory: box.factory, now: () => now, cwd: "/repo", client: () => rpc, sortAllowed: async () => true, dataDir });
  const deps = { store, dataDir, cwd: "/repo", client: rpc, now: () => now,
    open: async () => undefined as never };
  await draftReplies(deps, workspaceId, [candidate(1, accountId), candidate(2, accountId), candidate(3, accountId)]);
  await followUpReplies(deps, workspaceId);
  const [first, second, third] = readReplyDrafts(store, workspaceId);
  // The person answered the first from their own mailbox.
  box.folders.Sent!.push({ uid: 1, subject: "Re: 问题 1", body: "ok", from: "me", to: "lin@uni.edu", inReplyTo: "<m1@uni.edu>" });
  now = new Date("2026-10-19T15:20:00Z");
  expect((await service.pass(workspaceId)).followUp).toMatchObject({ closed: 1 });
  expect(mailReplyClosures(store, workspaceId).get(first!.id)).toMatchObject({ how: "replied", by: "sent_found" });
  const closedMessage = nudges(store, workspaceId).find((message) => (message.payload.card as { mailReplyId?: string }).mailReplyId === first!.id)!;
  const closedCard = closedMessage.payload.card as { clarify: { chosen?: number; options: Array<{ label: string }> } };
  expect(closedCard.clarify.options[closedCard.clarify.chosen!]!.label).toBe("已回复");
  expect((closedMessage.payload.nudge as { delivery: string }).delivery).toBe("closed");
  // 不用回 on the second, by the person.
  expect(closeMailReply(store, workspaceId, second!.id, "dismissed", "person", now)).toBe(true);
  expect(closeMailReply(store, workspaceId, second!.id, "replied", "person", now)).toBe(false);
  expect(openReplyDrafts(store, workspaceId).map((draft) => draft.id)).toEqual([third!.id]);
  // 47 hours on: nothing; 48: the third (a day asked for) once; then never again.
  now = new Date("2026-10-21T14:00:00Z");
  expect(await followUpReplies(deps, workspaceId, { checkSent: false })).toMatchObject({ reminded: 0 });
  now = new Date("2026-10-21T15:00:00Z");
  expect(await followUpReplies(deps, workspaceId, { checkSent: false })).toMatchObject({ reminded: 1 });
  now = new Date("2026-10-22T15:00:00Z");
  expect(await followUpReplies(deps, workspaceId, { checkSent: false })).toMatchObject({ reminded: 0 });
  const reminder = nudges(store, workspaceId).at(-1)!;
  expect((reminder.payload.card as { clarify: { question: string } }).clarify.question).toContain("还没有回复");
  expect((reminder.payload.card as { mailReplyId: string }).mailReplyId).toBe(third!.id);
  expect(readReplyDrafts(store, workspaceId).find((draft) => draft.id === third!.id)!.messageIds).toHaveLength(2);
});
