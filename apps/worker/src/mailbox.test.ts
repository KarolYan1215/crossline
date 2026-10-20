import { expect, test } from "vitest";
import { MAIL_ACCOUNTS_SETTING, MAIL_LOG_SETTING } from "@crossline/core";
import type { ImapFactory, SecretStore } from "@crossline/connectors";
import { CrosslineStore } from "@crossline/db";
import { addMailAccount, MAIL_TRIAGE_SKILL, mailLookupFor, readNewMail, removeMailAccount, triageMail } from "./mailbox";
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
    { uid: 1, kind: "todo", title: "10/30 前交 HW1（截止延后）", waitingId: "", why: "老师通知延期" },
    { uid: 2, kind: "reply", title: "", waitingId: "wait-data", why: "等的数据到了" },
    { uid: 3, kind: "ignore", title: "", waitingId: "", why: "简报" }] });
  const { rpc } = fakeRuntime([answer], MAIL_TRIAGE_SKILL);
  const done = await triageMail({ ...deps, client: rpc, cwd: "/repo" }, workspaceId, fresh);
  expect(done).toEqual({ state: "done", captured: 1, replies: 1, sorted: 3, needsReply: [] });
  expect(store.listCaptures(workspaceId)[0]).toMatchObject({ title: "10/30 前交 HW1（截止延后）" });
  expect(store.listCaptures(workspaceId)[0]!.context).toContain("HW1 extended to Oct 30");
  expect(store.listEvents(workspaceId, { type: "waiting.mail_seen", entityId: "wait-data" })).toHaveLength(1);
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_LOG_SETTING)!).map((entry: { kind: string }) => entry.kind)).toEqual(["todo", "reply", "ignore"]);
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
