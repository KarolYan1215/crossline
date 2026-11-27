import { beforeEach, expect, test } from "vitest";
import type { Opportunity } from "@crossline/core";
import { CrosslineStore, queueFormRun, saveFormRun } from "@crossline/db";
import type { NodeRemoteLink } from "./node/hub";
import { REMOTE_NOTIFY_SETTING, createRemoteService } from "./remote-service";

let store: CrosslineStore;
let ws = "";
let links: NodeRemoteLink[] = [];
let pushes: Array<{ title: string; tag: string }> = [];
let calls: Array<Record<string, unknown>> = [];
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  links = []; pushes = []; calls = [];
});
const link = (host: string, answer: (request: Record<string, unknown>) => unknown = () => ({ ok: true })): NodeRemoteLink => ({
  key: host, host, role: "device", level: "remote", phones: 1, folders: true, transcribe: false, forms: true,
  call: async (request) => { calls.push(request); return answer(request); }
});
const service = () => createRemoteService({ store, hub: () => ({ remoteFor: () => links } as never),
  push: async (_ws, message) => { pushes.push(message); return true; } });
const signed = (envelope: Record<string, unknown>) => ({ signed: { key: "phone-1", sig: "x", body: JSON.stringify({ v: 1, nonce: "n1", issuedAt: "", expiresAt: "", ...envelope }) } });
const opportunity = (id: string, amount: number): Opportunity => ({ id, key: id, lineId: "startup", kind: "event", title: id, organizer: "x", url: "https://lu.ma/x",
  registrationHost: "lu.ma", deadlines: [], startsAt: { day: "2026-11-30", quote: "" }, cost: { amount, currency: "USD", quote: "" },
  eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z" } as Opportunity);

test("an instruction to an offline computer is refused, never queued; one to the online computer is carried as signed", async () => {
  const remote = service();
  expect((await remote.handle("POST", "/v1/remote/send", ws, signed({ kind: "session.start", computer: "PC-A", payload: {} })))?.body).toEqual({ ok: false, code: "REMOTE_OFFLINE" });
  links = [link("PC-A", () => ({ ok: true, folder: "x" }))];
  const sent = signed({ kind: "session.start", computer: "PC-A", payload: {} });
  expect((await remote.handle("POST", "/v1/remote/send", ws, sent))?.body).toEqual({ ok: true, folder: "x" });
  expect(calls).toEqual([{ op: "signed", signed: sent.signed }]);
  // Another computer's name in the envelope never reaches this one.
  expect((await remote.handle("POST", "/v1/remote/send", ws, signed({ kind: "session.start", computer: "PC-B", payload: {} })))?.body).toEqual({ ok: false, code: "REMOTE_OFFLINE" });
  expect((await remote.handle("POST", "/v1/remote/send", ws, signed({ kind: "rm -rf", computer: "PC-A" })))?.body).toMatchObject({ code: "REMOTE_SIGNATURE_INVALID" });
  expect(calls).toHaveLength(1);
});

test("a paid form is refused before it reaches the computer; a free one ready to submit goes through", async () => {
  links = [link("PC-A")];
  const paid = queueFormRun(store, ws, { opportunity: opportunity("paid", 20), choice: "register" });
  const free = queueFormRun(store, ws, { opportunity: opportunity("free", 0), choice: "register" });
  saveFormRun(store, ws, { ...paid, state: "ready_to_submit" });
  saveFormRun(store, ws, { ...free, state: "ready_to_submit" });
  const remote = service();
  expect((await remote.handle("POST", "/v1/remote/forms", ws, {}))?.body).toMatchObject({ forms: expect.arrayContaining([expect.objectContaining({ id: paid.id, free: false }), expect.objectContaining({ id: free.id, free: true })]) });
  expect((await remote.handle("POST", "/v1/remote/send", ws, signed({ kind: "form.submit", computer: "PC-A", payload: { run: paid.id } })))?.body).toMatchObject({ code: "REMOTE_FORM_REFUSED" });
  expect(calls).toHaveLength(0);
  expect((await remote.handle("POST", "/v1/remote/send", ws, signed({ kind: "form.submit", computer: "PC-A", payload: { run: free.id } })))?.body).toEqual({ ok: true });
});

test("reports become the record and the live view; only a waiting command is pushed; 「核对」 reads this computer's instructions", async () => {
  const remote = service();
  links = [link("PC-A")];
  remote.onEvent(ws, "PC-A", { type: "session.started", session: "s1", folder: "C:\\tasks\\remote-s1", approval: "each", endsAt: "", nonce: "n1" });
  remote.onEvent(ws, "PC-A", { type: "delta", session: "s1", text: "hel" });
  remote.onEvent(ws, "PC-A", { type: "approval.asked", session: "s1", approval: "a1", subject: "Remove-Item x" });
  remote.onEvent(ws, "PC-B", { type: "message.person", session: "s2", text: "hi", nonce: "n9" });
  expect(pushes).toEqual([expect.objectContaining({ tag: "remote-approval-a1" })]);
  const state = (await remote.handle("POST", "/v1/remote/state", ws, { host: "PC-A" }))?.body as { live: { session: { id: string }; draft: string; pending: unknown[] }; events: Array<{ type: string }> };
  expect(state.live).toMatchObject({ session: { id: "s1" }, draft: "hel", pending: [expect.objectContaining({ approval: "a1" })] });
  expect(state.events.map((event) => event.type)).toEqual(["session.started", "approval.asked"]);
  expect(remote.ledgerFor(ws, "PC-A")).toEqual([expect.objectContaining({ type: "remote.changed", nonce: "n1", session: "s1" })]);
});

test("「电脑上线时通知我」 is told once when the computer comes back", async () => {
  const remote = service();
  await remote.handle("POST", "/v1/remote/notify", ws, { on: true });
  expect(store.getSetting(ws, REMOTE_NOTIFY_SETTING)).toBe("on");
  remote.onChange(ws, "PC-A", true);
  remote.onChange(ws, "PC-A", true);
  expect(pushes.map((push) => push.tag)).toEqual(["remote-online"]);
  expect(store.getSetting(ws, REMOTE_NOTIFY_SETTING)).toBe("off");
});
