import { expect, test } from "vitest";
import { createImapMail, hostAllowed, presetFor, unsupportedProvider, type ImapFactory } from "./imap-mail";

const raw = (subject: string, body: string, from = "Prof Lin <lin@uni.edu>") => Buffer.from(
  `From: ${from}\r\nTo: me@gmail.com\r\nSubject: ${subject}\r\nDate: Sun, 18 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);

/** A mailbox of three messages; records how it was opened and every search. */
function server(options: { failLogin?: boolean } = {}) {
  const log = { opened: [] as Array<{ path: string; readOnly: boolean | undefined }>, searches: [] as unknown[], loggedOut: 0, flagsChanged: 0 };
  const messages = [
    { uid: 7, subject: "Lab meeting moved", body: "Monday lab meeting is now 15:00." },
    { uid: 8, subject: "HW1 extended", body: "HW1 is now due Oct 30." },
    { uid: 9, subject: "Newsletter", body: "Weekly digest." }
  ];
  const message = (m: (typeof messages)[number]) => ({ seq: m.uid, uid: m.uid, envelope: { subject: m.subject, from: [{ name: "Prof Lin", address: "Lin@uni.edu" }],
    to: [{ address: "me@gmail.com" }], date: new Date("2026-10-18T10:00:00Z") }, source: raw(m.subject, m.body) });
  const factory: ImapFactory = () => ({
    connect: async () => { if (options.failLogin) throw Object.assign(new Error("Command failed"), { responseText: "AUTHENTICATIONFAILED Invalid credentials" }); },
    logout: async () => { log.loggedOut += 1; },
    mailboxOpen: async (path: string | string[], open?: { readOnly?: boolean }) => { log.opened.push({ path: String(path), readOnly: open?.readOnly }); return { uidValidity: 42n, uidNext: 10 } as never; },
    search: (async (query: { uid?: string; since?: Date; or?: unknown }) => {
      log.searches.push(query);
      if (query.uid) { const from = Number(query.uid.split(":")[0]); return messages.filter((m) => m.uid >= from).map((m) => m.uid).concat(from > 9 ? [9] : []); }
      return messages.map((m) => m.uid);
    }) as never,
    fetchAll: (async (uids: number[]) => messages.filter((m) => uids.includes(m.uid)).map(message)) as never,
    fetchOne: (async (uid: string) => { const m = messages.find((item) => item.uid === Number(uid)); return m ? message(m) : false; }) as never
  });
  return { factory, log };
}

test("the inbox is opened read-only, new mail since the last number is read with its opening lines, and the connection is closed", async () => {
  const { factory, log } = server();
  const mail = createImapMail({ host: "imap.gmail.com", port: 993, secure: true }, "me@gmail.com", "app-password", factory);
  const first = await mail.newSince({});
  expect(first).toMatchObject({ uidValidity: "42", lastUid: 9 });
  expect(first.messages.map((m) => m.subject)).toEqual(["Lab meeting moved", "HW1 extended", "Newsletter"]);
  expect(first.messages[1]).toMatchObject({ fromAddress: "lin@uni.edu", snippet: "HW1 is now due Oct 30." });
  // Nothing newer: the IMAP quirk that `10:*` returns the last message is not taken for new mail.
  expect((await mail.newSince({ uidValidity: "42", lastUid: 9 })).messages).toEqual([]);
  expect((await mail.newSince({ uidValidity: "42", lastUid: 7 })).messages.map((m) => m.uid)).toEqual([8, 9]);
  expect(log.opened.every((open) => open.path === "INBOX" && open.readOnly === true)).toBe(true);
  expect(log.loggedOut).toBe(log.opened.length);
});

test("a message is read in full, and a search looks in subject and text", async () => {
  const { factory, log } = server();
  const mail = createImapMail({ host: "imap.qq.com", port: 993, secure: true }, "me@qq.com", "code", factory);
  expect((await mail.read(8))?.text).toBe("HW1 is now due Oct 30.");
  expect(await mail.read(99)).toBeUndefined();
  await mail.search({ text: "HW1", sinceDays: 7 });
  expect(log.searches.at(-1)).toMatchObject({ or: [{ subject: "HW1" }, { text: "HW1" }] });
});

test("a refused login is said in words; presets and unsupported providers are known; a host must be a mail server name", async () => {
  const mail = createImapMail({ host: "imap.163.com", port: 993, secure: true }, "me@163.com", "wrong", server({ failLogin: true }).factory);
  expect(await mail.check()).toMatchObject({ ok: false, code: "MAIL_AUTH_FAILED" });
  expect(presetFor("Me@QQ.com")).toMatchObject({ host: "imap.qq.com" });
  expect(unsupportedProvider("me@outlook.com")).toMatch(/OAuth/);
  expect(unsupportedProvider("me@gmail.com")).toBeUndefined();
  expect(hostAllowed("imap.example.org")).toBe(true);
  expect(hostAllowed("127.0.0.1")).toBe(false);
  expect(hostAllowed("mail.local")).toBe(false);
  expect(hostAllowed("localhost")).toBe(false);
});
