import { expect, test, vi } from "vitest";
import { MAIL_ACCOUNTS_SETTING, MAIL_EVENTS_SETTING, MAIL_LOG_SETTING, MAIL_TRIPS_SETTING, mailEventAsks, mailEventDigest, readMailEvents } from "@crossline/core";
import type { ImapFactory, SecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { addMailAccount, createMailService, MAIL_TRIAGE_SKILL, mailLookupFor, readNewMail, removeMailAccount, requeueReplies, setMailBookkeeping, triageMail } from "./mailbox";
import { replyKey } from "./mail-replies";
import { fakeRuntime } from "./testing/fake-runtime";

const memorySecrets = (): SecretStore & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return { values, read: async (w, n) => values.get(`${w}/${n}`), write: async (w, n, v) => { values.set(`${w}/${n}`, v); }, remove: (w, n) => { values.delete(`${w}/${n}`); } };
};
const raw = (subject: string, body: string) => Buffer.from(`From: Prof Lin <lin@uni.edu>\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`);
/** A mailbox whose contents a test can grow; a wrong password is refused. */
function mailbox(password = "app-pass") {
  const messages: Array<{ uid: number; subject: string; body: string }> = [];
  const factory: ImapFactory = (options) => ({
    connect: async () => { if (options.auth?.pass !== password) throw new Error("AUTHENTICATIONFAILED"); },
    logout: async () => undefined,
    mailboxOpen: async () => ({ uidValidity: 1n, uidNext: (messages.at(-1)?.uid ?? 0) + 1 }) as never,
    search: (async (query: { uid?: string }) => query.uid ? messages.filter((m) => m.uid >= Number(query.uid!.split(":")[0])).map((m) => m.uid) : messages.map((m) => m.uid)) as never,
    fetchAll: (async (uids: number[]) => messages.filter((m) => uids.includes(m.uid)).map((m) => ({ seq: m.uid, uid: m.uid,
      envelope: { subject: m.subject, from: [{ name: "Prof Lin", address: "lin@uni.edu" }], date: new Date("2026-10-19T08:00:00Z") }, source: raw(m.subject, m.body) }))) as never,
    fetchOne: (async () => false) as never
  });
  return { messages, factory };
}
const setup = () => {
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  return { store, workspaceId, secrets: memorySecrets(), resolve: async () => "203.0.113.10" };
};

test("an account is kept only after it signs in; the password goes to the secret store, never the ledger", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  expect(await addMailAccount({ store, secrets, resolve, factory: box.factory }, workspaceId, { address: "me@gmail.com", password: "wrong" })).toMatchObject({ ok: false, code: "MAIL_AUTH_FAILED" });
  expect(await addMailAccount({ store, secrets, resolve, factory: box.factory }, workspaceId, { address: "me@outlook.com", password: "x" })).toMatchObject({ ok: false, code: "MAIL_PROVIDER_UNSUPPORTED" });
  expect(await addMailAccount({ store, secrets, resolve, factory: box.factory }, workspaceId, { address: "me@unknown-provider.org", password: "x" })).toMatchObject({ ok: false, code: "MAIL_HOST_REQUIRED" });
  const added = await addMailAccount({ store, secrets, resolve, factory: box.factory }, workspaceId, { address: "Me@Gmail.com", password: "app-pass" });
  expect(added).toMatchObject({ ok: true, account: { address: "me@gmail.com", host: "imap.gmail.com", triage: true } });
  expect(JSON.stringify(store.exportSnapshot(workspaceId))).not.toContain("app-pass");
  expect([...secrets.values.values()]).toEqual(["app-pass"]);
  if (added.ok) expect(removeMailAccount({ store, secrets, resolve }, workspaceId, added.account.id)).toBe(true);
  expect(secrets.values.size).toBe(0);
  expect(store.getSetting(workspaceId, MAIL_ACCOUNTS_SETTING)).toBe("[]");
});

test("new mail is read once per check; sorting turns a to-do into an inbox line and a reply into the wait coming forward", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-10-19T09:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  expect(await readNewMail(deps, workspaceId)).toEqual([]);
  box.messages.push({ uid: 1, subject: "HW1 extended to Oct 30", body: "Please submit by Oct 30." }, { uid: 2, subject: "Re: 测量数据", body: "数据在附件里。" },
    { uid: 3, subject: "Weekly newsletter", body: "..." });
  // Within the check interval nothing is read; after it, the three new messages are.
  now = new Date("2026-10-19T09:05:00Z");
  expect(await readNewMail(deps, workspaceId)).toEqual([]);
  now = new Date("2026-10-19T09:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  expect(fresh.map((m) => m.subject)).toEqual(["HW1 extended to Oct 30", "Re: 测量数据", "Weekly newsletter"]);
  store.saveWaitingItem({ id: "wait-data", ownerId: "user-1", workspaceId, title: "测量数据", who: "Prof Lin", expectedAt: "2026-10-25", approximate: false,
    followUpAt: "2026-10-25", state: "open", blocks: [], source: "manual" });
  const answer = JSON.stringify({ items: [
    { uid: 1, kind: "todo", title: "10/30 前交 HW1（截止延后）", waitingId: "", why: "老师通知延期", money: { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" } },
    { uid: 2, kind: "reply", title: "", waitingId: "wait-data", why: "等的数据到了", money: { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" } },
    { uid: 3, kind: "ignore", title: "", waitingId: "", why: "简报", money: { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" } }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  const done = await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh);
  expect(done).toEqual({ state: "done", captured: 1, replies: 1, sorted: 3, needsReply: [], recorded: 0, events: 0 });
  expect(store.listCaptures(workspaceId)[0]).toMatchObject({ title: "10/30 前交 HW1（截止延后）" });
  expect(store.listCaptures(workspaceId)[0]!.context).toContain("HW1 extended to Oct 30");
  expect(store.listEvents(workspaceId, { type: "waiting.mail_seen", entityId: "wait-data" })).toHaveLength(1);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["todo", "reply", "ignore"]);
  // The person is asked at once whether it arrived, with a button that answers the waiting ask.
  const said = store.listConversationMessages(workspaceId, store.conversationFor(workspaceId, "2026-10-19").id).filter((m) => m.role === "nudge");
  expect(said).toHaveLength(1);
  expect((said[0]!.payload.card as { actions: Array<{ args: { askId: string; optionId: string } }>; clarify: { question: string } }))
    .toMatchObject({ actions: [{ args: { askId: "wait:wait-data", optionId: "arrived" } }], clarify: { question: expect.stringContaining("测量数据") } });
});

test("a payment mail becomes one wealth record only when its own text states the amount the model read", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-10-19T09:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  await readNewMail(deps, workspaceId);
  box.messages.push({ uid: 1, subject: "信用卡消费提醒", body: "您尾号 1234 的信用卡在 星巴克 消费人民币 35.00 元。" },
    { uid: 2, subject: "Order receipt", body: "Thanks for your order." });
  now = new Date("2026-10-19T09:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  const answer = JSON.stringify({ items: [
    { uid: 1, kind: "transaction", title: "", waitingId: "", why: "银行消费提醒", money: { event: "charge", amount: 35, amountLabel: "", currency: "CNY", merchant: "星巴克", category: "餐饮", occurredOn: "", refs: [], last4: "1234", instrument: "card" } },
    // The amount appears nowhere in this mail's text: it is not written, and the mail is only noted.
    { uid: 2, kind: "transaction", title: "", waitingId: "", why: "订单收据", money: { event: "receipt", amount: 88, amountLabel: "Total", currency: "USD", merchant: "Shop", category: "购物", occurredOn: "", refs: [], last4: "", instrument: "" } }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  expect(await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh)).toMatchObject({ state: "done", recorded: 1 });
  expect(store.listRecords(workspaceId).map((item) => [item.kind, item.value, item.currency, item.category, item.source, item.account])).toEqual([["expense", 35, "CNY", "餐饮", "mail", "card ••1234"]]);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["transaction", "info"]);
});

test("a booking confirmation places the person on future days only when its quote is in the mail (§17.6 c)", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-10-19T09:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  await readNewMail(deps, workspaceId);
  box.messages.push({ uid: 1, subject: "Booking confirmed", body: "Your stay is confirmed. Check-in: 20 Nov 2026, Hotel Lisboa, Lisbon. Check-out: 23 Nov 2026." },
    { uid: 2, subject: "Your flight", body: "Thanks for flying with us." });
  now = new Date("2026-10-19T09:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  const none = { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" };
  const answer = JSON.stringify({ items: [
    { uid: 1, kind: "travel", title: "里斯本", waitingId: "", why: "酒店预订", money: none,
      trip: { city: "Lisbon", country: "Portugal", from: "2026-11-20", to: "2026-11-23", quote: "Check-in: 20 Nov 2026, Hotel Lisboa, Lisbon." } },
    // Its quote is not in the mail: nothing is placed, and the mail is only noted.
    { uid: 2, kind: "travel", title: "柏林", waitingId: "", why: "航班", money: none,
      trip: { city: "Berlin", country: "Germany", from: "2026-11-25", to: "2026-11-25", quote: "Flight LH 431 to Berlin on 25 Nov" } }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  expect(await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh)).toMatchObject({ state: "done" });
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_TRIPS_SETTING)!)).toEqual([expect.objectContaining({ city: "Lisbon", from: "2026-11-20", to: "2026-11-23", source: "mail" })]);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["travel", "info"]);
});

test("an expired payment request is never booked; the same mail in a second mailbox is sorted once", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-10-28T00:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  await readNewMail(deps, workspaceId);
  box.messages.push({ uid: 1, subject: "Your $61.00 USD request expired", body: "The request you sent for $61.00 USD has expired." });
  now = new Date("2026-10-28T00:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  const answer = JSON.stringify({ items: [{ uid: 1, kind: "todo", title: "核实 PayPal 61 美元收款请求失效", waitingId: "", why: "收款请求过期",
    money: { event: "charge", amount: 61, amountLabel: "", currency: "USD", merchant: "PayPal", category: "", occurredOn: "", refs: [], last4: "", instrument: "paypal" } }] });
  const { rpc, turns } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  // The same message read again through another account: one model turn, one log line.
  const copy = fresh.map((message) => ({ ...message, accountId: "other", uid: 9 }));
  expect(await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, [...fresh, ...copy])).toMatchObject({ state: "done", recorded: 0, sorted: 1 });
  expect(store.listRecords(workspaceId)).toEqual([]);
  expect(turns()).toBe(1);
});

test("with bookkeeping switched off on an account, a payment mail is only noted, and nothing is written", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-10-19T09:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  const added = await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  if (!added.ok) throw new Error(added.code);
  expect(setMailBookkeeping(store, workspaceId, "no-such-account", false)).toBe(false);
  expect(setMailBookkeeping(store, workspaceId, added.account.id, false)).toBe(true);
  await readNewMail(deps, workspaceId);
  box.messages.push({ uid: 1, subject: "信用卡消费提醒", body: "您尾号 1234 的信用卡在 星巴克 消费人民币 35.00 元。" });
  now = new Date("2026-10-19T09:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  const answer = JSON.stringify({ items: [{ uid: 1, kind: "transaction", title: "", waitingId: "", why: "银行消费提醒", money: { event: "charge", amount: 35, amountLabel: "", currency: "CNY", merchant: "星巴克", category: "餐饮", occurredOn: "", refs: [], last4: "1234", instrument: "card" } }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  expect(await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh)).toMatchObject({ state: "done", recorded: 0 });
  expect(store.listRecords(workspaceId)).toEqual([]);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["info"]);
  // Back on, the next such mail is written again.
  expect(setMailBookkeeping(store, workspaceId, added.account.id, true)).toBe(true);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_ACCOUNTS_SETTING)!)[0]).toMatchObject({ triage: true, bookkeeping: true });
});

test("the assistant searches every connected account through one lookup", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  expect(mailLookupFor({ store, secrets, resolve, factory: box.factory }, workspaceId)).toBeUndefined();
  await addMailAccount({ store, secrets, resolve, factory: box.factory }, workspaceId, { address: "me@163.com", password: "app-pass" });
  box.messages.push({ uid: 5, subject: "Lab meeting moved", body: "Now 15:00." });
  const hits = await mailLookupFor({ store, secrets, resolve, factory: box.factory }, workspaceId)!.search({ text: "Lab" });
  expect(hits[0]).toMatchObject({ subject: "Lab meeting moved", snippet: "Now 15:00." });
  expect(hits[0]!.id).toMatch(/^[a-z0-9-]+:5$/);
});

test("connecting sorts at once; mail read while sorting was off is kept and sorted the moment sorting is switched on", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  box.messages.push({ uid: 1, subject: "HW1 extended to Oct 30", body: "Please submit by Oct 30." });
  let now = new Date("2026-10-19T09:00:00Z");
  const answer = JSON.stringify({ items: [{ uid: 1, kind: "todo", title: "10/30 前交 HW1", waitingId: "", why: "老师通知延期", money: { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" } }] });
  const { rpc, turns } = fakeRuntime([answer, answer], MAIL_TRIAGE_SKILL);
  const captured: string[] = [];
  const service = createMailService({ store, secrets, resolve, factory: box.factory, now: () => now, cwd: "/repo", client: () => rpc,
    sortAllowed: async () => true, onCaptured: (id) => { captured.push(id); } });
  // Connecting runs a pass at once (not at the next quarter hour), and its to-do reaches the inbox and wakes the analysis.
  const added = await service.handle("POST", "/v1/mail/accounts", workspaceId, { address: "me@qq.com", password: "app-pass" });
  expect(added?.status).toBe(200);
  await vi.waitFor(() => expect(store.listCaptures(workspaceId)).toHaveLength(1));
  expect(captured).toEqual([workspaceId]);
  const id = JSON.parse(store.getSetting(workspaceId, MAIL_ACCOUNTS_SETTING)!)[0].id as string;

  // Sorting off: new mail is still read (the automations listen), no model runs, and the mail waits.
  await service.handle("POST", `/v1/mail/accounts/${id}/triage`, workspaceId, { on: false });
  box.messages.push({ uid: 2, subject: "Lab meeting moved", body: "Now 15:00." });
  now = new Date("2026-10-19T09:20:00Z");
  expect(await service.pass(workspaceId)).toMatchObject({ read: 1 });
  expect(turns()).toBe(1);
  expect(JSON.parse(store.getSetting(workspaceId, "mail.unsorted")!).map((m: { subject: string }) => m.subject)).toEqual(["Lab meeting moved"]);

  // Switched back on: what waited is sorted right away.
  await service.handle("POST", `/v1/mail/accounts/${id}/triage`, workspaceId, { on: true });
  await vi.waitFor(() => expect(turns()).toBe(2));
  await vi.waitFor(() => expect(store.getSetting(workspaceId, "mail.unsorted")).toBe("[]"));
});

test("a company's survey invitation is a promotion, not a todo: the Skill and the runner both say so (W-147)", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const skill = readFileSync(path.resolve(import.meta.dirname, "../../../skills/marketplace/plugins/crossline/skills/crossline-mail-triage/SKILL.md"), "utf8");
  // On the real account 「Help shape the future of Codex」 became the task 「填写 Codex 使用体验问卷」 on 10-28.
  expect(skill).toMatch(/Help shape the future of <product>.*\| ignore \|/);
  expect(skill).toMatch(/Course staff.*feedback survey.*\| todo \|/);
  const source = readFileSync(path.resolve(import.meta.dirname, "mailbox.ts"), "utf8");
  expect(source).toContain("a company's survey or feedback invitation");
});

test("the reply queue: a refusal is tried once more then dropped, a passing trouble and the day's limit stay queued, keyed per mailbox", () => {
  const item = (uid: number, accountId = "a1", failures?: number) => ({ uid, accountId, uidValidity: "7", from: "x", fromAddress: "x@y.z", to: "", subject: "s", date: "2026-10-19T08:00:00Z",
    snippet: "", why: "", ...(failures ? { failures } : {}) });
  const skip = (candidate: Parameters<typeof replyKey>[0], reason: string) => ({ key: replyKey(candidate), reason });
  const refused = item(1);
  const once = requeueReplies([refused], [skip(refused, "MAIL_REPLY_DRAFT_INVALID")]);
  expect(once).toEqual([{ ...refused, failures: 1 }]);
  expect(requeueReplies(once, [skip(once[0]!, "SKILL_SCHEMA_INVALID")])).toEqual([]);
  // Passing troubles and the sixth mail of a day are carried over without counting.
  for (const reason of ["quota", "SKILL_USAGE_LIMIT", "SKILL_STALLED", "CODEX_RUNTIME_EXITED", "daily_limit"]) {
    expect(requeueReplies([item(2, "a1", 1)], [skip(item(2), reason)])).toEqual([item(2, "a1", 1)]);
  }
  expect(requeueReplies([item(3)], [skip(item(3), "already")])).toEqual([]);
  // The same uid in another mailbox is another message: a skip for one says nothing about the other.
  expect(requeueReplies([item(4, "a1"), item(4, "a2")], [skip(item(4, "a2"), "quota")])).toEqual([item(4, "a2")]);
});

test("an event in the mail is asked about, never planned: personal and relevant ones become cards, a mass notice waits for the weekly review", async () => {
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-11-10T09:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  await readNewMail(deps, workspaceId);
  box.messages.push({ uid: 1, subject: "Meeting next week", body: "Can we meet on Tuesday, Nov 17 at 2pm in my office?" },
    { uid: 2, subject: "Graduate coffee hour", body: "Join the department coffee hour on Friday Nov 13, 3-4pm." },
    { uid: 3, subject: "Seminar: Robust control", body: "Talk on Thursday Nov 12 at 4pm, room 1610." },
    { uid: 4, subject: "Info session", body: "Info session next week." });
  now = new Date("2026-11-10T09:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  const empty = { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" };
  const meet = (date: string, start: string, end: string, relevance: number, personal: boolean, quote: string) => ({ date, start, end, location: "", lineId: "", relevance, personal, quote });
  const answer = JSON.stringify({ items: [
    { uid: 1, kind: "event", title: "与 Lin 老师见面", waitingId: "", why: "导师约见", money: empty, meet: meet("2026-11-17", "14:00", "", 40, true, "Can we meet on Tuesday, Nov 17 at 2pm") },
    { uid: 2, kind: "event", title: "Graduate coffee hour", waitingId: "", why: "群发活动", money: empty, meet: meet("2026-11-13", "15:00", "16:00", 10, false, "coffee hour on Friday Nov 13, 3-4pm") },
    { uid: 3, kind: "event", title: "Robust control seminar", waitingId: "", why: "相关讲座", money: empty, meet: meet("2026-11-12", "16:00", "17:00", 80, false, "Talk on Thursday Nov 12 at 4pm") },
    // No day in the mail: the model's date is not taken, and the mail is only information.
    { uid: 4, kind: "event", title: "Info session", waitingId: "", why: "说明会", money: empty, meet: meet("2026-11-18", "10:00", "11:00", 70, false, "Info session on Nov 18") }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  expect(await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh)).toMatchObject({ state: "done", captured: 0, events: 3 });
  // Nothing became a task: going is the person's decision.
  expect(store.listCaptures(workspaceId)).toEqual([]);
  const events = readMailEvents(store.getSetting(workspaceId, MAIL_EVENTS_SETTING));
  expect(mailEventAsks(events, "2026-11-10").map((event) => [event.title, event.personal, event.end])).toEqual([["与 Lin 老师见面", true, "15:00"], ["Robust control seminar", false, "17:00"]]);
  expect(mailEventDigest(events, "2026-11-10", "2026-11-17").map((event) => event.title)).toEqual(["Graduate coffee hour"]);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["event", "event", "event", "info"]);
});

test("a mail sorted as a to-do that is only going to something is never a task (2026-11-11, W-256)", async () => {
  // The owner's plan held nine 「参加…讲座 / 排练 / 论坛」 tasks from mail as overdue, and 「参加 ECE 548 期中考试 2」 as a movable half hour
  // with 「可用时段内没有空位」: each had been sorted as a to-do, captured and analysed into work.
  const { store, workspaceId, secrets, resolve } = setup();
  const box = mailbox();
  let now = new Date("2026-11-10T09:00:00Z");
  const deps = { store, secrets, resolve, factory: box.factory, now: () => now };
  await addMailAccount(deps, workspaceId, { address: "me@qq.com", password: "app-pass" });
  await readNewMail(deps, workspaceId);
  box.messages.push({ uid: 1, subject: "ECE 548 Midterm-2", body: "Midterm-2 is on Tuesday, Nov 24, 12:45-13:15 in EH 2540." },
    { uid: 2, subject: "Robust control seminar", body: "Please join the seminar next week." },
    { uid: 3, subject: "Quiz 4 next Friday", body: "Review sequential circuits; Quiz 4 is on Friday Nov 13 in class." });
  now = new Date("2026-11-10T09:20:00Z");
  const fresh = await readNewMail(deps, workspaceId);
  const empty = { event: "", amount: 0, amountLabel: "", currency: "", merchant: "", category: "", occurredOn: "", refs: [], last4: "", instrument: "" };
  const none = { date: "", start: "", end: "", location: "", lineId: "", relevance: 0, personal: false, quote: "" };
  const answer = JSON.stringify({ items: [
    { uid: 1, kind: "todo", title: "参加 ECE 548 期中考试 2", waitingId: "", why: "考试", money: empty,
      meet: { date: "2026-11-24", start: "12:45", end: "13:15", location: "EH 2540", lineId: "", relevance: 90, personal: true, quote: "Midterm-2 is on Tuesday, Nov 24, 12:45-13:15" } },
    { uid: 2, kind: "todo", title: "参加 Robust control seminar", waitingId: "", why: "讲座", money: empty, meet: none },
    // Preparing for something is work; only going to it is not.
    { uid: 3, kind: "todo", title: "复习时序电路，11 月 13 日小测", waitingId: "", why: "小测", money: empty, meet: none }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  expect(await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh)).toMatchObject({ state: "done", captured: 1, events: 1 });
  expect(store.listCaptures(workspaceId).map((capture) => capture.title)).toEqual(["复习时序电路，11 月 13 日小测"]);
  expect(mailEventAsks(readMailEvents(store.getSetting(workspaceId, MAIL_EVENTS_SETTING)), "2026-11-10").map((event) => [event.title, event.date, event.start]))
    .toEqual([["参加 ECE 548 期中考试 2", "2026-11-24", "12:45"]]);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["event", "info", "todo"]);
});
