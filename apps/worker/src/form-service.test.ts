import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIXED_EVENTS, MAIL_ACCOUNTS_SETTING, type FixedEvent, type FormFillAnswer, type Opportunity } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";
import { CrosslineStore, applicationProfile, formRunOf, readFormRuns } from "@crossline/db";
import { openFormBrowser } from "./form-browser";
import { createFormService } from "./form-service";
import { findBrowser } from "./node/browser";

const chrome = findBrowser();
let server: Server;
let base = "";
let submitted = 0;
beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (request.url === "/done") { submitted += 1; return response.end(`<h1>You're registered!</h1>`); }
      response.end(`<h1>AI Night</h1><form method="post" action="/done"><label>Email <input name="email"></label><button type="submit">Register</button></form>`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let store: CrosslineStore;
let ws = "";
let dir = "";
const secrets = new Map<string, string>();
const secretStore: SecretStore = { read: async (w, name) => secrets.get(`${w}/${name}`), write: async (w, name, value) => { secrets.set(`${w}/${name}`, value); }, remove: (w, name) => { secrets.delete(`${w}/${name}`); } };
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  dir = mkdtempSync(path.join(tmpdir(), "crossline-forms-"));
  secrets.clear();
  submitted = 0;
});

const opportunity = (): Opportunity => ({ id: "opp-9", key: "k", lineId: "startup", kind: "event", title: "AI Night", organizer: "Madison AI", url: `${base}/event`,
  registrationHost: "127.0.0.1", deadlines: [], startsAt: { day: "2026-11-12", quote: "Thursday 6:00 PM" }, cost: { amount: 0, currency: "USD", quote: "Free" },
  eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z" } as Opportunity);
const service = (owner = () => ws as string | undefined) => createFormService({ store, secrets: secretStore, cwd: dir, dataDir: dir, client: () => undefined, owner, screen: true,
  profilesRoot: () => path.join(dir, "profiles"), executable: () => chrome,
  open: (options) => openFormBrowser({ ...options, headless: true, allow: async () => true }),
  models: () => ({
    propose: async (): Promise<FormFillAnswer> => ({ pageKind: "form", note: "", actions: [
      { op: "fill", target: { role: "textbox", name: "Email" }, value: { slot: "email" }, why: "" },
      { op: "submit", target: { role: "button", name: "Register" }, value: null, why: "" }] }),
    check: async () => ({ ok: true, problems: [] })
  }) });
const waitFor = async (done: () => boolean, ms = 60_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 200)); };

describe("form service", () => {
  it("serves only the machine owner", async () => {
    const forms = service(() => "someone-else");
    expect(await forms.handle("GET", "/v1/forms", ws, undefined)).toMatchObject({ status: 403 });
    expect(await forms.handle("POST", "/v1/apply-profile/phone", ws, { value: "+1 608 555 0123" })).toMatchObject({ status: 403 });
  });

  it("keeps a sensitive item in the secret store only, and a plain one as a confirmed fact", async () => {
    const forms = service();
    expect(await forms.handle("POST", "/v1/apply-profile/phone", ws, { value: "+1 608 555 0123" })).toMatchObject({ status: 200 });
    expect(await forms.handle("POST", "/v1/apply-profile/email", ws, { value: "kai@example.edu" })).toMatchObject({ status: 200 });
    expect(await forms.handle("POST", "/v1/apply-profile/email", ws, { value: "not an email" })).toMatchObject({ status: 400 });
    expect(secrets.get(`${ws}/apply-phone`)).toBe("+1 608 555 0123");
    const ledger = JSON.stringify(store.exportSnapshot(ws));
    expect(ledger).not.toContain("555 0123");
    expect(ledger).toContain("kai@example.edu");
    const items = Object.fromEntries(applicationProfile(store, ws).map((item) => [item.slot, item]));
    expect(items.phone).toMatchObject({ present: true, sensitive: true });
    expect(items.phone!.value).toBeUndefined();
    expect(await forms.handle("DELETE", "/v1/apply-profile/phone", ws, undefined)).toMatchObject({ status: 200 });
    expect(secrets.has(`${ws}/apply-phone`)).toBe(false);
  });

  it.skipIf(!chrome)("fills a queued free event, and without a mailbox the confirmation page confirms it onto the calendar", async () => {
    const forms = service();
    await forms.handle("POST", "/v1/apply-profile/email", ws, { value: "kai@example.edu" });
    const queued = await forms.handle("POST", "/v1/forms/queue", ws, { opportunity: opportunity(), choice: "register" });
    expect(queued?.status).toBe(200);
    await waitFor(() => readFormRuns(store, ws)[0]?.state === "confirmed");
    const run = readFormRuns(store, ws)[0]!;
    expect(run.state).toBe("confirmed");
    expect(submitted).toBe(1);
    const events = JSON.parse(store.getSetting(ws, FIXED_EVENTS) ?? "[]") as FixedEvent[];
    expect(events).toEqual([expect.objectContaining({ id: "opportunity-opp-9", date: "2026-11-12", start: "18:00", end: "20:00", source: "input" })]);
    await forms.closeAll();
  }, 120_000);

  it.skipIf(!chrome)("with a mailbox, waits for the same-domain confirmation mail and ignores mail from elsewhere", async () => {
    store.setSetting(ws, MAIL_ACCOUNTS_SETTING, JSON.stringify([{ id: "m1", address: "kai@example.edu", label: "", host: "imap.example.edu", port: 993, triage: true, addedAt: "" }]));
    const forms = service();
    await forms.handle("POST", "/v1/apply-profile/email", ws, { value: "kai@example.edu" });
    await forms.handle("POST", "/v1/forms/queue", ws, { opportunity: opportunity(), choice: "register" });
    await waitFor(() => readFormRuns(store, ws)[0]?.state === "submitted");
    const id = readFormRuns(store, ws)[0]!.id;
    expect(formRunOf(store, ws, id)?.state).toBe("submitted");
    forms.onNewMail(ws, [{ from: "x", fromAddress: "noreply@evil.example", subject: "Registration confirmed: AI Night", snippet: "", date: "" }]);
    expect(formRunOf(store, ws, id)?.state).toBe("submitted");
    forms.onNewMail(ws, [{ from: "x", fromAddress: "events@127.0.0.1", subject: "You're registered for AI Night", snippet: "", date: "2026-11-01" }]);
    expect(formRunOf(store, ws, id)).toMatchObject({ state: "confirmed", confirmation: { mail: { from: "events@127.0.0.1" } } });
    await forms.closeAll();
  }, 120_000);

  it("refuses an opportunity page that is not on its registration host", async () => {
    const forms = service();
    await forms.handle("POST", "/v1/forms/queue", ws, { opportunity: { ...opportunity(), url: "https://lu.ma/x" }, choice: "register" });
    await waitFor(() => readFormRuns(store, ws)[0]?.state === "stopped", 5_000);
    expect(readFormRuns(store, ws)[0]).toMatchObject({ state: "stopped", stoppedFor: "not_allowed" });
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
});
